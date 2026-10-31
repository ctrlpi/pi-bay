#!/usr/bin/env node
// Pi Bay server: LAN discovery, SSH/SFTP sessions, the web UI and JSON API, the terminal WebSocket, and the MCP server.
'use strict';

// Node built-ins, then the two SSH and WebSocket dependencies.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const dgram = require('dgram');
const dns = require('dns').promises;
const crypto = require('crypto');
const readline = require('readline');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const { Client } = require('ssh2');
const { WebSocketServer } = require('ws');
const {
  normalizeMac, isPi, remotePath, safeRelative, deviceKey, uniqueMacs, cleanVersion,
  modelParts, hardwareSpecs, crc32, createZipBuffer, parseZipBuffer, isRaspberryPi, envEnabled,
  selectMcpTransports, shouldOpenBrowser, asText, decodeMcpContent
} = require('./lib');
const VERSION = require('./package.json').version;

// Promise form of execFile, for the keychain and network helpers.
const execFileP = promisify(execFile);
const args = process.argv.slice(2);
// The value after a command-line flag, or the fallback.
function arg(name, fallback) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; }

// --version and --help print and exit before anything starts.
if (require.main === module && args.includes('--version')) {
  console.log(VERSION);
  process.exit(0);
}
if (require.main === module && args.includes('--help')) {
  console.log(`Usage: pi-bay [options]

Options:
  --port PORT         Web server port
  --host ADDRESS      Web server address
  --allow-host NAME   Also accept requests addressed to this host name
  --ssh-port PORT     SSH port (default 22)
  --api-port PORT     ctrlPi API port (default 8314)
  --api-key KEY       ctrlPi API key
  --no-open           Do not open a browser
  --mcp-stdio         Run MCP over stdio
  --mcp-http          Enable MCP over HTTP
  --no-mcp            Disable MCP
  --help              Show this help
  --version           Show the version`);
  process.exit(0);
}

// MCP transport flags from the command line.
const cliMcpStdio = args.includes('--mcp-stdio');
const cliMcpHttp = args.includes('--mcp-http');
const cliNoMcp = args.includes('--no-mcp') || envEnabled(process.env.PI_BAY_NO_MCP);

// A Raspberry Pi host turns on HTTP MCP by default; flags and environment can override it.
const RASPBERRY_PI_HOST = isRaspberryPi();
const selectedMcp = selectMcpTransports({
  raspberryPiHost: RASPBERRY_PI_HOST,
  noMcp: cliNoMcp,
  cliStdio: cliMcpStdio,
  cliHttp: cliMcpHttp,
  envStdio: process.env.PI_BAY_MCP_STDIO,
  envHttp: process.env.PI_BAY_MCP_HTTP
});
const mcpStdio = selectedMcp.stdio;
let enableMcp = selectedMcp.http;
// --no-mcp together with an MCP transport flag is refused at startup.
const conflictingMcpFlags = cliNoMcp && (cliMcpStdio || cliMcpHttp);

const PORT = Number(arg('--port', arg('-p', process.env.PORT || 8383)));
const HOST = arg('--host', process.env.PI_BAY_HOST || (RASPBERRY_PI_HOST ? '0.0.0.0' : '127.0.0.1'));
// Extra host names the web server answers to (comma-separated or repeated); the --host
// name is one of them, so a server started on a name can be opened by that name.
const ALLOW_HOSTS = hostList([...args.flatMap((a, i) => a === '--allow-host' ? [args[i + 1]] : []), process.env.PI_BAY_ALLOW_HOSTS, HOST]);

// Lower-cased host names from comma-separated values.
function hostList(values) {
  return values.flatMap(value => String(value || '').split(','))
    .map(name => name.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean);
}

// Against DNS rebinding: a page on another domain can point its name at this machine,
// but the browser still sends that name in Host. Only IP addresses, localhost, this
// machine's own name (and <name>.local) and the --allow-host names get through.
function hostAllowed(hostHeader, extra = [], hostname = os.hostname()) {
  const match = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9.-]+))(?::\d+)?$/i.exec(String(hostHeader || ''));
  if (!match) return false;
  const name = (match[1] || match[2]).toLowerCase().replace(/\.$/, '');
  if (net.isIP(name) || name === 'localhost') return true;
  const own = String(hostname || '').toLowerCase().replace(/\.local$/, '');
  if (own && (name === own || name === own + '.local')) return true;
  return extra.includes(name);
}
const SSH_PORT = Number(arg('--ssh-port', process.env.PI_BAY_SSH_PORT || '22'));
const API_PORT = Number(arg('--api-port', process.env.PI_BAY_API_PORT || '8314'));
const API_KEY = arg('--api-key', process.env.PI_BAY_API_KEY || 'your-secret-key');
const noOpen = args.includes('--no-open') || envEnabled(process.env.PI_BAY_NO_OPEN);

// Opens a URL in the default browser.
function openBrowser(url) {
  const plat = process.platform;
  if (plat === 'darwin') {
    execFile('open', [url], () => {});
  } else if (plat === 'win32') {
    execFile('cmd.exe', ['/c', 'start', '""', url], () => {});
  } else {
    execFile('xdg-open', [url], () => {});
  }
}
// Saved devices (host, MAC, username, model) are kept in ~/.ctrlpi/.
const CONFIG_PATH = path.join(os.homedir(), '.ctrlpi', 'pi-bay-devices.json');
const PAGE = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8');
const sessions = new Map();
const mcpSessions = new Map();
let scanCache = [];
let scanPromise = null;
const sharedMacs = new Set();

// Sends a JSON response.
function sendJSON(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}
// The request body as a Buffer, refused when it is over the limit.
function readBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => { const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
  });
}
// The saved devices from ~/.ctrlpi/pi-bay-devices.json (empty when missing or unreadable).
function configRead() { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return { devices: {} }; } }
// Saves the devices file atomically, readable by the user only.
function configWrite(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  const tmp = CONFIG_PATH + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH); try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
}
// Saved passwords live in the macOS Keychain (`security`) or Linux Secret Service (`secret-tool`), service "pi-bay".
function keychainAccount(key) { return 'pi-bay:' + key; }
// The saved password for a device, or null.
async function keychainGet(key) {
  if (process.platform === 'darwin') {
    try {
      return (await execFileP('security', ['find-generic-password', '-s', 'pi-bay', '-a', keychainAccount(key), '-w'])).stdout.trimEnd();
    } catch { return null; }
  }
  if (process.platform === 'linux') {
    try {
      return (await execFileP('secret-tool', ['lookup', 'service', 'pi-bay', 'account', keychainAccount(key)])).stdout.trimEnd();
    } catch { return null; }
  }
  return null;
}
// Saves a device's password.
async function keychainSet(key, password) {
  if (process.platform === 'darwin') {
    await execFileP('security', ['add-generic-password', '-U', '-s', 'pi-bay', '-a', keychainAccount(key), '-w', password]);
    return;
  }
  // secret-tool reads the password from stdin, so it never appears in the process list.
  if (process.platform === 'linux') await new Promise((resolve, reject) => {
    const p = spawn('secret-tool', ['store', '--label=Pi Bay', 'service', 'pi-bay', 'account', keychainAccount(key)]);
    p.stdin.end(password);
    p.on('exit', c => c === 0 ? resolve() : reject(new Error('Could not save password to keychain')));
  });
  else throw new Error('Password saving is not supported on this operating system');
}
// Forgets a device's saved password.
async function keychainDelete(key) {
  if (process.platform === 'darwin') {
    try { await execFileP('security', ['delete-generic-password', '-s', 'pi-bay', '-a', keychainAccount(key)]); } catch {}
  }
  if (process.platform === 'linux') {
    try { await execFileP('secret-tool', ['clear', 'service', 'pi-bay', 'account', keychainAccount(key)]); } catch {}
  }
}

// The LAN address and its interface: the source address of a UDP socket "connected" to 8.8.8.8 (no packet
// is sent), so a VPN or virtual adapter listed first does not win; offline, the first active IPv4 interface.
function localIPv4() {
  const byAddress = address => {
    for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || [])
      if (a.family === 'IPv4' && !a.internal && (!address || a.address === address)) return { address: a.address, interface: name };
    return null;
  };
  return new Promise(resolve => {
    const s = dgram.createSocket('udp4');
    let settled = false;
    const done = address => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { s.close(); } catch {}
      resolve((address && byAddress(address)) || byAddress());
    };
    const timer = setTimeout(() => done(null), 500);
    s.once('error', () => done(null));
    try {
      s.connect(80, '8.8.8.8', () => {
        let address = null;
        try { address = s.address().address; } catch {}
        done(address && address !== '0.0.0.0' && !address.startsWith('127.') ? address : null);
      });
    } catch { done(null); }
  });
}
// True when a TCP connection to host:port succeeds within the timeout.
function portOpen(host, port, timeout = 1200) {
  return new Promise(resolve => {
    const s = net.createConnection({ host, port });
    let done = false;
    const finish = ok => { if (done) return; done = true; s.destroy(); resolve(ok); };
    s.setTimeout(timeout);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
  });
}
// ctrlPi agents answer GET /hello without a key; /config/read (needs the key) adds model, OS, and version.
function helloName(host, timeout = 1500) {
  return new Promise(resolve => {
    const req = http.get({ host, port: API_PORT, path: '/hello', timeout }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks));
          resolve({ ctrlpi: res.statusCode === 200, name: data.name || null });
        } catch { resolve({ ctrlpi: false, name: null }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ctrlpi: false, name: null }); });
    req.on('error', () => resolve({ ctrlpi: false, name: null }));
  });
}
// The agent's model, OS, version and specs from /config/read (nulls when it does not answer).
function ctrlPiConfig(host, timeout = 1500) {
  return new Promise(resolve => {
    const req = http.get({ host, port: API_PORT, path: '/config/read', timeout, headers: { 'Api-Key': API_KEY } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ model: null, version: null, os: null, ram: null, flash: null, revision: null, package: null, frequency: null });
        try {
          const data = JSON.parse(Buffer.concat(chunks)), agent = data.agent || {};
          // Each field is read from the agent block first, then from its other accepted names.
          resolve({
            version: agent.version || null,
            model: agent.platform || null,
            os: agent.os || null,
            ram: agent.ram || agent.memory || data.ram || data.memory || null,
            flash: agent.flash || agent.storage || agent.sd || data.flash || data.storage || null,
            revision: agent.revision || agent.rev || data.revision || data.rev || null,
            package: agent.package || data.package || null,
            frequency: agent.frequency || agent.freq || data.frequency || data.freq || null
          });
        } catch { resolve({ model: null, version: null, os: null, ram: null, flash: null, revision: null, package: null, frequency: null }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ model: null, version: null, os: null, ram: null, flash: null, revision: null, package: null, frequency: null }); });
    req.on('error', () => resolve({ model: null, version: null, os: null, ram: null, flash: null, revision: null, package: null, frequency: null }));
  });
}
// macOS only: the SMB/NetBIOS name of an IP, or null.
async function smbName(ip) {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileP('smbutil', ['status', '-a', ip], { timeout: 5000 });
    // The workstation name is the <00> UNIQUE entry.
    for (const line of stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 3 && parts[1] === '0x00' && parts[2] === 'UNIQUE') return parts[0];
    }
  } catch {}
  return null;
}
// macOS only: the output of a time-limited dns-sd call.
async function dnsSd(args, timeout) {
  if (process.platform !== 'darwin') return '';
  try { return (await execFileP('dns-sd', args, { timeout, maxBuffer: 2 * 1024 * 1024 })).stdout || ''; }
  // dns-sd runs until killed, so the timeout is normal: keep what it printed.
  catch (e) { return Buffer.isBuffer(e.stdout) ? e.stdout.toString() : e.stdout || ''; }
}
// macOS only: browse Bonjour services, resolve each to <host>.local, then to an IPv4 address. Returns { ip: name }.
async function bonjourNames() {
  if (process.platform !== 'darwin') return {};
  const services = ['_afpovertcp._tcp', '_smb._tcp', '_ssh._tcp', '_workstation._tcp'];
  // 1. Browse each service type for instance names.
  const browsed = await Promise.all(services.map(async service => {
    const out = await dnsSd(['-B', service, 'local'], 3000), found = [];
    for (const line of out.split('\n')) {
      const marker = service + '.', idx = line.indexOf(marker);
      if (line.includes(' Add ') && idx !== -1) {
        const instance = line.slice(idx + marker.length).trim();
        if (instance) found.push({ instance, service });
      }
    }
    return found;
  }));
  const unique = new Map();
  for (const item of browsed.flat()) unique.set(item.service + '\0' + item.instance, item);
  // 2. Resolve each instance to its <host>.local name.
  const resolved = await Promise.all([...unique.values()].map(async item => {
    const out = await dnsSd(['-L', item.instance, item.service, 'local'], 2000), m = out.match(/reached at ([A-Za-z0-9._-]+\.local)\.?:/);
    return m ? { host: m[1], name: item.instance } : null;
  }));
  const hostNames = new Map();
  for (const item of resolved) if (item && !hostNames.has(item.host)) hostNames.set(item.host, item.name);
  // 3. Look up each host's IPv4 address; the name drops a trailing "[mac]".
  const addresses = await Promise.all([...hostNames].map(async ([host, name]) => {
    const out = await dnsSd(['-G', 'v4', host], 2000);
    for (const line of out.split('\n')) {
      const m = line.match(/\b(\d+\.\d+\.\d+\.\d+)\b/);
      if (line.includes('Add') && m && m[1] !== '0.0.0.0') return { ip: m[1], name: name.replace(/\s*\[[0-9a-fA-F:]+\]\s*$/, '') };
    }
    return null;
  }));
  const names = {};
  for (const item of addresses) if (item) names[item.ip] = item.name;
  return names;
}
// The ARP table as { ip: mac }, optionally for one interface.
async function arpMap(interfaceName) {
  try {
    const { stdout } = await execFileP('arp', ['-an'], { timeout: 10000 });
    const out = {};
    for (const line of stdout.split('\n')) {
      if (interfaceName && !line.includes(` on ${interfaceName} `)) continue;
      const m = line.match(/\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-fA-F:]+)/);
      if (m) out[m[1]] = normalizeMac(m[2]);
    }
    return out;
  } catch { return {}; }
}
// Probe every address of the local /24 (48 at a time) for SSH and ctrlPi, then name each hit from /hello, reverse DNS,
// Bonjour, or SMB, and read MACs from the ARP table. Results are cached; force=true rescans. onDevice streams each find.
async function scanNetwork(force = false, onDevice = null) {
  if (!force && scanCache.length) { if (onDevice) scanCache.forEach(onDevice); return scanCache; }
  if (scanPromise) return scanPromise;
  scanPromise = (async () => {
    const local = await localIPv4();
    if (!local) throw new Error('Could not determine the local IPv4 address');
    const prefix = local.address.split('.').slice(0, 3).join('.');
    const found = [];
    let next = 1;
    const flags = new Map();
    const initialArp = uniqueMacs(await arpMap(local.interface), sharedMacs);
    // Each worker takes the next address until all 254 are probed; a hit is streamed straight away.
    async function worker() {
      while (next < 255) {
        const ip = `${prefix}.${next++}`;
        const [ssh, hello] = await Promise.all([portOpen(ip, SSH_PORT), helloName(ip)]);
        const config = hello.ctrlpi ? await ctrlPiConfig(ip) : { model: null, version: null, os: null, ram: null, flash: null, revision: null, package: null, frequency: null };
        if (ssh || hello.ctrlpi) {
          found.push(ip);
          flags.set(ip, { ssh, hello, config });
          let name = hello.name;
          if (!name) try { name = (await dns.reverse(ip))[0] || null } catch {}
          name = name || '-';
          const mac = initialArp[ip] || '';
          if (onDevice) onDevice({
            host: ip, name, mac, pi: isPi(mac, name), ssh, ctrlpi: hello.ctrlpi,
            model: config.model, version: config.version, os: config.os, ram: config.ram, flash: config.flash,
            revision: config.revision, package: config.package, frequency: config.frequency, port: SSH_PORT
          });
        }
      }
    }
    await Promise.all(Array.from({ length: 48 }, worker));
    // After the probe: a fresh ARP table and Bonjour names complete each device.
    const [rawArp, bonjour] = await Promise.all([arpMap(local.interface), bonjourNames()]);
    const arp = uniqueMacs(rawArp, sharedMacs);
    scanCache = await Promise.all(found.sort((a, b) => Number(a.split('.')[3]) - Number(b.split('.')[3])).map(async ip => {
      const probe = flags.get(ip);
      let name = probe.hello.name;
      if (!name) try { name = (await dns.reverse(ip))[0] || null; } catch {}
      if (!name) name = bonjour[ip] || await smbName(ip);
      name = name || '-';
      const mac = arp[ip] || '';
      const device = {
        host: ip, name, mac, pi: isPi(mac, name), ssh: probe.ssh, ctrlpi: probe.hello.ctrlpi,
        model: probe.config.model, version: probe.config.version, os: probe.config.os, ram: probe.config.ram, flash: probe.config.flash,
        revision: probe.config.revision, package: probe.config.package, frequency: probe.config.frequency, port: SSH_PORT
      };
      if (onDevice) onDevice(device);
      return device;
    }));
    return scanCache;
  })().finally(() => { scanPromise = null; });
  return scanPromise;
}

// Authenticates with the given password or key, plus the SSH agent (SSH_AUTH_SOCK); with none of those it tries
// ~/.ssh/id_ed25519, id_rsa, then id_ecdsa. Host keys are accepted without verification.
function connectSSH({ host, port, username, password, privateKey, agent }) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    client.on('ready', () => { settled = true; resolve(client); })
          .on('error', e => {
            if (!settled) {
              settled = true;
              if (/All configured authentication methods failed/i.test(e.message)) {
                reject(new Error(`Authentication failed for ${username}@${host}: No valid password or SSH key. Provide a password or authenticate first using pi_device_authenticate.`));
              } else {
                reject(e);
              }
            }
          });

    const authConfig = {
      host,
      port,
      username,
      readyTimeout: 12000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      hostVerifier: () => true
    };
    if (password) authConfig.password = password;
    if (privateKey) authConfig.privateKey = privateKey;
    if (agent) {
      authConfig.agent = agent;
    } else if (process.env.SSH_AUTH_SOCK) {
      authConfig.agent = process.env.SSH_AUTH_SOCK;
    }

    if (!password && !privateKey && !authConfig.agent) {
      const keyFiles = ['id_ed25519', 'id_rsa', 'id_ecdsa'];
      for (const kf of keyFiles) {
        const keyPath = path.join(os.homedir(), '.ssh', kf);
        try {
          if (fs.existsSync(keyPath)) {
            authConfig.privateKey = fs.readFileSync(keyPath);
            break;
          }
        } catch {}
      }
    }

    try {
      client.connect(authConfig);
    } catch (err) {
      if (!settled) {
        settled = true;
        reject(err);
      }
    }
  });
}

// Runs a command over SSH and resolves with its output; rejects on a non-zero exit.
function execSSH(client, command) {
  return new Promise((resolve, reject) => client.exec(command, (err, stream) => {
    if (err) return reject(err);
    let out = '', error = '';
    stream.on('data', d => out += d).stderr.on('data', d => error += d);
    stream.on('close', code => code === 0 ? resolve(out) : reject(new Error(error.trim() || `Remote command failed (${code})`)));
  }));
}

// The agents' shipped API key: anyone who knows it can drive the GPIO pins, and agents refuse
// /script/write while it is set.
const CTRLPI_DEFAULT_KEY = 'your-secret-key';
const CTRLPI_DEFAULT_KEY_WARNING = 'The agent uses the default API key your-secret-key, which is public: anyone on the network can control it, and /script/write is refused until the key is changed.';
// For pi_ctrlpi_install: pi-gpio-api's installer, the same command the page types into the Terminal tab.
const CTRLPI_INSTALL_CMD = pkg => 'cd ~ && curl -fsSL https://raw.githubusercontent.com/ctrlpi/pi-gpio-api/main/install.sh | bash -s -- --' + pkg;
// Then on a Raspberry Pi with passwordless sudo, the service the installer only prints: restarted when it
// exists, else created (same unit as the installer's) and started. Prints restarted, started, needs_sudo
// or not_raspberry_pi.
const CTRLPI_SERVICE_CMD = [
  'grep -qi raspberry /proc/device-tree/model 2>/dev/null || { echo not_raspberry_pi; exit 0; }',
  'sudo -n true 2>/dev/null || { echo needs_sudo; exit 0; }',
  'if [ -f /etc/systemd/system/pi-gpio-api.service ]; then sudo -n systemctl restart pi-gpio-api && echo restarted; exit; fi',
  `printf '[Unit]\\nDescription=pi-gpio-api GPIO REST server\\nAfter=network.target\\n\\n[Service]\\nUser=%s\\nExecStart=%s\\nRestart=on-failure\\n\\n[Install]\\nWantedBy=multi-user.target\\n' "$(whoami)" "$HOME/pi-gpio-api/run.sh" | sudo -n tee /etc/systemd/system/pi-gpio-api.service >/dev/null`,
  'sudo -n systemctl daemon-reload && sudo -n systemctl enable --now pi-gpio-api && echo started'
].join('\n');

// For Toggle Pi USB Power: whether uhubctl is installed, and whether the root filesystem is on a
// USB drive (cutting USB power would then crash the Pi). The page runs uhubctl in the Terminal tab.
const USB_POWER_CHECK_CMD = '{ [ -x /usr/sbin/uhubctl ] || command -v uhubctl >/dev/null; } && echo 1 || echo 0; findmnt -no SOURCE / 2>/dev/null || true';

// Runs a command over SSH with a timeout and resolves with { exit_code, stdout, stderr }.
function execSSHCommand(client, command, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let timer = null;
    let timedOut = false;
    client.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          try { stream.close(); } catch {}
          reject(new Error(`Command timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      stream.on('data', d => { stdout += d; });
      stream.stderr.on('data', d => { stderr += d; });
      stream.on('close', (code, signal) => {
        if (timer) clearTimeout(timer);
        if (timedOut) return;
        resolve({
          exit_code: typeof code === 'number' ? code : (signal ? 128 : 0),
          signal: signal || null,
          stdout,
          stderr,
          ok: code === 0
        });
      });
    });
  });
}

// Opens an SFTP channel on an SSH connection.
function sftpFor(client) {
  return new Promise((resolve, reject) => client.sftp((e, s) => e ? reject(e) : resolve(s)));
}
// Calls an SFTP method and resolves with its result.
function sftpCall(sftp, method, ...args) {
  return new Promise((resolve, reject) => sftp[method](...args, (e, value) => e ? reject(e) : resolve(value)));
}
// The signed-in session for a token; throws 'Not connected' when there is none.
function getSession(token) {
  const s = sessions.get(token);
  if (!s) throw new Error('Not connected');
  s.lastUsed = Date.now();
  return s;
}

// Read a folder tree for /api/zip: at most maxFiles files and maxTotalSize bytes, skipping files over 20 MB.
async function collectFiles(sftp, home, relPath = '', maxFiles = 500, maxTotalSize = 100 * 1024 * 1024) {
  const entries = [];
  let totalBytes = 0;
  async function walk(dir) {
    if (entries.length >= maxFiles) return;
    const abs = remotePath(home, dir);
    const list = await sftpCall(sftp, 'readdir', abs);
    for (const item of list) {
      if (item.filename === '.' || item.filename === '..') continue;
      const subRel = dir ? dir + '/' + item.filename : item.filename;
      if (item.attrs.isDirectory()) {
        await walk(subRel);
      } else {
        if (entries.length >= maxFiles) break;
        if (item.attrs.size > 20 * 1024 * 1024 || totalBytes + item.attrs.size > maxTotalSize) continue;
        const data = await sftpCall(sftp, 'readFile', remotePath(home, subRel));
        totalBytes += data.length;
        entries.push({ path: subRel, content: data, mtime: item.attrs.mtime });
      }
    }
  }
  await walk(relPath);
  return entries;
}

// The entries of a $HOME-relative folder, folders first, dot files only when asked for.
async function listDirectory(session, rel, showHidden = false) {
  rel = safeRelative(rel || '');
  const sftp = await sftpFor(session.client);
  const abs = remotePath(session.home, rel);
  const entries = await sftpCall(sftp, 'readdir', abs);
  sftp.end();
  return entries
    .filter(e => e.filename !== '.' && e.filename !== '..' && (showHidden || !e.filename.startsWith('.')))
    .map(e => ({ path: rel ? rel + '/' + e.filename : e.filename, name: e.filename, isDir: e.attrs.isDirectory(), isLink: e.attrs.isSymbolicLink(), size: e.attrs.size, mtime: e.attrs.mtime }))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
}

// Deletes a file, or a folder with everything inside it.
async function removeRemote(session, rel) {
  const sftp = await sftpFor(session.client);
  const abs = remotePath(session.home, rel);
  const st = await sftpCall(sftp, 'lstat', abs);
  // lstat, so a symlink is removed itself and never followed into its target.
  async function rm(p) {
    const x = await sftpCall(sftp, 'lstat', p);
    if (x.isDirectory()) {
      for (const e of await sftpCall(sftp, 'readdir', p)) if (e.filename !== '.' && e.filename !== '..') await rm(p + '/' + e.filename);
      await sftpCall(sftp, 'rmdir', p);
    } else await sftpCall(sftp, 'unlink', p);
  }
  await rm(abs);
  sftp.end();
  return st;
}

// Creates a $HOME-relative folder and any missing parents.
async function ensureRemoteDirectory(sftp, home, relDir) {
  if (!relDir || relDir === '.') return;
  const parts = relDir.split('/').filter(Boolean);
  let cur = '';
  for (const part of parts) {
    cur = cur ? cur + '/' + part : part;
    const abs = remotePath(home, cur);
    try {
      const st = await sftpCall(sftp, 'stat', abs);
      if (!st.isDirectory()) throw new Error(`Not a directory: ${cur}`);
    } catch (err) {
      if (err.code === 2 || /no such file/i.test(err.message)) {
        await sftpCall(sftp, 'mkdir', abs);
      } else {
        throw err;
      }
    }
  }
}

// Find a device's saved entry: by MAC key (or IP when there is no MAC), else by IP when the saved MAC does not
// contradict it and a saved microcontroller model is not being matched to an SSH host or Pi.
function savedDevice(cfg, device) {
  const key = deviceKey(device.host, device.mac);
  if (cfg.devices[key]) return { key, value: cfg.devices[key] };
  const normMac = normalizeMac(device.mac || '');
  for (const [oldKey, value] of Object.entries(cfg.devices)) {
    if (value.host === device.host) {
      const savedMac = normalizeMac(value.mac || '');
      if (normMac && savedMac && savedMac !== normMac) continue;
      if (device.ssh && /ESP32|Pico/i.test(value.model || '')) continue;
      if (device.pi && /ESP32/i.test(value.model || '')) continue;
      return { key: oldKey, value };
    }
  }
  return { key, value: {} };
}
// Merge a scanned device with its saved entry (username, saved-password flag, model, specs) and save model changes.
function decorateDevice(device, cfg) {
  const currentKey = deviceKey(device.host, device.mac);
  const found = savedDevice(cfg, device);
  const saved = found.value;
  let changed = false;

  const isMicrocontroller = /ESP32|Pico/i.test(saved.model || '');
  let safeSavedModel = saved.model;
  if ((device.ssh || device.pi) && isMicrocontroller) {
    safeSavedModel = null;
    if (cfg.devices[currentKey] && cfg.devices[currentKey].model && /ESP32|Pico/i.test(cfg.devices[currentKey].model)) {
      delete cfg.devices[currentKey].model;
      changed = true;
    }
    if (found.key && cfg.devices[found.key] && cfg.devices[found.key].model && /ESP32|Pico/i.test(cfg.devices[found.key].model)) {
      delete cfg.devices[found.key].model;
      changed = true;
    }
  }

  if (device.model && device.model !== saved.model) {
    cfg.devices[currentKey] = {
      ...saved,
      host: device.host,
      mac: device.mac || saved.mac || '',
      model: device.model,
      ram: device.ram || saved.ram || null,
      flash: device.flash || saved.flash || null,
      revision: device.revision || saved.revision || null,
      package: device.package || saved.package || null,
      frequency: device.frequency || saved.frequency || null
    };
    if (found.key !== currentKey) delete cfg.devices[found.key];
    changed = true;
  }
  if (changed) try { configWrite(cfg); } catch {}
  return {
    ...device,
    model: device.model || safeSavedModel || null,
    ram: device.ram || saved.ram || null,
    flash: device.flash || saved.flash || null,
    revision: device.revision || saved.revision || null,
    package: device.package || saved.package || null,
    frequency: device.frequency || saved.frequency || null,
    username: saved.username || 'pi',
    saved: !!saved.saved
  };
}

// Map an MCP device_id (IP, MAC, name, or saved key) to a device: scan results first, then saved devices, then a bare host.
function resolveDevice(deviceId) {
  const wanted = String(deviceId || '').trim();
  if (!wanted) throw new Error('device_id must be a non-empty string');
  const norm = wanted.toLowerCase();
  const normMac = normalizeMac(wanted);

  if (Array.isArray(scanCache) && scanCache.length > 0) {
    const match = scanCache.find(d =>
      (d.host && d.host.toLowerCase() === norm) ||
      (d.mac && normalizeMac(d.mac) === normMac) ||
      (d.name && d.name.toLowerCase() === norm) ||
      deviceKey(d.host, d.mac).toLowerCase() === norm
    );
    if (match) return match;
  }

  const cfg = configRead();
  if (cfg.devices) {
    for (const [key, d] of Object.entries(cfg.devices)) {
      if (key.toLowerCase() === norm ||
          (d.host && d.host.toLowerCase() === norm) ||
          (d.mac && normalizeMac(d.mac) === normMac)) {
        return { host: d.host, mac: d.mac || '', name: d.name || d.host, ...d };
      }
    }
  }

  if (net.isIP(wanted) || /^[a-zA-Z0-9.-]+$/.test(wanted)) {
    return { host: wanted, mac: '', name: wanted };
  }

  throw new Error(`Device not found: ${wanted}`);
}

// Reuse or open the SSH session an MCP tool call needs: the one pi_device_authenticate opened, or
// a new one with the saved username and keychain password (or SSH keys).
async function getDeviceSession(deviceId) {
  const device = resolveDevice(deviceId);
  if (!device || !device.host) throw new Error(`Device not found: ${deviceId}`);
  const key = deviceKey(device.host, device.mac);
  const existing = mcpSessions.get(key);
  if (existing && existing.client && !existing.client._sock?.destroyed && existing.client._sock?.writable) {
    existing.lastUsed = Date.now();
    return existing;
  }
  if (existing) mcpSessions.delete(key);

  const cfg = configRead();
  const found = savedDevice(cfg, device);
  const saved = found.value;
  const username = device.username || saved.username || 'pi';
  const port = Number(device.port) || SSH_PORT;

  let password = null;
  if (saved.saved) {
    password = await keychainGet(found.key);
  }

  let client;
  try {
    client = await connectSSH({ host: device.host, port, username, password });
  } catch (err) {
    throw new Error(`${err.message}. Sign in with pi_device_authenticate first (save_password: true keeps the password for later sessions).`);
  }
  let home;
  try {
    home = (await execSSH(client, 'printf %s "$HOME"')).trim();
    if (!home.startsWith('/')) throw new Error('Invalid home directory');
  } catch (err) {
    client.end();
    throw new Error(`Could not resolve remote home directory for ${device.host}: ${err.message}`);
  }

  const session = {
    client,
    host: device.host,
    port,
    username,
    home,
    lastUsed: Date.now()
  };
  client.on('close', () => mcpSessions.delete(key));
  client.on('error', () => mcpSessions.delete(key));
  mcpSessions.set(key, session);
  return session;
}

// ── Model Context Protocol ─────────────────────────────────────────────────
const MCP_PROTOCOL = '2026-07-28';
const MCP_LEGACY_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const MCP_SERVER_INFO = { name: 'pi-bay', version: VERSION };
const MCP_CAPABILITIES = { tools: { listChanged: false } };
const MCP_MAX_BODY = 12 * 1024 * 1024;

// An MCP tool result: the data as text and as structured content.
function mcpToolResult(data, isError = false) {
  const text = isError
    ? (data && data.error ? String(data.error) : JSON.stringify(data))
    : JSON.stringify(data);
  const result = {
    content: [{ type: 'text', text }],
    structuredContent: isError && typeof data !== 'object' ? { error: String(data) } : data,
  };
  if (isError) result.isError = true;
  return result;
}

// Checks a tool's arguments: an object, only known keys, required keys present.
function validateToolArgs(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Arguments must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error('Unknown argument: ' + key);
  }
  for (const key of required) {
    if (value[key] === undefined) throw new Error('Missing required argument: ' + key);
  }
  return value;
}

// A string argument, optionally allowed empty or limited to listed values.
function stringArg(args, name, options = {}) {
  const value = args[name];
  if (value === undefined && options.optional) return undefined;
  if (typeof value !== 'string' || (!options.allowEmpty && !value.length)) {
    throw new Error(name + ' must be a' + (options.allowEmpty ? '' : ' non-empty') + ' string');
  }
  if (options.values && !options.values.includes(value)) {
    throw new Error(name + ' must be one of: ' + options.values.join(', '));
  }
  return value;
}

// A boolean argument, or its default.
function booleanArg(args, name, defaultValue = false) {
  if (args[name] === undefined) return defaultValue;
  if (typeof args[name] !== 'boolean') throw new Error(name + ' must be a boolean');
  return args[name];
}

// A finite number argument, or its default.
function numberArg(args, name, options = {}) {
  const value = args[name];
  if (value === undefined) {
    if (options.optional) return options.defaultValue !== undefined ? options.defaultValue : undefined;
    throw new Error('Missing required argument: ' + name);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(name + ' must be a finite number');
  }
  return value;
}

const deviceIdProperty = {
  type: 'string',
  description: 'IP address, hostname, MAC address, or device identifier of the target Raspberry Pi / SSH device.'
};
const devicePathProperty = {
  type: 'string',
  description: 'Path relative to the authenticated user\'s remote $HOME directory.'
};
// MCP hints that tell clients whether a tool changes the device.
const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const additiveAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const destructiveAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

// Each tool: name, schema, annotations and the handler that runs it.
const MCP_TOOLS = [
  {
    name: 'pi_devices_list',
    title: 'List discovered devices',
    description: 'Scan the local network for Raspberry Pis and SSH devices, returning IP, MAC, hostname, model, ctrlPi status, and saved credential availability.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        force_refresh: { type: 'boolean', default: false, description: 'Rescan the network instead of using cached results.' }
      }
    },
    annotations: readOnlyAnnotations,
    handler: async raw => {
      const args = validateToolArgs(raw, ['force_refresh'], []);
      const force = booleanArg(args, 'force_refresh', false);
      // Cached scan unless force_refresh, then each device with its saved state.
      const devices = await scanNetwork(force);
      const cfg = configRead();
      const decorated = devices.map(d => {
        const dec = decorateDevice(d, cfg);
        return {
          device_id: deviceKey(dec.host, dec.mac),
          host: dec.host,
          name: dec.name,
          mac: dec.mac,
          pi: dec.pi,
          ssh: dec.ssh,
          ctrlpi: dec.ctrlpi,
          model: dec.model,
          version: dec.version,
          os: dec.os,
          username: dec.username,
          saved_credentials: dec.saved
        };
      });
      return mcpToolResult({ devices: decorated });
    }
  },
  {
    name: 'pi_device_info',
    title: 'Get detailed device information',
    description: 'Get detailed hardware model, operating system, storage, memory, uptime, and ctrlPi information for a device.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        device_id: deviceIdProperty
      },
      required: ['device_id']
    },
    annotations: readOnlyAnnotations,
    handler: async raw => {
      const args = validateToolArgs(raw, ['device_id'], ['device_id']);
      const deviceId = stringArg(args, 'device_id');
      const session = await getDeviceSession(deviceId);

      // One SSH call prints every section under a ===NAME=== marker.
      const infoScript = `
echo "===MODEL==="
if [ -r /proc/device-tree/model ]; then tr -d '\\000' </proc/device-tree/model; elif [ -r /sys/firmware/devicetree/base/model ]; then tr -d '\\000' </sys/firmware/devicetree/base/model; fi
echo "===OS==="
if [ -r /etc/os-release ]; then . /etc/os-release; echo "\${PRETTY_NAME:-\$NAME \$VERSION}"; else uname -srm; fi
echo "===KERNEL==="
uname -r
echo "===HOSTNAME==="
hostname
echo "===UPTIME==="
uptime -p 2>/dev/null || cat /proc/uptime 2>/dev/null | awk '{print $1 " seconds"}'
echo "===STORAGE==="
df -h / | awk 'NR==2 {print $2 "|" $3 "|" $4 "|" $5}'
echo "===MEMORY==="
free -m 2>/dev/null | awk '/^Mem:/ {print $2 "|" $3 "|" $4}' || cat /proc/meminfo 2>/dev/null | awk '/MemTotal/ {t=$2} /MemAvailable/ {a=$2} END {print int(t/1024) "|" int((t-a)/1024) "|" int(a/1024)}'
`;
      const out = await execSSH(session.client, infoScript).catch(() => '');
      // Split the output into its sections by marker.
      const sections = {};
      let currentSection = null;
      for (const line of out.split('\n')) {
        const m = /^===([A-Z]+)===$/.exec(line.trim());
        if (m) {
          currentSection = m[1].toLowerCase();
          sections[currentSection] = [];
        } else if (currentSection) {
          sections[currentSection].push(line);
        }
      }

      const getSection = name => (sections[name] || []).join('\n').trim();
      const rawModel = getSection('model');
      // Short model name: drop the words Raspberry and Model.
      const model = rawModel ? rawModel.replace(/\bRaspberry\b/gi, '').replace(/\bModel\b/gi, '').replace(/\s+/g, ' ').trim() : null;

      // df prints total|used|available|percent for the root filesystem.
      const storageParts = getSection('storage').split('|');
      const storage = storageParts.length >= 4 ? {
        total: storageParts[0], used: storageParts[1], available: storageParts[2], percent: storageParts[3]
      } : null;

      // free prints total|used|free in megabytes.
      const memoryParts = getSection('memory').split('|');
      const memory = memoryParts.length >= 3 ? {
        total_mb: Number(memoryParts[0]) || null, used_mb: Number(memoryParts[1]) || null, free_mb: Number(memoryParts[2]) || null
      } : null;

      // The ctrlPi agent block when the device runs one.
      const ctrlpi = await ctrlPiConfig(session.host).catch(() => ({ model: null, version: null, os: null }));

      return mcpToolResult({
        device_id: deviceId,
        host: session.host,
        port: session.port,
        username: session.username,
        home: session.home,
        hostname: getSection('hostname') || null,
        model,
        os: getSection('os') || null,
        kernel: getSection('kernel') || null,
        uptime: getSection('uptime') || null,
        storage,
        memory,
        ctrlpi: ctrlpi.version ? ctrlpi : null
      });
    }
  },
  {
    name: 'pi_device_authenticate',
    title: 'Authenticate with a device',
    description: 'Authenticate to a Raspberry Pi or SSH device, verify credentials, cache the connection, and optionally save the password to the system keychain.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        device_id: deviceIdProperty,
        username: { type: 'string', description: 'SSH username (defaults to "pi").' },
        password: { type: 'string', description: 'SSH password.' },
        save_password: { type: 'boolean', description: 'Save password to macOS Keychain or Linux Secret Service.', default: false }
      },
      required: ['device_id', 'password']
    },
    annotations: additiveAnnotations,
    handler: async raw => {
      const args = validateToolArgs(raw, ['device_id', 'username', 'password', 'save_password'], ['device_id', 'password']);
      const deviceId = stringArg(args, 'device_id');
      const password = stringArg(args, 'password');
      const username = stringArg(args, 'username', { optional: true }) || 'pi';
      const savePassword = booleanArg(args, 'save_password', false);

      // Connect with the given credentials and read the remote $HOME.
      const device = resolveDevice(deviceId);
      const key = deviceKey(device.host, device.mac);
      const client = await connectSSH({ host: device.host, port: Number(device.port) || SSH_PORT, username, password });
      const home = (await execSSH(client, 'printf %s "$HOME"')).trim();
      if (!home.startsWith('/')) {
        client.end();
        throw new Error('Could not resolve remote home directory');
      }
      // Device model from the device tree, saved with the device.
      const rawModel = (await execSSH(client, "if [ -r /proc/device-tree/model ]; then tr -d '\\000' </proc/device-tree/model; elif [ -r /sys/firmware/devicetree/base/model ]; then tr -d '\\000' </sys/firmware/devicetree/base/model; fi").catch(() => '')).trim();
      const model = rawModel ? rawModel.replace(/\bRaspberry\b/gi, '').replace(/\bModel\b/gi, '').replace(/\s+/g, ' ').trim() : null;

      // Cache the connection for the other tools; drop it when it closes.
      const session = { client, host: device.host, port: Number(device.port) || SSH_PORT, username, home, lastUsed: Date.now() };
      client.on('close', () => mcpSessions.delete(key));
      client.on('error', () => mcpSessions.delete(key));
      mcpSessions.set(key, session);

      const cfg = configRead();
      const found = savedDevice(cfg, device);
      const saved = found.value;
      let credentialWarning = null;
      try {
        // Keep the password in the keychain only when asked, and remove any older entry.
        if (savePassword) {
          await keychainSet(key, password);
          if (found.key !== key) await keychainDelete(found.key);
        } else {
          await keychainDelete(found.key);
        }
        // The config file keeps the username and device info, never the password.
        cfg.devices[key] = { ...saved, host: device.host, mac: device.mac || saved.mac || '', username, saved: savePassword, model: model || saved.model || null };
        if (found.key !== key) delete cfg.devices[found.key];
        configWrite(cfg);
      // The connection still works when the keychain write fails: report it as a warning.
      } catch (e) {
        credentialWarning = 'Connected, but credentials could not be saved: ' + (e.message || String(e));
        cfg.devices[key] = { ...saved, host: device.host, mac: device.mac || saved.mac || '', username, saved: false, model: model || saved.model || null };
        if (found.key !== key) delete cfg.devices[found.key];
        try { configWrite(cfg); } catch {}
      }

      return mcpToolResult({
        device_id: deviceId,
        host: device.host,
        username,
        home,
        model,
        saved_credentials: savePassword && !credentialWarning,
        credential_warning: credentialWarning
      });
    }
  },
  {
    name: 'pi_command_run',
    title: 'Run a shell command on a device',
    description: 'Execute a shell command on the remote device via SSH. Returns stdout, stderr, and exit_code.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        device_id: deviceIdProperty,
        command: { type: 'string', description: 'Shell command line to execute.' },
        timeout_ms: { type: 'integer', description: 'Execution timeout in milliseconds (default 30000, max 300000).' }
      },
      required: ['device_id', 'command']
    },
    annotations: destructiveAnnotations,
    handler: async raw => {
      const args = validateToolArgs(raw, ['device_id', 'command', 'timeout_ms'], ['device_id', 'command']);
      const deviceId = stringArg(args, 'device_id');
      const command = stringArg(args, 'command', { allowEmpty: false });
      // Timeout clamped to 1 s .. 5 min.
      const timeoutMs = Math.min(Math.max(numberArg(args, 'timeout_ms', { optional: true, defaultValue: 30000 }), 1000), 300000);
      const session = await getDeviceSession(deviceId);
      // A non-zero exit marks the result as an error.
      const result = await execSSHCommand(session.client, command, timeoutMs);
      return mcpToolResult({
        device_id: deviceId,
        command,
        exit_code: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
        signal: result.signal
      }, !result.ok);
    }
  },
  {
    name: 'pi_files_list',
    title: 'List files on a device',
    description: 'List files and directories on the remote device relative to $HOME.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        device_id: deviceIdProperty,
        path: devicePathProperty,
        show_hidden: { type: 'boolean', default: false, description: 'Include hidden files (starting with .).' }
      },
      required: ['device_id']
    },
    annotations: readOnlyAnnotations,
    handler: async raw => {
      const args = validateToolArgs(raw, ['device_id', 'path', 'show_hidden'], ['device_id']);
      const deviceId = stringArg(args, 'device_id');
      const relPath = stringArg(args, 'path', { optional: true, allowEmpty: true }) || '';
      const showHidden = booleanArg(args, 'show_hidden', false);
      const session = await getDeviceSession(deviceId);
      // Paths are relative to $HOME; safeRelative() rejects '..'.
      const files = await listDirectory(session, relPath, showHidden);
      return mcpToolResult({
        device_id: deviceId,
        path: safeRelative(relPath),
        home: session.home,
        files
      });
    }
  },
  {
    name: 'pi_file_read',
    title: 'Read a file from a device',
    description: 'Read one file from the remote device relative to $HOME. auto returns UTF-8 text when safe and base64 for binary data.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        device_id: deviceIdProperty,
        path: devicePathProperty,
        encoding: { type: 'string', enum: ['auto', 'utf8', 'base64'], default: 'auto' }
      },
      required: ['device_id', 'path']
    },
    annotations: readOnlyAnnotations,
    handler: async raw => {
      const args = validateToolArgs(raw, ['device_id', 'path', 'encoding'], ['device_id', 'path']);
      const deviceId = stringArg(args, 'device_id');
      const file = safeRelative(stringArg(args, 'path'));
      const encoding = stringArg(args, 'encoding', { optional: true, values: ['auto', 'utf8', 'base64'] }) || 'auto';
      const session = await getDeviceSession(deviceId);
      const sftp = await sftpFor(session.client);
      const abs = remotePath(session.home, file);
      let buf;
      try {
        buf = await sftpCall(sftp, 'readFile', abs);
      } finally {
        sftp.end();
      }
      // auto: text when the bytes are UTF-8 text, otherwise base64.
      const text = encoding === 'base64' ? null : asText(buf);
      const binary = encoding === 'base64' || (encoding === 'auto' && text === null);
      return mcpToolResult({
        device_id: deviceId,
        path: file,
        size: buf.length,
        binary,
        encoding: binary ? 'base64' : 'utf8',
        content: binary ? buf.toString('base64') : (text === null ? buf.toString('utf8') : text)
      });
    }
  },
  {
    name: 'pi_file_write',
    title: 'Write a file to a device',
    description: 'Create or overwrite one file on the remote device relative to $HOME, creating missing parent directories. content may be UTF-8 text or base64 and is limited to 16 MB.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        device_id: deviceIdProperty,
        path: devicePathProperty,
        content: { type: 'string', description: 'File content (UTF-8 or base64).' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' }
      },
      required: ['device_id', 'path', 'content']
    },
    annotations: destructiveAnnotations,
    handler: async raw => {
      const args = validateToolArgs(raw, ['device_id', 'path', 'content', 'encoding'], ['device_id', 'path', 'content']);
      const deviceId = stringArg(args, 'device_id');
      const file = safeRelative(stringArg(args, 'path'));
      const content = stringArg(args, 'content', { allowEmpty: true });
      const encoding = stringArg(args, 'encoding', { optional: true, values: ['utf8', 'base64'] }) || 'utf8';
      // Decode the content and cap it at 16 MB.
      const buf = decodeMcpContent(content, encoding);
      if (buf.length > 16 * 1024 * 1024) throw new Error('content exceeds 16 MB limit');

      const session = await getDeviceSession(deviceId);
      const sftp = await sftpFor(session.client);
      const abs = remotePath(session.home, file);
      try {
        // Create missing parent folders before writing.
        const parentDir = path.dirname(abs);
        if (parentDir && parentDir !== session.home) {
          await ensureRemoteDirectory(sftp, session.home, safeRelative(path.dirname(file)));
        }
        await sftpCall(sftp, 'writeFile', abs, buf);
      } finally {
        sftp.end();
      }
      return mcpToolResult({
        device_id: deviceId,
        path: file,
        size: buf.length,
        ok: true
      });
    }
  },
  {
    name: 'pi_directory_create',
    title: 'Create a directory on a device',
    description: 'Create a directory on the remote device relative to $HOME.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        device_id: deviceIdProperty,
        path: devicePathProperty
      },
      required: ['device_id', 'path']
    },
    annotations: additiveAnnotations,
    handler: async raw => {
      const args = validateToolArgs(raw, ['device_id', 'path'], ['device_id', 'path']);
      const deviceId = stringArg(args, 'device_id');
      const dir = safeRelative(stringArg(args, 'path'));
      const session = await getDeviceSession(deviceId);
      const sftp = await sftpFor(session.client);
      try {
        // Creates every missing folder along the path.
        await ensureRemoteDirectory(sftp, session.home, dir);
      } finally {
        sftp.end();
      }
      return mcpToolResult({
        device_id: deviceId,
        path: dir,
        ok: true
      });
    }
  },
  {
    name: 'pi_path_rename',
    title: 'Rename or move a remote path',
    description: 'Rename or move one file or directory on the remote device relative to $HOME.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        device_id: deviceIdProperty,
        from: devicePathProperty,
        to: devicePathProperty
      },
      required: ['device_id', 'from', 'to']
    },
    annotations: destructiveAnnotations,
    handler: async raw => {
      const args = validateToolArgs(raw, ['device_id', 'from', 'to'], ['device_id', 'from', 'to']);
      const deviceId = stringArg(args, 'device_id');
      const fromRel = safeRelative(stringArg(args, 'from'));
      const toRel = safeRelative(stringArg(args, 'to'));
      const session = await getDeviceSession(deviceId);
      const sftp = await sftpFor(session.client);
      try {
        // Both ends stay inside $HOME.
        const fromAbs = remotePath(session.home, fromRel);
        const toAbs = remotePath(session.home, toRel);
        await sftpCall(sftp, 'rename', fromAbs, toAbs);
      } finally {
        sftp.end();
      }
      return mcpToolResult({
        device_id: deviceId,
        from: fromRel,
        to: toRel,
        ok: true
      });
    }
  },
  {
    name: 'pi_path_delete',
    title: 'Delete a remote path',
    description: 'Permanently delete one file or recursively delete one directory on the remote device relative to $HOME.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        device_id: deviceIdProperty,
        path: devicePathProperty
      },
      required: ['device_id', 'path']
    },
    annotations: destructiveAnnotations,
    handler: async raw => {
      const args = validateToolArgs(raw, ['device_id', 'path'], ['device_id', 'path']);
      const deviceId = stringArg(args, 'device_id');
      const rel = safeRelative(stringArg(args, 'path'));
      // $HOME itself can never be deleted.
      if (!rel) throw new Error('Cannot delete the root home directory');
      const session = await getDeviceSession(deviceId);
      await removeRemote(session, rel);
      return mcpToolResult({
        device_id: deviceId,
        path: rel,
        ok: true
      });
    }
  },
  {
    name: 'pi_device_reboot',
    title: 'Reboot a device',
    description: 'Reboot the remote Raspberry Pi or SSH device.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        device_id: deviceIdProperty
      },
      required: ['device_id']
    },
    annotations: destructiveAnnotations,
    handler: async raw => {
      const args = validateToolArgs(raw, ['device_id'], ['device_id']);
      const deviceId = stringArg(args, 'device_id');
      const session = await getDeviceSession(deviceId);
      // Fire and forget: the connection drops as the device goes down.
      execSSH(session.client, 'sudo reboot || reboot').catch(() => {});
      // Close every cached session to this host, so the next tool reconnects.
      for (const [k, s] of mcpSessions) {
        if (s.host === session.host) {
          try { s.client.end(); } catch {}
          mcpSessions.delete(k);
        }
      }
      return mcpToolResult({
        device_id: deviceId,
        status: 'rebooting',
        message: 'Reboot signal sent. The device is restarting.'
      });
    }
  },
  {
    // The page's "Install ctrlPi API": config.json first (so the installer asks nothing), then
    // install.sh, then the service when sudo needs no password.
    name: 'pi_ctrlpi_install',
    title: 'Install the ctrlPi API on a device',
    description: 'Install or update pi-gpio-api (the ctrlPi API agent) in ~/pi-gpio-api with its install.sh. On a first install, name and api_key are written to ~/pi-gpio-api/config.json (defaults: the device hostname and your-secret-key, the installer\'s own); an existing config.json is kept and they are ignored. A result with the default key carries a warning. On a Raspberry Pi with passwordless sudo the pi-gpio-api service is then created and started, or restarted; otherwise service is needs_sudo and output holds the sudo commands to run. Can take several minutes (the full package installs FastAPI). Ask the user first and pass confirmed: true.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        device_id: deviceIdProperty,
        package: { type: 'string', enum: ['lite', 'full'], default: 'lite', description: 'lite: the dependency-free server (recommended). full: FastAPI with /docs pages.' },
        name: { type: 'string', description: 'Agent name for a first install. Default: the device hostname.' },
        api_key: { type: 'string', description: 'Agent API key for a first install. Default: your-secret-key (public, so change it).' },
        confirmed: { type: 'boolean', description: 'Must be true after the user explicitly confirms the install.' }
      },
      required: ['device_id', 'confirmed']
    },
    annotations: destructiveAnnotations,
    handler: async raw => {
      const args = validateToolArgs(raw, ['device_id', 'package', 'name', 'api_key', 'confirmed'], ['device_id', 'confirmed']);
      const deviceId = stringArg(args, 'device_id');
      const pkg = stringArg(args, 'package', { optional: true, values: ['lite', 'full'] }) || 'lite';
      // The install needs an explicit confirmation from the user.
      if (args.confirmed !== true) throw new Error('confirmed must be true after explicit user confirmation');
      const session = await getDeviceSession(deviceId);

      // A first install writes config.json (the installer's defaults for a missing name or key);
      // an existing config.json is kept as it is.
      const sftp = await sftpFor(session.client);
      let keptConfig = false;
      let defaultKey = false;
      try {
        keptConfig = await sftpCall(sftp, 'stat', remotePath(session.home, 'pi-gpio-api/config.json')).then(() => true, () => false);
        if (!keptConfig) {
          // Name: given, or the device hostname without .local.
          const name = (stringArg(args, 'name', { optional: true }) || '').trim() ||
            (await execSSH(session.client, 'hostname')).trim().replace(/\.local$/, '');
          const key = (stringArg(args, 'api_key', { optional: true }) || '').trim() || CTRLPI_DEFAULT_KEY;
          defaultKey = key === CTRLPI_DEFAULT_KEY;
          if (!name) throw new Error('name is required: the device reports no hostname');
          if (/[\x00-\x1f\x7f]/.test(name + key)) throw new Error('name and api_key cannot contain control characters');
          await ensureRemoteDirectory(sftp, session.home, 'pi-gpio-api');
          await sftpCall(sftp, 'writeFile', remotePath(session.home, 'pi-gpio-api/config.json'),
            Buffer.from(JSON.stringify({ api_key: key, name }, null, 2) + '\n'));
        }
      } finally {
        sftp.end();
      }

      // Run install.sh (up to 10 minutes), then set up the service when it succeeds.
      const install = await execSSHCommand(session.client, CTRLPI_INSTALL_CMD(pkg), 600000);
      const output = (install.stdout + (install.stderr ? '\n' + install.stderr : '')).trim();
      let service = 'not_run';
      if (install.ok) {
        const started = await execSSHCommand(session.client, CTRLPI_SERVICE_CMD, 60000);
        service = started.stdout.trim().split('\n').pop() || ('failed: ' + started.stderr.trim());
      }
      return mcpToolResult({
        device_id: deviceId,
        ok: install.ok,
        package: pkg,
        kept_config: keptConfig,
        ...(defaultKey ? { warning: CTRLPI_DEFAULT_KEY_WARNING } : {}),
        exit_code: install.exit_code,
        service,
        // The end of the installer's output holds its result and, without sudo, the commands to run.
        output: output.length > 6000 ? '...' + output.slice(-6000) : output
      });
    }
  }
];

// Requests carrying the 2026-07-28 protocol in _meta get modern result envelopes; others use the legacy initialize flow.
function modernMcpRequest(msg) {
  return msg && msg.params && msg.params._meta &&
    msg.params._meta['io.modelcontextprotocol/protocolVersion'] === MCP_PROTOCOL;
}

// Adds the current MCP revision's result envelope and server info.
function completeMcpResult(result, modern) {
  if (!modern) return result;
  return {
    resultType: 'complete',
    ...result,
    _meta: { ...(result._meta || {}), 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
  };
}

// Answers one MCP JSON-RPC message (shared by stdio and HTTP); null for a notification.
async function dispatchMcp(msg) {
  const id = msg && msg.id;
  const isRequest = id !== undefined && id !== null;
  const ok = result => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message, data) => ({
    jsonrpc: '2.0', id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });

  // Only JSON-RPC 2.0; a notification (no id) never gets an answer.
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return isRequest ? fail(-32600, 'Invalid Request') : null;
  }
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  const metadata = params._meta && typeof params._meta === 'object' ? params._meta : {};
  const requestedVersion = metadata['io.modelcontextprotocol/protocolVersion'];
  const modern = msg.method === 'server/discover' || modernMcpRequest(msg);
  // A modern request names its protocol version and client capabilities in _meta.
  if (requestedVersion && requestedVersion !== MCP_PROTOCOL) {
    return isRequest ? fail(-32022, 'Unsupported protocol version', { supported: [MCP_PROTOCOL] }) : null;
  }
  if (modern && (!metadata['io.modelcontextprotocol/clientCapabilities'] ||
      typeof metadata['io.modelcontextprotocol/clientCapabilities'] !== 'object')) {
    return isRequest ? fail(-32602, 'Modern MCP requests require clientCapabilities metadata') : null;
  }
  try {
    if (msg.method === 'server/discover') {
      return ok({
        resultType: 'complete',
        supportedVersions: [MCP_PROTOCOL],
        capabilities: MCP_CAPABILITIES,
        instructions: 'Discover, inspect, manage files, run commands, and administer Raspberry Pis and SSH devices on the LAN. Call pi_devices_list to find available devices.',
        ttlMs: 300000,
        cacheScope: 'public',
        _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
      });
    }
    // Legacy clients: answer with their version when supported, else the newest legacy one.
    if (msg.method === 'initialize') {
      const requested = params.protocolVersion;
      const protocolVersion = MCP_LEGACY_PROTOCOLS.includes(requested) ? requested : MCP_LEGACY_PROTOCOLS[0];
      return ok({
        protocolVersion,
        capabilities: MCP_CAPABILITIES,
        serverInfo: MCP_SERVER_INFO,
        instructions: 'Call pi_devices_list to find available Raspberry Pis and SSH devices.',
      });
    }
    if (msg.method === 'ping') return ok(completeMcpResult({}, modern));
    if (msg.method === 'tools/list') {
      // The tool list without the handlers.
      const tools = MCP_TOOLS.map(({ handler, ...tool }) => tool);
      return ok(completeMcpResult({ tools, ttlMs: 300000, cacheScope: 'public' }, modern));
    }
    if (msg.method === 'tools/call') {
      if (typeof params.name !== 'string') return isRequest ? fail(-32602, 'Tool name is required') : null;
      const tool = MCP_TOOLS.find(entry => entry.name === params.name);
      if (!tool) return isRequest ? fail(-32602, 'Unknown tool: ' + params.name) : null;
      // A tool error becomes an isError result, not a JSON-RPC error.
      let result;
      try {
        result = await tool.handler(params.arguments || {});
      } catch (error) {
        result = mcpToolResult({ error: String(error.message || error) }, true);
      }
      return ok(completeMcpResult(result, modern));
    }
    return isRequest ? fail(-32601, 'Method not found: ' + msg.method) : null;
  } catch (error) {
    return isRequest ? fail(-32603, 'Internal error: ' + String(error.message || error)) : null;
  }
}

// MCP over stdio: one JSON-RPC message per line; logs go to stderr.
function runMcpStdio() {
  // stdout carries only JSON-RPC, so console output moves to stderr.
  console.log = (...values) => console.error(...values);
  console.info = (...values) => console.error(...values);
  const rl = readline.createInterface({ input: process.stdin });
  const active = new Set();
  let writes = Promise.resolve();
  const write = response => {
    if (!response) return;
    writes = writes.then(() => new Promise(resolve => {
      process.stdout.write(JSON.stringify(response) + '\n', resolve);
    }));
  };
  rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const task = dispatchMcp(msg).then(write).catch(error => {
      if (msg.id !== undefined && msg.id !== null) {
        write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error: ' + error.message } });
      }
    }).finally(() => active.delete(task));
    active.add(task);
  });
  rl.on('close', async () => {
    await Promise.allSettled([...active]);
    await writes;
    shutdown();
  });
}

// An MCP header value, decoding the =?base64?...?= form.
function decodeMcpHeader(value) {
  if (typeof value !== 'string') return null;
  const encoded = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(value);
  if (!encoded) return value;
  try { return Buffer.from(encoded[1], 'base64').toString('utf8'); }
  catch { return null; }
}

// True when a request has no Origin or one matching its Host.
function validMcpOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; }
  catch { return false; }
}

// Sends a JSON-RPC error over HTTP.
function mcpHttpError(res, status, id, code, message, data) {
  sendJSON(res, status, {
    jsonrpc: '2.0', id: id === undefined ? null : id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

let mcpHttpActive = 0;

// Streamable HTTP transport: one JSON-RPC message per POST, answered with plain JSON (no SSE).
async function handleMcpHttp(req, res) {
  if (!validMcpOrigin(req)) {
    mcpHttpError(res, 403, null, -32020, 'Invalid Origin header');
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' });
    res.end();
    return;
  }
  let msg;
  try { msg = JSON.parse((await readBody(req, MCP_MAX_BODY)).toString('utf8')); }
  catch (error) {
    const oversized = String(error.message || error) === 'Request too large' || String(error.message || error) === 'body too large';
    mcpHttpError(res, oversized ? 413 : 400, null, -32700, oversized ? 'Request body too large' : 'Parse error');
    return;
  }

  const version = req.headers['mcp-protocol-version'];
  const bodyVersion = msg && msg.params && msg.params._meta &&
    msg.params._meta['io.modelcontextprotocol/protocolVersion'];
  const modern = version === MCP_PROTOCOL || bodyVersion === MCP_PROTOCOL;
  if (modern) {
    const methodHeader = req.headers['mcp-method'];
    const nameHeader = decodeMcpHeader(req.headers['mcp-name']);
    const bodyName = msg && msg.params && (msg.params.name ?? msg.params.uri);
    if (version !== MCP_PROTOCOL || bodyVersion !== MCP_PROTOCOL || methodHeader !== msg.method ||
        (bodyName !== undefined && nameHeader !== bodyName) || (bodyName === undefined && req.headers['mcp-name'] !== undefined)) {
      mcpHttpError(res, 400, msg && msg.id, -32020, 'MCP request headers do not match the JSON-RPC body');
      return;
    }
  } else if ((version && !MCP_LEGACY_PROTOCOLS.includes(version)) ||
      (bodyVersion && !MCP_LEGACY_PROTOCOLS.includes(bodyVersion))) {
    mcpHttpError(res, 400, msg && msg.id, -32022, 'Unsupported protocol version', {
      supported: [MCP_PROTOCOL, ...MCP_LEGACY_PROTOCOLS],
    });
    return;
  }

  const toolCall = msg && msg.method === 'tools/call';
  if (toolCall && mcpHttpActive >= 8) {
    mcpHttpError(res, 429, msg.id, -32000, 'Too many concurrent MCP tool calls');
    return;
  }
  if (toolCall) mcpHttpActive++;
  let response;
  try { response = await dispatchMcp(msg); }
  finally { if (toolCall) mcpHttpActive--; }
  if (!response) {
    res.writeHead(202);
    res.end();
    return;
  }
  const unknownModernMethod = modern && response.error && response.error.code === -32601;
  sendJSON(res, unknownModernMethod ? 404 : 200, response);
}

// ── Routing ─────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost'); const p = url.pathname; const q = Object.fromEntries(url.searchParams);
  try {
    // Every route, MCP included, answers only requests addressed to an allowed host.
    if (!hostAllowed(req.headers.host, ALLOW_HOSTS)) {
      const name = String(req.headers.host || '').replace(/:\d+$/, '').slice(0, 100);
      return sendJSON(res, 403, { error: 'Host not allowed: ' + name + '. Open pi-bay by IP address, or start it with --allow-host ' + name });
    }
    if (p === '/mcp' && enableMcp) {
      await handleMcpHttp(req, res);
      return;
    }
    if (p === '/api/mcp') {
      if (req.method === 'GET') {
        return sendJSON(res, 200, { enabled: enableMcp });
      }
      if (req.method === 'POST') {
        if (!['0', '1'].includes(q.enabled)) {
          return sendJSON(res, 400, { error: 'enabled must be 0 or 1' });
        }
        enableMcp = q.enabled === '1';
        return sendJSON(res, 200, { enabled: enableMcp });
      }
    }
    // State-changing API requests must come from this page (same origin).
    if (p.startsWith('/api/') && !['GET','HEAD'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return sendJSON(res, 403, { error: 'Cross-origin request rejected' });
    }
    // The page, with its version filled in.
    if (p === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8').split('{{VERSION}}').join(VERSION));
    }
    // The ctrlPi icon for the browser tab.
    if (p === '/favicon.ico') {
      res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'public, max-age=86400' });
      return fs.createReadStream(path.join(__dirname, 'favicon.ico')).pipe(res);
    }
    // xterm.js for the Terminal tab, served from node_modules.
    if (p.startsWith('/vendor/')) {
      const vendor = { '/vendor/xterm.js': '@xterm/xterm/lib/xterm.js', '/vendor/xterm.css': '@xterm/xterm/css/xterm.css' }[p];
      if (!vendor) throw new Error('Not found');
      const file = require.resolve(vendor);
      res.writeHead(200, { 'Content-Type': p.endsWith('.css') ? 'text/css' : 'text/javascript' });
      return fs.createReadStream(file).pipe(res);
    }
    if (p === '/api/readme') {
      const content = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
      if (req.headers.accept && req.headers.accept.includes('application/json')) {
        return sendJSON(res, 200, { text: content });
      }
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(content);
    }
    // The scan results at once (refresh=1 rescans).
    if (p === '/api/devices') {
      const devices = await scanNetwork(q.refresh === '1');
      const cfg = configRead();
      return sendJSON(res, 200, { devices: devices.map(d => decorateDevice(d, cfg)), mcpEnabled: enableMcp });
    }
    // The scan as it runs: one JSON line per device, then a done line.
    if (p === '/api/devices/stream') {
      const cfg = configRead();
      let closed = false;
      res.on('close', () => { closed = true });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      try {
        const devices = await scanNetwork(q.refresh === '1', d => { if (!closed) res.write(JSON.stringify({ device: decorateDevice(d, cfg) }) + '\n') });
        if (!closed) res.end(JSON.stringify({ done: true, count: devices.length, mcpEnabled: enableMcp }) + '\n');
      } catch (e) { if (!closed) res.end(JSON.stringify({ error: e.message || String(e) }) + '\n'); }
      return;
    }
    // Signs in over SSH (the given password, else the saved one) and starts a session.
    if (p === '/api/connect' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const key = deviceKey(body.host, body.mac);
      const cfg = configRead();
      const found = savedDevice(cfg, body), saved = found.value;
      const username = body.username || saved.username || 'pi';
      const password = body.password || (saved.saved ? await keychainGet(found.key) : null);
      if (!password) return sendJSON(res, 401, { error: 'Password required' });
      const client = await connectSSH({ host: body.host, port: Number(body.port) || SSH_PORT, username, password });
      const home = (await execSSH(client, 'printf %s "$HOME"')).trim();
      if (!home.startsWith('/')) { client.end(); throw new Error('Could not resolve the remote home directory'); }
      // The board model, RAM and SD size, saved for the device pills.
      const rawModel = (await execSSH(client, "if [ -r /proc/device-tree/model ]; then tr -d '\\000' </proc/device-tree/model; elif [ -r /sys/firmware/devicetree/base/model ]; then tr -d '\\000' </sys/firmware/devicetree/base/model; fi").catch(() => '')).trim();
      const model = rawModel ? rawModel.replace(/\bRaspberry\b/gi, '').replace(/\bModel\b/gi, '').replace(/\s+/g, ' ').trim() : null;
      const hwRaw = (await execSSH(client, "awk '/MemTotal/ {m=int($2/1024); if (m>=900) printf \"%.0fGB RAM\", (m+128)/1024; else printf \"%dMB RAM\", m}' /proc/meminfo 2>/dev/null; echo '---'; df -h / 2>/dev/null | awk 'NR==2 {print $2 \" SD\"}'").catch(() => '')).trim();
      let hwRam = null, hwDisk = null;
      if (hwRaw) { const [rPart, dPart] = hwRaw.split('---').map(s => s.trim()); if (rPart) hwRam = rPart; if (dPart) hwDisk = dPart; }
      const token = crypto.randomBytes(24).toString('hex');
      sessions.set(token, { client, host: body.host, port: Number(body.port) || SSH_PORT, username, home, lastUsed: Date.now() });
      client.on('close', () => sessions.delete(token));
      // Save the device (and the password, when asked); a keychain failure still signs in, with a warning.
      let credentialWarning = null;
      try {
        if (body.savePassword) { await keychainSet(key, password); if (found.key !== key) await keychainDelete(found.key); } else await keychainDelete(found.key);
        cfg.devices[key] = {
          ...saved, host: body.host, mac: body.mac || saved.mac || '', username, saved: !!body.savePassword,
          model: model || saved.model || null, ram: hwRam || saved.ram || null, flash: hwDisk || saved.flash || null
        };
        if (found.key !== key) delete cfg.devices[found.key];
        configWrite(cfg);
      }
      catch (e) {
        credentialWarning = 'Connected, but credentials could not be saved: ' + (e.message || String(e));
        cfg.devices[key] = {
          ...saved, host: body.host, mac: body.mac || saved.mac || '', username, saved: false,
          model: model || saved.model || null, ram: hwRam || saved.ram || null, flash: hwDisk || saved.flash || null
        };
        if (found.key !== key) delete cfg.devices[found.key];
        try { configWrite(cfg) } catch {}
      }
      return sendJSON(res, 200, { token, home, username, model, ram: hwRam || saved.ram || null, flash: hwDisk || saved.flash || null, credentialWarning });
    }
    // Everything below needs a signed-in session (the X-Pi-Session header, or ?session= for downloads).
    const authedRoutes = ['/api/disconnect', '/api/reboot', '/api/usb-power', '/api/zip', '/api/restore', '/api/files', '/api/file', '/api/mkdir', '/api/touch', '/api/rename'];
    if (authedRoutes.includes(p)) {
      const session = getSession(req.headers['x-pi-session'] || q.session);
      if (p === '/api/disconnect' && req.method === 'POST') {
        session.client.end();
        sessions.delete(req.headers['x-pi-session']);
        return sendJSON(res, 200, { ok: true });
      }
      // The reboot drops the connection, so its result is not awaited.
      if (p === '/api/reboot' && req.method === 'POST') {
        execSSH(session.client, 'sudo reboot || reboot').catch(() => {});
        return sendJSON(res, 200, { ok: true });
      }
      // For Toggle Pi USB Power: is uhubctl installed, and does the Pi boot from USB?
      if (p === '/api/usb-power' && req.method === 'GET') {
        const [installed, root = ''] = (await execSSH(session.client, USB_POWER_CHECK_CMD)).trim().split('\n');
        return sendJSON(res, 200, { uhubctl: installed === '1', usbRoot: root.startsWith('/dev/sd') });
      }
      // A folder as a ZIP download (the home folder without ?path=).
      if (p === '/api/zip' && req.method === 'GET') {
        const sftp = await sftpFor(session.client);
        try {
          const list = await collectFiles(sftp, session.home, safeRelative(q.path || ''));
          const zip = createZipBuffer(list);
          const baseName = (q.path ? path.basename(q.path) : (session.host || 'pi')).replace(/[^a-zA-Z0-9_-]/g, '_');
          const zipName = `${baseName}_${new Date().toISOString().slice(0, 10)}.zip`;
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${zipName}"`,
            'Content-Length': zip.length,
            'Cache-Control': 'no-store'
          });
          return res.end(zip);
        } finally {
          sftp.end();
        }
      }
      // One folder's entries.
      if (p === '/api/files') return sendJSON(res, 200, {
        files: await listDirectory(session, q.path || '', q.showHidden === '1' || q.showHidden === 'true'),
        path: safeRelative(q.path || ''),
        home: session.home
      });
      // A file: as a download with ?download=1, else as JSON with its text (empty for a binary file).
      if (p === '/api/file' && req.method === 'GET') {
        const sftp = await sftpFor(session.client);
        const abs = remotePath(session.home, q.path);
        const data = await sftpCall(sftp, 'readFile', abs);
        sftp.end();
        if (q.download === '1') {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${path.basename(abs).replace(/"/g, '')}"` });
          return res.end(data);
        }
        const text = data.includes(0) ? null : data.toString('utf8');
        return sendJSON(res, 200, { path: safeRelative(q.path), size: data.length, binary: text === null || text.includes('\0'), text: text || '' });
      }
      if (p === '/api/file' && ['PUT','POST'].includes(req.method)) {
        // Stream the body straight to SFTP, creating missing parent folders.
        const rel = safeRelative(q.path);
        const dir = path.posix.dirname(rel);
        const sftp = await sftpFor(session.client);
        try {
          await ensureRemoteDirectory(sftp, session.home, dir === '.' ? '' : dir);
          let size = 0;
          req.on('data', chunk => { size += chunk.length; });
          await new Promise((resolve, reject) => {
            const out = sftp.createWriteStream(remotePath(session.home, rel));
            out.on('close', resolve);
            out.on('error', reject);
            req.on('error', reject);
            req.pipe(out);
          });
          return sendJSON(res, 200, { ok: true, size });
        } finally { sftp.end(); }
      }
      // Extracts an uploaded ZIP (up to 64 MB) into the home folder, or into ?path=.
      if (p === '/api/restore' && req.method === 'POST') {
        const entries = parseZipBuffer(await readBody(req, 64 * 1024 * 1024));
        const base = safeRelative(q.path || '');
        const sftp = await sftpFor(session.client);
        try {
          for (const entry of entries) {
            const rel = base ? base + '/' + entry.path : entry.path;
            const dir = path.posix.dirname(rel);
            await ensureRemoteDirectory(sftp, session.home, dir === '.' ? '' : dir);
            await sftpCall(sftp, 'writeFile', remotePath(session.home, rel), entry.content);
          }
        } finally { sftp.end(); }
        return sendJSON(res, 200, { ok: true, restored: entries.length });
      }
      // Delete (recursively for a folder), new folder, new empty file, rename or move.
      if (p === '/api/file' && req.method === 'DELETE') {
        await removeRemote(session, q.path);
        return sendJSON(res, 200, { ok: true });
      }
      if (p === '/api/mkdir' && req.method === 'POST') {
        const sftp = await sftpFor(session.client);
        await sftpCall(sftp, 'mkdir', remotePath(session.home, q.path));
        sftp.end();
        return sendJSON(res, 200, { ok: true });
      }
      if (p === '/api/touch' && req.method === 'POST') {
        const sftp = await sftpFor(session.client);
        await sftpCall(sftp, 'writeFile', remotePath(session.home, q.path), Buffer.alloc(0));
        sftp.end();
        return sendJSON(res, 200, { ok: true });
      }
      if (p === '/api/rename' && req.method === 'POST') {
        const sftp = await sftpFor(session.client);
        await sftpCall(sftp, 'rename', remotePath(session.home, q.path), remotePath(session.home, q.to));
        sftp.end();
        return sendJSON(res, 200, { ok: true });
      }
    }
    res.writeHead(404);
    res.end('Not found');
  } catch (e) {
    // A missing session is 401, so the page asks to sign in again; anything else is 500.
    if (!res.headersSent) sendJSON(res, e.message === 'Not connected' ? 401 : 500, { error: e.message || String(e) });
    else res.end();
  }
});

// The Terminal tab: a WebSocket at /terminal?session=, for an allowed host and a signed-in session only.
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname !== '/terminal' || !hostAllowed(req.headers.host, ALLOW_HOSTS)) return socket.destroy();
  const s = sessions.get(u.searchParams.get('session'));
  if (!s) return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req, s));
});
// Joins the socket to an SSH shell: output goes to the page; the page sends { type: 'data' } keystrokes
// and { type: 'resize' } sizes.
wss.on('connection', (ws, req, session) => {
  session.client.shell({ term: 'xterm-256color', cols: 100, rows: 30 }, (err, stream) => {
    if (err) { ws.close(1011, err.message); return; }
    stream.on('data', d => ws.readyState === 1 && ws.send(d));
    stream.stderr.on('data', d => ws.readyState === 1 && ws.send(d));
    stream.on('close', () => ws.close());
    ws.on('message', raw => {
      try {
        const m = JSON.parse(raw);
        if (m.type === 'data') stream.write(m.data);
        else if (m.type === 'resize') stream.setWindow(m.rows, m.cols, 0, 0);
      } catch {}
    });
    ws.on('close', () => stream.end());
  });
});
// Close web and MCP SSH sessions idle for 30 minutes.
setInterval(()=>{
  const cutoff=Date.now()-30*60*1000;
  for (const [t,s] of sessions) if(s.lastUsed<cutoff){ try { s.client.end(); } catch {} sessions.delete(t); }
  for (const [k,s] of mcpSessions) if(s.lastUsed<cutoff){ try { s.client.end(); } catch {} mcpSessions.delete(k); }
},60000).unref();

// Closes every SSH connection and the server, then exits.
function shutdown() {
  for (const s of sessions.values()) { try { s.client.end(); } catch {} }
  for (const s of mcpSessions.values()) { try { s.client.end(); } catch {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 1500).unref();
}

if (require.main === module) {
  // Refuse conflicting MCP flags, run stdio MCP alone, or start the web server.
  if (conflictingMcpFlags) {
    console.error('--no-mcp cannot be used with --mcp-stdio or --mcp-http');
    process.exit(1);
  } else if (mcpStdio && cliMcpHttp) {
    console.error('Choose one MCP transport: --mcp-stdio or --mcp-http');
    process.exit(1);
  } else if (mcpStdio) {
    runMcpStdio();
  } else {
    // The web UI (and /mcp when enabled); the browser opens except on a Pi or with --no-open.
    server.listen(PORT, HOST, () => {
      const url = `http://${HOST}:${PORT}`;
      console.log(`pi-bay: ${url}`);
      if (enableMcp) console.log(`mcp: ${url}/mcp`);
      if (shouldOpenBrowser(noOpen, RASPBERRY_PI_HOST)) openBrowser(url);
    });
  }
  // Ctrl-C and service stops close the SSH sessions first.
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Exported for the tests.
module.exports = {
  server,
  shutdown,
  sessions,
  mcpSessions,
  dispatchMcp,
  handleMcpHttp,
  runMcpStdio,
  MCP_TOOLS,
  selectMcpTransports,
  hostAllowed,
  isRaspberryPi,
  resolveDevice,
  getDeviceSession,
  connectSSH,
  setMcpHttp(enabled) { enableMcp = !!enabled; },
  getMcpHttp() { return enableMcp; },
  // Internals the tests reach into.
  _test: {
    localIPv4,
    savedDevice,
    decorateDevice,
    setScanCache(cache) { scanCache = cache; },
    clearMcpSessions() {
      for (const s of mcpSessions.values()) {
        try { s.client.end(); } catch {}
      }
      mcpSessions.clear();
    }
  }
};
