'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point HOME at a throwaway folder before loading the server, so tests never touch the real ~/.ctrlpi.
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bay-test-'));
process.env.HOME = testHome;
test.after(() => fs.rmSync(testHome, { recursive: true, force: true }));
const { server, hostAllowed, _test } = require('../server');

function request(baseUrl, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(url, options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body,
          json: () => JSON.parse(body)
        });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test('HTTP server endpoints and local functionality', async t => {
  let baseUrl;

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
    server.once('error', reject);
  });

  t.after(() => {
    return new Promise(resolve => server.close(resolve));
  });

  await t.test('answers only requests addressed to an allowed host (DNS rebinding)', async () => {
    const foreign = await request(baseUrl, '/api/devices', { headers: { Host: 'attacker.example:8383' } });
    assert.equal(foreign.status, 403);
    assert.match(foreign.json().error, /Host not allowed: attacker\.example\. .*--allow-host attacker\.example/);
    const local = await request(baseUrl, '/', { headers: { Host: 'localhost:8383' } });
    assert.equal(local.status, 200);
  });

  await t.test('localIPv4 returns an active interface and its address', async () => {
    const local = await _test.localIPv4();
    if (!local) return;  // no network on this machine
    const list = os.networkInterfaces()[local.interface] || [];
    assert.ok(list.some(a => a.family === 'IPv4' && !a.internal && a.address === local.address), JSON.stringify(local));
  });

  await t.test('hostAllowed accepts IPs, localhost, the machine name and --allow-host names', () => {
    for (const host of ['127.0.0.1:8383', '192.168.1.20', '[::1]:8383', 'localhost:8383', 'labmac', 'LabMac.local:8383', 'pi4.lan'])
      assert.equal(hostAllowed(host, ['pi4.lan'], 'labmac.local'), true, host);
    for (const host of ['attacker.example', 'labmac.evil.com', '', 'pi4.lan:x'])
      assert.equal(hostAllowed(host, ['pi4.lan'], 'labmac.local'), false, host);
  });

  await t.test('serves the ctrlPi favicon', async () => {
    const res = await request(baseUrl, '/favicon.ico');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/x-icon');
  });

  await t.test('serves page.html at root', async () => {
    const res = await request(baseUrl, '/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /<title>Pi Bay<\/title>/);
    assert.match(res.body, /id="pills"/);
    assert.match(res.body, /id="themeToggleBtn"/);
    assert.match(res.body, /id="menu-btn"/);
  });

  await t.test('serves vendor assets', async () => {
    const css = await request(baseUrl, '/vendor/xterm.css');
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'], /text\/css/);

    const js = await request(baseUrl, '/vendor/xterm.js');
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /text\/javascript/);
  });

  await t.test('serves README markdown and json formats', async () => {
    const mdRes = await request(baseUrl, '/api/readme');
    assert.equal(mdRes.status, 200);
    assert.match(mdRes.headers['content-type'], /text\/markdown/);
    assert.match(mdRes.body, /# Pi Bay/);

    const jsonRes = await request(baseUrl, '/api/readme', {
      headers: { Accept: 'application/json' }
    });
    assert.equal(jsonRes.status, 200);
    assert.match(jsonRes.headers['content-type'], /application\/json/);
    const data = jsonRes.json();
    assert.ok(data.text);
    assert.match(data.text, /# Pi Bay/);
  });

  await t.test('protects authenticated endpoints without session token', async () => {
    const files = await request(baseUrl, '/api/files');
    assert.equal(files.status, 401);
    assert.equal(files.json().error, 'Not connected');

    const file = await request(baseUrl, '/api/file?path=test.txt');
    assert.equal(file.status, 401);
    assert.equal(file.json().error, 'Not connected');

    const zip = await request(baseUrl, '/api/zip');
    assert.equal(zip.status, 401);
    assert.equal(zip.json().error, 'Not connected');

    const restore = await request(baseUrl, '/api/restore', { method: 'POST', body: 'PK' });
    assert.equal(restore.status, 401);
    assert.equal(restore.json().error, 'Not connected');

    const upload = await request(baseUrl, '/api/file?path=a.txt', { method: 'PUT', body: 'hello' });
    assert.equal(upload.status, 401);
    assert.equal(upload.json().error, 'Not connected');
  });

  await t.test('rejects cross-origin restore', async () => {
    const res = await request(baseUrl, '/api/restore', { method: 'POST', headers: { Origin: 'http://malicious-site.com' }, body: 'PK' });
    assert.equal(res.status, 403);
  });

  await t.test('page includes the install popup, restore, and drag-and-drop hooks', async () => {
    const res = await request(baseUrl, '/');
    assert.equal(res.status, 200);
    for (const marker of ['id="ctrlpiForm"', 'id="menu-restore"', 'id="move-menu"', 'id="format-json"', 'id="run"', "addEventListener('drop'"]) {
      assert.ok(res.body.includes(marker), marker);
    }
  });

  await t.test('rejects cross-origin mutations', async () => {
    const res = await request(baseUrl, '/api/connect', {
      method: 'POST',
      headers: {
        Origin: 'http://malicious-site.com',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ host: '127.0.0.1' })
    });
    assert.equal(res.status, 403);
    assert.equal(res.json().error, 'Cross-origin request rejected');
  });

  await t.test('returns 404 for unknown endpoints', async () => {
    const res = await request(baseUrl, '/does-not-exist');
    assert.equal(res.status, 404);
  });
});

test('savedDevice and decorateDevice isolation across IP reassignments', () => {
  const { savedDevice, decorateDevice } = _test;

  const cfg = {
    devices: {
      'old-esp': {
        host: '192.168.68.110',
        mac: '24:0a:c4:11:22:33',
        model: 'Generic ESP32 module with ESP32'
      }
    }
  };

  // 1. A new device with SSH on the same IP must NOT inherit the ESP32 model
  const sshDevice = { host: '192.168.68.110', mac: 'ba:fb:b3:00:a6:0c', ssh: true, pi: true };
  const found = savedDevice(cfg, sshDevice);
  assert.deepEqual(found.value, {});

  // 2. A device with a conflicting MAC on the same IP must NOT match the old device
  const differentMacDevice = { host: '192.168.68.110', mac: 'd8:3a:dd:fe:7e:0a', ssh: false, pi: false };
  assert.deepEqual(savedDevice(cfg, differentMacDevice).value, {});

  // 3. decorateDevice must sanitize any stale microcontroller model from an SSH or Pi device
  const cfgWithTaintedPi = {
    devices: {
      'ba:fb:b3:00:a6:0c': {
        host: '192.168.68.110',
        mac: 'ba:fb:b3:00:a6:0c',
        model: 'Generic ESP32 module with ESP32'
      }
    }
  };
  const decorated = decorateDevice(sshDevice, cfgWithTaintedPi);
  assert.equal(decorated.model, null);
  // Stale model should also be cleaned up from config
  assert.equal(cfgWithTaintedPi.devices['ba:fb:b3:00:a6:0c'].model, undefined);
});

