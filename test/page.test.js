'use strict';
// The page's server connection handling (page.html, "Server Connection"), run in a VM with
// stand-ins for the DOM and the rest of the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const page = fs.readFileSync(path.join(__dirname, '..', 'page.html'), 'utf8');
const START = '  // ── Server Connection ──';
const END = '  // ── Hover Tooltip ──';
const block = page.slice(page.indexOf(START), page.indexOf(END));

const settle = () => new Promise(resolve => setImmediate(resolve));

// Loads the block with a fake fetch and records what it does to the page.
function loadPage({ token = '', chosen = null, json = async () => ({}), scanText = 'Found 3 devices' } = {}) {
  const banner = new Set();
  const calls = { menu: [], toasts: [], reset: 0, logins: [], fetches: [], scans: 0 };
  const sessionCache = new Map();
  if (chosen) sessionCache.set(chosen.host, { token });
  const ctx = {
    token,
    chosen,
    sessionCache,
    serverUp: true,
    timers: [],
    $: sel => {
      if (sel === '#scanText') return { textContent: scanText };
      assert.equal(sel, '#connection-status');
      return { classList: { toggle: (cls, on) => (on ? banner.add(cls) : banner.delete(cls)) } };
    },
    scan: () => calls.scans++,
    fetch: async url => {
      calls.fetches.push(url);
      if (!ctx.serverUp) throw new TypeError('Failed to fetch');
      return { ok: true };
    },
    setInterval: (fn, ms) => ctx.timers.push({ fn, ms }),
    setMenuDeviceEnabled: on => calls.menu.push(on),
    toast: (msg, type) => calls.toasts.push([msg, type]),
    json,
    cacheKey: d => d.host,
    resetWorkspace: () => { calls.reset++; ctx.token = ''; ctx.chosen = null; },
    openLogin: (d, message) => calls.logins.push([d, message])
  };
  vm.createContext(ctx);
  vm.runInContext(block, ctx);
  return { ctx, calls, bannerVisible: () => banner.has('visible'), check: () => ctx.timers[0].fn() };
}

test('page.html has the banner, and every request goes through serverFetch', () => {
  assert.ok(block.length > 0, 'Server Connection block not found');
  assert.match(page, /<div id="connection-status" role="status" aria-live="polite">Connection to the Pi Bay server was lost\./);
  // The only bare fetch() call is the one inside serverFetch().
  const code = page.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.equal(code.match(/(?<![\w.])fetch\(/g).length, 1);
  for (const route of ["serverFetch(url, opt)", "serverFetch('/api/devices/stream'", "serverFetch('/api/readme')"])
    assert.ok(page.includes(route), route);
});

test('checks the server every 3 s with GET /api/mcp', async () => {
  const { ctx, calls, check } = loadPage();
  assert.equal(ctx.timers.length, 1);
  assert.equal(ctx.timers[0].ms, 3000);
  check();
  await settle();
  assert.deepEqual(calls.fetches, ['/api/mcp']);
});

test('a stopped server shows the banner and disables the device menu', async () => {
  const { ctx, calls, bannerVisible, check } = loadPage({ token: 't1' });
  check();
  await settle();
  assert.equal(bannerVisible(), false);
  assert.deepEqual(calls.toasts, [], 'the first answer is not a reconnect');

  ctx.serverUp = false;
  check();
  await settle();
  assert.equal(bannerVisible(), true);
  assert.deepEqual(calls.menu, [false]);
  // A request made meanwhile fails with a clear message.
  await assert.rejects(ctx.serverFetch('/api/files'), /Cannot reach the Pi Bay server/);
  assert.deepEqual(calls.menu, [false], 'stays disabled, not toggled again');
});

test('the server coming back hides the banner and re-enables the menu', async () => {
  const { ctx, calls, bannerVisible, check } = loadPage({ token: 't1', chosen: { host: '10.0.0.5' } });
  ctx.serverUp = false;
  check();
  await settle();
  ctx.serverUp = true;
  check();
  await settle();
  assert.equal(bannerVisible(), false);
  assert.deepEqual(calls.menu, [false, true]);
  assert.deepEqual(calls.toasts, [['Reconnected to the Pi Bay server', 'good']]);
  assert.equal(calls.reset, 0, 'a session that still works is kept');
  assert.equal(calls.scans, 0, 'a scan that worked is not run again');
});

test('a scan that failed while the server was down runs again on reconnect', async () => {
  const { ctx, calls, check } = loadPage({ scanText: 'Scan failed' });
  ctx.serverUp = false;
  check();
  await settle();
  ctx.serverUp = true;
  check();
  await settle();
  assert.equal(calls.scans, 1);
});

test('with no device open, the menu stays disabled after a reconnect', async () => {
  const { ctx, calls, check } = loadPage();
  ctx.serverUp = false;
  check();
  await settle();
  ctx.serverUp = true;
  check();
  await settle();
  assert.deepEqual(calls.menu, [false, false]);
});

test('a session lost in a server restart goes back to sign-in', async () => {
  const device = { host: '10.0.0.5' };
  const json = async url => {
    assert.equal(url, '/api/files?path=');
    throw new Error('Not connected');
  };
  const { ctx, calls, check } = loadPage({ token: 't1', chosen: device, json });
  ctx.serverUp = false;
  check();
  await settle();
  ctx.serverUp = true;
  check();
  await settle();
  assert.equal(calls.reset, 1);
  assert.equal(ctx.sessionCache.has('10.0.0.5'), false);
  assert.deepEqual(calls.logins, [[device, 'The previous session expired. Please connect again.']]);
});

test('another error on the session check keeps the device open', async () => {
  const json = async () => { throw new Error('Permission denied'); };
  const { ctx, calls, check } = loadPage({ token: 't1', chosen: { host: '10.0.0.5' }, json });
  ctx.serverUp = false;
  check();
  await settle();
  ctx.serverUp = true;
  check();
  await settle();
  assert.equal(calls.reset, 0);
  assert.deepEqual(calls.logins, []);
});
