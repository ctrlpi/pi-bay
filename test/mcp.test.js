'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Point HOME at a throwaway folder before loading the server, so tests never touch the real ~/.ctrlpi.
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bay-test-'));
process.env.HOME = testHome;
const {
  server,
  dispatchMcp,
  setMcpHttp,
  MCP_TOOLS,
  resolveDevice,
  mcpSessions,
  _test
} = require('../server');

test.after(() => fs.rmSync(testHome, { recursive: true, force: true }));

const modernMeta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {}
};

test('MCP protocol methods', async t => {
  await t.test('supports modern discovery and complete result envelope', async () => {
    const discover = await dispatchMcp({
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: { _meta: modernMeta }
    });
    assert.equal(discover.jsonrpc, '2.0');
    assert.equal(discover.id, 1);
    assert.deepEqual(discover.result.supportedVersions, ['2026-07-28']);
    assert.equal(discover.result.resultType, 'complete');
    assert.equal(discover.result.capabilities.tools.listChanged, false);
    assert.equal(discover.result._meta['io.modelcontextprotocol/serverInfo'].name, 'pi-bay');
  });

  await t.test('supports legacy initialization', async () => {
    const init = await dispatchMcp({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' }
    });
    assert.equal(init.jsonrpc, '2.0');
    assert.equal(init.id, 2);
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.equal(init.result.serverInfo.name, 'pi-bay');
  });

  await t.test('supports ping', async () => {
    const ping = await dispatchMcp({
      jsonrpc: '2.0',
      id: 3,
      method: 'ping',
      params: { _meta: modernMeta }
    });
    assert.equal(ping.jsonrpc, '2.0');
    assert.equal(ping.id, 3);
    assert.equal(ping.result.resultType, 'complete');
  });

  await t.test('lists all expected tools without exposing handlers', async () => {
    const res = await dispatchMcp({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/list',
      params: { _meta: modernMeta }
    });
    assert.equal(res.result.resultType, 'complete');
    const toolNames = res.result.tools.map(t => t.name);
    assert.deepEqual(toolNames, [
      'pi_devices_list',
      'pi_device_info',
      'pi_device_authenticate',
      'pi_command_run',
      'pi_files_list',
      'pi_file_read',
      'pi_file_write',
      'pi_directory_create',
      'pi_path_rename',
      'pi_path_delete',
      'pi_device_reboot',
      'pi_ctrlpi_install',
      'pi_ui'
    ]);
    assert.ok(res.result.tools.every(t => !Object.hasOwn(t, 'handler')));
    assert.ok(res.result.tools.every(t => t.inputSchema && typeof t.inputSchema === 'object'));
    assert.ok(res.result.tools.every(t => t.annotations && typeof t.annotations === 'object'));
  });

  await t.test('rejects unknown tools and invalid requests', async () => {
    const unknown = await dispatchMcp({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'non_existent_tool', arguments: {}, _meta: modernMeta }
    });
    assert.ok(unknown.error);
    assert.equal(unknown.error.code, -32602);
    assert.match(unknown.error.message, /Unknown tool/);

    const badMethod = await dispatchMcp({
      jsonrpc: '2.0',
      id: 6,
      method: 'invalid/method',
      params: { _meta: modernMeta }
    });
    assert.ok(badMethod.error);
    assert.equal(badMethod.error.code, -32601);

    const invalidReq = await dispatchMcp({
      id: 7,
      method: 'ping'
    });
    assert.ok(invalidReq.error);
    assert.equal(invalidReq.error.code, -32600);
  });
});

test('MCP tool validations and execution', async t => {
  t.beforeEach(() => {
    _test.clearMcpSessions();
  });

  await t.test('pi_devices_list returns decorated devices from cache', async () => {
    _test.setScanCache([
      { host: '192.168.1.55', name: 'my-pi', mac: 'b8:27:eb:11:22:33', pi: true, ssh: true, ctrlpi: false, model: '4 Model B' }
    ]);
    const res = await dispatchMcp({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'pi_devices_list', arguments: {}, _meta: modernMeta }
    });
    assert.equal(res.id, 10);
    const content = res.result.structuredContent;
    assert.ok(Array.isArray(content.devices));
    const dev = content.devices.find(d => d.host === '192.168.1.55');
    assert.ok(dev);
    assert.equal(dev.name, 'my-pi');
    assert.equal(dev.pi, true);
    assert.equal(dev.device_id, 'b8:27:eb:11:22:33');
  });

  await t.test('pi_files_list validates required device_id', async () => {
    const res = await dispatchMcp({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'pi_files_list', arguments: {}, _meta: modernMeta }
    });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /Missing required argument: device_id/);
  });

  await t.test('pi_file_read validates path and rejects traversal', async () => {
    const res = await dispatchMcp({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'pi_file_read', arguments: { device_id: '127.0.0.1', path: '../escaped' }, _meta: modernMeta }
    });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /Invalid path/);
  });

  await t.test('pi_file_write validates content and encoding', async () => {
    const res = await dispatchMcp({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: {
        name: 'pi_file_write',
        arguments: { device_id: '127.0.0.1', path: 'test.txt', content: 'invalid base64!!!', encoding: 'base64' },
        _meta: modernMeta
      }
    });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /content is not valid base64/);
  });

  await t.test('pi_command_run validates command parameter', async () => {
    const res = await dispatchMcp({
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: { name: 'pi_command_run', arguments: { device_id: '127.0.0.1' }, _meta: modernMeta }
    });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /Missing required argument: command/);
  });

  await t.test('only pi_device_authenticate takes username and password', async () => {
    const list = await dispatchMcp({ jsonrpc: '2.0', id: 43, method: 'tools/list', params: { _meta: modernMeta } });
    const withCredentials = list.result.tools.filter(tool => 'password' in (tool.inputSchema.properties || {})).map(tool => tool.name);
    assert.deepEqual(withCredentials, ['pi_device_authenticate']);
    const res = await dispatchMcp({
      jsonrpc: '2.0',
      id: 44,
      method: 'tools/call',
      params: { name: 'pi_files_list', arguments: { device_id: '127.0.0.1', password: 'x' }, _meta: modernMeta }
    });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /Unknown argument: password/);
  });

  await t.test('pi_ctrlpi_install needs confirmed: true before it connects', async () => {
    const call = (id, args) => dispatchMcp({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'pi_ctrlpi_install', arguments: args, _meta: modernMeta }
    });
    const missing = await call(40, { device_id: '127.0.0.1' });
    assert.equal(missing.result.isError, true);
    assert.match(missing.result.content[0].text, /Missing required argument: confirmed/);
    const refused = await call(41, { device_id: '127.0.0.1', confirmed: false });
    assert.equal(refused.result.isError, true);
    assert.match(refused.result.content[0].text, /confirmed must be true/);
    const badPackage = await call(42, { device_id: '127.0.0.1', confirmed: true, package: 'huge' });
    assert.equal(badPackage.result.isError, true);
    assert.match(badPackage.result.content[0].text, /package must be one of: lite, full/);
  });

  await t.test('pi_path_rename validates both from and to paths', async () => {
    const res = await dispatchMcp({
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: { name: 'pi_path_rename', arguments: { device_id: '127.0.0.1', from: 'a.txt', to: '../b.txt' }, _meta: modernMeta }
    });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /Invalid path/);
  });

  await t.test('pi_path_delete rejects root directory deletion', async () => {
    const res = await dispatchMcp({
      jsonrpc: '2.0',
      id: 16,
      method: 'tools/call',
      params: { name: 'pi_path_delete', arguments: { device_id: '127.0.0.1', path: '.' }, _meta: modernMeta }
    });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /Cannot delete the root home directory/);
  });
});

test('resolveDevice handles IPs, MACs, and config matches', () => {
  const byIp = resolveDevice('192.168.1.200');
  assert.equal(byIp.host, '192.168.1.200');

  const byHost = resolveDevice('raspberrypi.local');
  assert.equal(byHost.host, 'raspberrypi.local');

  assert.throws(() => resolveDevice(''));
  assert.throws(() => resolveDevice(null));
});

test('HTTP MCP endpoint (/mcp)', async t => {
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

  function httpReq(urlPath, options = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(urlPath, baseUrl);
      const req = http.request(u, options, res => {
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

  await t.test('toggles MCP via /api/mcp endpoint', async () => {
    // Enable MCP
    const en = await httpReq('/api/mcp?enabled=1', { method: 'POST' });
    assert.equal(en.status, 200);
    assert.equal(en.json().enabled, true);

    // Modern discovery over HTTP
    const res = await httpReq('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'server/discover'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 100,
        method: 'server/discover',
        params: { _meta: modernMeta }
      })
    });
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.id, 100);
    assert.deepEqual(data.result.supportedVersions, ['2026-07-28']);

    // Disable MCP
    const dis = await httpReq('/api/mcp?enabled=0', { method: 'POST' });
    assert.equal(dis.status, 200);
    assert.equal(dis.json().enabled, false);

    // Request to /mcp when disabled returns 404
    const off = await httpReq('/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'ping' })
    });
    assert.equal(off.status, 404);

    // Re-enable for subsequent tests
    await httpReq('/api/mcp?enabled=1', { method: 'POST' });
  });

  await t.test('rejects non-POST HTTP methods with 405', async () => {
    const res = await httpReq('/mcp', { method: 'GET' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'POST');
  });

  await t.test('rejects invalid Origin header with 403', async () => {
    const res = await httpReq('/mcp', {
      method: 'POST',
      headers: {
        Origin: 'http://malicious-site.com',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 102, method: 'ping' })
    });
    assert.equal(res.status, 403);
    assert.equal(res.json().error.code, -32020);
  });

  await t.test('rejects parse errors with 400', async () => {
    const res = await httpReq('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not a valid json {'
    });
    assert.equal(res.status, 400);
    assert.equal(res.json().error.code, -32700);
  });

  await t.test('serves legacy MCP over HTTP', async () => {
    const res = await httpReq('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 103,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26' }
      })
    });
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.id, 103);
    assert.equal(data.result.serverInfo.name, 'pi-bay');
  });
});

// Resolves when the child exits; a child still running after 20 s is killed and the test fails
// with its output, instead of hanging the run.
function childExit(child, output, event = 'exit') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('MCP stdio child did not exit in 20 s\n' + output()));
    }, 20000);
    child.once('error', reject);
    child.once(event, code => { clearTimeout(timer); resolve(code); });
  });
}

test('MCP stdio child process', async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mcp-stdio'], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });

  const exitPromise = childExit(child, () => `stdout: ${stdout}\nstderr: ${stderr}`);

  const send = msg => child.stdin.write(JSON.stringify(msg) + '\n');

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'server/discover',
    params: { _meta: modernMeta }
  });

  // Wait briefly for stdout response
  let foundDiscover = false;
  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (stdout.includes('"resultType":"complete"')) {
      foundDiscover = true;
      break;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(foundDiscover, 'Received server/discover response over stdio');

  child.stdin.end();
  await exitPromise;
});

test('MCP stdio starts without a flag when an MCP client talks on stdin', async () => {
  const env = { ...process.env, PI_BAY_NO_OPEN: '1' };
  delete env.PI_BAY_MCP_STDIO;
  delete env.PI_BAY_MCP_HTTP;
  delete env.PI_BAY_NO_MCP;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env, stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  child.stdin.end(JSON.stringify({
    jsonrpc: '2.0', id: 31, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
  }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 32, method: 'ping' }) + '\n');
  await childExit(child, () => `stdout: ${stdout}\nstderr: ${stderr}`, 'close');
  const replies = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(replies.map(reply => reply.id), [31, 32]);
  assert.equal(replies[0].result.serverInfo.name, 'pi-bay');
});

// The whole module, for the helpers below.
const app = require('../server');

test('MCP stdio detection', async (t) => {
  const { PassThrough } = require('node:stream');

  await t.test('recognises a JSON-RPC line only', () => {
    assert.equal(app.isMcpLine('{"jsonrpc":"2.0","id":1,"method":"initialize"}'), true);
    assert.equal(app.isMcpLine('{"jsonrpc":"1.0","method":"initialize"}'), false);
    assert.equal(app.isMcpLine('{"hello":1}'), false);
    assert.equal(app.isMcpLine('hello'), false);
    assert.equal(app.isMcpLine('null'), false);
  });

  await t.test('an MCP first line is detected and left in the stream', async () => {
    const input = new PassThrough();
    const line = '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n';
    const detected = app.detectMcpStdio(input, 1000);
    input.write(line.slice(0, 10));
    input.write(line.slice(10) + 'next');
    assert.equal(await detected, true);
    assert.equal(input.read().toString(), line + 'next');
  });

  await t.test('other input, a closed stdin and silence are not MCP', async () => {
    const text = new PassThrough();
    const fromText = app.detectMcpStdio(text, 1000);
    text.write('hello\n');
    assert.equal(await fromText, false);

    const closed = new PassThrough();
    const fromClosed = app.detectMcpStdio(closed, 1000);
    closed.end();
    assert.equal(await fromClosed, false);

    assert.equal(await app.detectMcpStdio(new PassThrough(), 20), false);
  });

  await t.test('a /dev/null stdin is not a pipe', () => {
    const fd = fs.openSync(os.devNull, 'r');
    try { assert.equal(app.stdinIsPipe(fd), false); }
    finally { fs.closeSync(fd); }
    assert.equal(app.stdinIsPipe(-1), false);
  });
});

test('pi_ui', async (t) => {
  let opened = [];
  app._test.setUiServerPort(7999);
  app._test.setBrowserOpener(url => opened.push(url));
  t.after(() => {
    app._test.setUiServerPort(null);
    app._test.setBrowserOpener(null);
  });

  await t.test('opens the local browser on a desktop', async () => {
    opened = [];
    const result = await app.openUi({}, { raspberryPiHost: false, noOpen: false, env: {} });
    assert.equal(result.opened, true);
    assert.match(result.url, /^http:\/\/[^/]+:7999$/);
    assert.deepEqual(opened, [result.url]);
  });

  await t.test('returns the address instead when the client is on another computer', async () => {
    opened = [];
    const pi = { raspberryPiHost: true, noOpen: false };
    // HTTP MCP: the host the client reached.
    const overHttp = await app.openUi({ host: 'b4.local:8383' }, { ...pi, env: {} });
    assert.equal(overHttp.url, 'http://b4.local:8383');
    assert.equal(overHttp.opened, false);
    // stdio over ssh: the address the session came in on.
    const overSsh = await app.openUi({}, { ...pi, env: { SSH_CONNECTION: '192.168.1.5 50000 192.168.1.44 22' } });
    assert.equal(overSsh.url, 'http://192.168.1.44:7999');
    // Not a Pi, but reached over ssh or by a LAN address.
    const desktop = { raspberryPiHost: false, noOpen: false };
    assert.equal((await app.openUi({}, { ...desktop, env: { SSH_CONNECTION: 'fe80::1 5 fe80::2 22' } })).url,
      'http://[fe80::2]:7999');
    assert.equal((await app.openUi({ host: '192.168.1.9:8383' }, { ...desktop, env: {} })).opened, false);
    assert.equal((await app.openUi({ host: 'localhost:8383' }, { ...desktop, env: {} })).opened, true);
    assert.equal(opened.length, 1);
  });

  await t.test('--no-open returns the address without opening', async () => {
    opened = [];
    const result = await app.openUi({}, { raspberryPiHost: false, noOpen: true, env: {} });
    assert.equal(result.opened, false);
    assert.deepEqual(opened, []);
  });

  await t.test('action stop leaves a server it did not start', async () => {
    const result = await app.stopUi();
    assert.equal(result.stopped, false);
    assert.match(result.message, /not started by this tool/);
    const bad = await app.dispatchMcp({
      jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'pi_ui', arguments: { action: 'close' } }
    });
    assert.equal(bad.result.isError, true);
  });

  await t.test('rejects unknown arguments', async () => {
    const bad = await app.dispatchMcp({
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'pi_ui', arguments: { url: 'x' } }
    });
    assert.equal(bad.result.isError, true);
    const reply = await app.dispatchMcp({
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pi_ui', arguments: {} }
    }, { host: '10.0.0.7:8383' });
    assert.equal(reply.result.structuredContent.url, 'http://10.0.0.7:8383');
  });

  await t.test('serves the UI from a stdio MCP process', async () => {
    const env = { ...process.env };
    delete env.SSH_CONNECTION;
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mcp-stdio', '--port', '0', '--no-open'], {
      env, stdio: ['pipe', 'pipe', 'pipe']
    });
    try {
      const reply = new Promise((resolve, reject) => {
        let stdout = '';
        child.once('error', reject);
        child.once('close', () => reject(new Error('pi-bay exited: ' + stdout)));
        child.stdout.on('data', chunk => {
          stdout += chunk;
          if (stdout.includes('\n')) resolve(JSON.parse(stdout.split('\n')[0]));
        });
      });
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'pi_ui', arguments: {} }
      }) + '\n');
      const result = (await reply).result.structuredContent;
      assert.equal(result.opened, false);
      const page = await fetch(result.url);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<title>Pi Bay<\/title>/);

      // action stop closes it, a second stop has nothing to close, and open starts it again.
      const next = () => new Promise(resolve => {
        let text = '';
        const onData = chunk => {
          text += chunk;
          if (!text.includes('\n')) return;
          child.stdout.off('data', onData);
          resolve(JSON.parse(text.split('\n')[0]).result.structuredContent);
        };
        child.stdout.on('data', onData);
      });
      const send = (id, args) => child.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'pi_ui', arguments: args }
      }) + '\n');
      let answer = next();
      send(41, { action: 'stop' });
      assert.deepEqual(await answer, { stopped: true });
      await assert.rejects(fetch(result.url));
      answer = next();
      send(42, { action: 'stop' });
      assert.equal((await answer).stopped, false);
      answer = next();
      send(43, { action: 'open' });
      assert.equal((await fetch((await answer).url)).status, 200);
    } finally {
      child.kill();
    }
  });
});

test('busy port', async (t) => {
  const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const close = server => new Promise(resolve => server.close(resolve));

  await t.test('moves to a following port when another program holds it', async () => {
    const other = http.createServer();
    const busy = await listen(other);
    const server = http.createServer();
    try {
      const result = await app.listenOnFreePort(server, busy, '127.0.0.1', 3, async () => false);
      assert.equal(result.existing, undefined);
      assert.ok(result.port > busy && result.port <= busy + 3, 'port ' + result.port);
      assert.equal(server.address().port, result.port);
    } finally {
      await close(server);
      await close(other);
    }
  });

  await t.test('uses the same app already on the port instead of a second copy', async () => {
    const other = http.createServer();
    const busy = await listen(other);
    const server = http.createServer();
    try {
      const result = await app.listenOnFreePort(server, busy, '127.0.0.1', 3, async port => port === busy);
      assert.deepEqual(result, { port: busy, existing: true });
      assert.equal(server.listening, false);
    } finally {
      await close(other);
    }
  });

  await t.test('fails on a busy port when no fallback is allowed', async () => {
    const other = http.createServer();
    const busy = await listen(other);
    try {
      await assert.rejects(
        app.listenOnFreePort(http.createServer(), busy, '127.0.0.1', 0, async () => false),
        { code: 'EADDRINUSE' });
    } finally {
      await close(other);
    }
  });
});
