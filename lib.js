// Pure helpers shared by the server and tests: remote path safety, device identity, ZIP create/parse, board specs.
'use strict';

const path = require('path').posix;
const zlib = require('zlib');

// MAC address prefixes (OUIs) registered to Raspberry Pi.
const PI_OUIS = new Set(['b8:27:eb','dc:a6:32','e4:5f:01','28:cd:c1','d8:3a:dd','2c:cf:67','3a:35:41','88:a2:9e','ba:fb:b3']);

// A MAC address in lower case with two-digit parts (a:b:... becomes 0a:0b:...).
function normalizeMac(mac = '') {
  const parts = mac.toLowerCase().split(':');
  return parts.length === 6 && parts.every(p => /^[0-9a-f]{1,2}$/.test(p))
    ? parts.map(p => p.padStart(2, '0')).join(':') : mac.toLowerCase();
}

// True for a Raspberry Pi MAC prefix or a raspberrypi* hostname.
function isPi(mac, name = '') {
  return PI_OUIS.has(normalizeMac(mac).slice(0, 8)) || name.toLowerCase().startsWith('raspberrypi');
}

// A path relative to $HOME, refusing empty parts, '.', '..' and NUL.
function safeRelative(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid path');
  const clean = value.replace(/^\/+/, '');
  if (!clean || clean === '.') return '';
  if (clean.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Invalid path');
  return clean;
}

// The absolute remote path of a $HOME-relative path; throws if it would leave $HOME.
function remotePath(home, value) {
  const rel = safeRelative(value);
  const root = path.resolve('/', home);
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + '/')) throw new Error('Path escapes home directory');
  return target;
}

// The key a device is saved under: its MAC, or its IP when there is none.
function deviceKey(host, mac) {
  return normalizeMac(mac || '') || host;
}

// A MAC answering for several IPs (mesh node or range extender proxy ARP) is not a device identity,
// so it is dropped and those devices are keyed by IP.
function uniqueMacs(arp, shared = new Set()) {
  const ips = new Map();
  for (const [ip, mac] of Object.entries(arp)) ips.set(mac, (ips.get(mac) || 0) + 1);
  for (const [mac, count] of ips) if (count > 1) shared.add(mac);
  const out = {};
  for (const [ip, mac] of Object.entries(arp)) if (!shared.has(mac)) out[ip] = mac;
  return out;
}

// A version without a leading 'v'.
function cleanVersion(v) {
  return String(v || '').replace(/^v(?=\d)/i, '');
}

// Splits a model name into the device pill text and the rest ("Rev 1.1", "with ..."); tidies ESP32 names.
function modelParts(model, fallback) {
  if (!model) return { pill: fallback, suffix: '' };
  const m = String(model).match(/^(.*?)(\s+(?:Rev|with)\b.*)$/i);
  let pill = m ? m[1].trim() : String(model).trim();
  let suffix = m ? m[2].trim() : '';
  if (/\bESP32/i.test(pill) || /\bESP32/i.test(model)) {
    pill = pill.replace(/^Generic\s+/i, '').replace(/\s+module$/i, '').trim();
    pill = pill.replace(/^ESP32-?([A-Z]\d+)$/i, (_, variant) => `ESP32-${variant.toUpperCase()}`);
    pill = pill.replace(/^esp32$/i, 'ESP32');
    if (/^with\s+ESP32(?:[A-Z0-9_-]+)?$/i.test(suffix)) {
      suffix = '';
    }
  }
  return { pill, suffix };
}

// The CRC-32 checksum a ZIP entry stores.
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// A standard uncompressed (Store) ZIP of [{ path, content, mtime }].
function createZipBuffer(entries) {
  const parts = [];
  const centralRecords = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.path, 'utf8');
    const dataBuf = Buffer.isBuffer(entry.content)
      ? entry.content
      : typeof entry.content === 'string'
      ? Buffer.from(entry.content, 'utf8')
      : Buffer.alloc(0);
    const crc = crc32(dataBuf);
    const size = dataBuf.length;
    let dt = entry.mtime ? new Date(entry.mtime * 1000) : new Date();
    if (!Number.isFinite(dt.getTime()) || dt.getFullYear() < 1980) dt = new Date();
    const dosTime = ((dt.getHours() & 0x1f) << 11) | ((dt.getMinutes() & 0x3f) << 5) | ((dt.getSeconds() >> 1) & 0x1f);
    const dosDate = (((dt.getFullYear() - 1980) & 0x7f) << 9) | (((dt.getMonth() + 1) & 0x0f) << 5) | (dt.getDate() & 0x1f);

    const lhdr = Buffer.alloc(30);
    lhdr.writeUInt32LE(0x04034b50, 0);
    lhdr.writeUInt16LE(20, 4);
    lhdr.writeUInt16LE(0, 6);
    lhdr.writeUInt16LE(0, 8);
    lhdr.writeUInt16LE(dosTime, 10);
    lhdr.writeUInt16LE(dosDate, 12);
    lhdr.writeUInt32LE(crc, 14);
    lhdr.writeUInt32LE(size, 18);
    lhdr.writeUInt32LE(size, 22);
    lhdr.writeUInt16LE(nameBuf.length, 26);
    lhdr.writeUInt16LE(0, 28);
    parts.push(lhdr, nameBuf, dataBuf);

    const chdr = Buffer.alloc(46);
    chdr.writeUInt32LE(0x02014b50, 0);
    chdr.writeUInt16LE(20, 4);
    chdr.writeUInt16LE(20, 6);
    chdr.writeUInt16LE(0, 8);
    chdr.writeUInt16LE(0, 10);
    chdr.writeUInt16LE(dosTime, 12);
    chdr.writeUInt16LE(dosDate, 14);
    chdr.writeUInt32LE(crc, 16);
    chdr.writeUInt32LE(size, 20);
    chdr.writeUInt32LE(size, 24);
    chdr.writeUInt16LE(nameBuf.length, 28);
    chdr.writeUInt16LE(0, 30);
    chdr.writeUInt16LE(0, 32);
    chdr.writeUInt16LE(0, 34);
    chdr.writeUInt16LE(0, 36);
    chdr.writeUInt32LE(0x81a40000, 38);
    chdr.writeUInt32LE(offset, 42);
    centralRecords.push(chdr, nameBuf);

    offset += 30 + nameBuf.length + size;
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const buf of centralRecords) {
    centralSize += buf.length;
    parts.push(buf);
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  parts.push(eocd);

  return Buffer.concat(parts);
}

// Parse Store and Deflate ZIP entries for restore, with strict safety limits.
// Every entry path must already be a clean relative path (see safeRelative).
function parseZipBuffer(buf, { maxFiles = 4096, maxTotal = 256 * 1024 * 1024 } = {}) {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Invalid ZIP: end record not found');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  if (count > maxFiles) throw new Error(`ZIP contains too many files (maximum ${maxFiles})`);
  const entries = [];
  const names = new Set();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new Error('Invalid ZIP central directory');
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const expectedCrc = buf.readUInt32LE(at + 16);
    const compressedSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const rawName = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    at += 46 + nameLen + extraLen + commentLen;
    if (rawName.endsWith('/')) continue;
    if (flags & 1) throw new Error('Encrypted ZIP files are not supported');
    if (method !== 0 && method !== 8) throw new Error('Unsupported ZIP compression method: ' + method);
    if (method === 0 && compressedSize !== size) throw new Error('Invalid stored ZIP entry');
    if (size > maxTotal - total) throw new Error(`ZIP contents exceed ${Math.round(maxTotal / 1048576)} MiB`);
    let file;
    try { file = safeRelative(rawName); } catch { file = ''; }
    if (!file || file !== rawName || names.has(file)) throw new Error('Invalid ZIP path: ' + rawName);
    if (localAt + 30 > buf.length || buf.readUInt32LE(localAt) !== 0x04034b50) throw new Error('Invalid ZIP entry: ' + file);
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    if (dataAt + compressedSize > buf.length) throw new Error('Truncated ZIP entry: ' + file);
    const compressed = buf.subarray(dataAt, dataAt + compressedSize);
    let content;
    if (method === 0) {
      content = compressed;
    } else {
      try { content = zlib.inflateRawSync(compressed, { maxOutputLength: size + 1 }); }
      catch { throw new Error('Could not decompress ZIP entry: ' + file); }
      if (content.length !== size) throw new Error('ZIP size mismatch: ' + file);
    }
    if (crc32(content) !== expectedCrc) throw new Error('ZIP checksum failed: ' + file);
    total += size;
    names.add(file);
    entries.push({ path: file, content });
  }
  if (!entries.length) throw new Error('ZIP contains no files');
  return entries;
}

// True when this host is a Raspberry Pi (Linux with a Raspberry Pi device-tree model).
function isRaspberryPi(platform = process.platform, model = null) {
  if (platform !== 'linux') return false;
  if (model === null) {
    try { model = require('fs').readFileSync('/proc/device-tree/model', 'utf8'); }
    catch { return false; }
  }
  return /raspberry pi/i.test(String(model));
}

// True for an environment value of 1, true or yes.
function envEnabled(val) {
  return ['1', 'true', 'yes'].includes(String(val || '').toLowerCase());
}

// Which MCP transports run: flags win over the environment, --no-mcp turns both off,
// and a Raspberry Pi gets HTTP unless stdio was chosen.
function selectMcpTransports(options) {
  if (options.noMcp) return { stdio: false, http: false };
  const cliTransport = options.cliStdio || options.cliHttp;
  const stdio = cliTransport ? options.cliStdio : envEnabled(options.envStdio);
  const http = cliTransport ? options.cliHttp :
    envEnabled(options.envHttp) || (options.raspberryPiHost && !stdio);
  return { stdio, http };
}

// A browser opens on start unless --no-open was given or the host is a Raspberry Pi.
function shouldOpenBrowser(disabled, raspberryPiHost) {
  return !disabled && !raspberryPiHost;
}

// The buffer as UTF-8 text, or null when it looks binary.
function asText(buf) {
  if (buf.includes(0)) return null;
  const text = buf.toString('utf8');
  if (text.includes('\uFFFD')) return null;
  if (/[\x01-\x08\x0e-\x1f]/.test(text)) return null;
  return text;
}

// File content from an MCP call as a Buffer, from UTF-8 or checked base64.
function decodeMcpContent(content, encoding) {
  if (encoding === 'utf8') return Buffer.from(content, 'utf8');
  if (content.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) {
    throw new Error('content is not valid base64');
  }
  return Buffer.from(content, 'base64');
}

// Fill RAM, flash, revision, chip, and clock for display, using the board family's typical values where unknown.
function hardwareSpecs(d) {
  if (!d) return { ram: null, flash: null, revision: null, package: null, frequency: null };
  const model = String(d.model || '');
  const type = d.type || (d.model && /ESP32/i.test(d.model) ? 'ESP32' : d.model && /Pico/i.test(d.model) ? 'Pico' : 'Pi');
  let ram = d.ram || null;
  let flash = d.flash || d.sd || null;
  let revision = d.revision || null;
  let pkg = d.package || null;
  let frequency = d.frequency || null;

  if (!revision) {
    const revMatch = model.match(/\bRev\s+([0-9a-z.]+)/i);
    if (revMatch) revision = 'Rev ' + revMatch[1];
  }

  if (type === 'Pico' || /Pico/i.test(model)) {
    const isPico2 = /RP2350|Pico\s*2/i.test(model);
    if (!ram) ram = isPico2 ? '520KB RAM' : '264KB RAM';
    if (!flash) flash = isPico2 ? '4MB Flash' : '2MB Flash';
    if (!frequency) frequency = isPico2 ? '150MHz' : '133MHz';
    if (!pkg) pkg = isPico2 ? 'RP2350' : 'RP2040';
  } else if (type === 'ESP32' || /ESP32/i.test(model)) {
    if (/ESP32-?S3/i.test(model)) {
      if (!ram) ram = '512KB RAM';
      if (!flash) flash = '8MB Flash';
      if (!frequency) frequency = '240MHz';
      if (!pkg) pkg = 'Xtensa LX7';
    } else if (/ESP32-?C3/i.test(model)) {
      if (!ram) ram = '400KB RAM';
      if (!flash) flash = '4MB Flash';
      if (!frequency) frequency = '160MHz';
      if (!pkg) pkg = 'RISC-V';
    } else if (/ESP32-?S2/i.test(model)) {
      if (!ram) ram = '320KB RAM';
      if (!flash) flash = '4MB Flash';
      if (!frequency) frequency = '240MHz';
      if (!pkg) pkg = 'Xtensa LX7';
    } else {
      if (!ram) ram = '520KB RAM';
      if (!flash) flash = '4MB Flash';
      if (!frequency) frequency = '240MHz';
      if (!pkg) pkg = 'Xtensa LX6';
    }
  } else if (type === 'Pi' || d.pi) {
    if (!ram) {
      if (/Zero\s*2\s*W/i.test(model)) ram = '512MB RAM';
      else if (/Zero/i.test(model)) ram = '512MB RAM';
      else if (/Model\s*A\b|1\s*A\b/i.test(model)) ram = '256MB RAM';
      else if (/3\s*A\+/i.test(model)) ram = '512MB RAM';
      else if (/3\s*B\b|3\s*B\+/i.test(model)) ram = '1GB RAM';
      else if (/2\s*B\b/i.test(model)) ram = '1GB RAM';
    }
    if (!frequency) {
      if (/Pi\s*5/i.test(model)) frequency = '2.4GHz';
      else if (/Pi\s*4/i.test(model)) frequency = '1.5GHz';
      else if (/3\s*B\+/i.test(model)) frequency = '1.4GHz';
      else if (/3\s*B\b/i.test(model)) frequency = '1.2GHz';
      else if (/Zero\s*2/i.test(model)) frequency = '1.0GHz';
      else if (/Zero/i.test(model)) frequency = '1.0GHz';
    }
  }

  if (ram && !/RAM/i.test(String(ram))) ram = String(ram).trim() + ' RAM';
  if (flash && !/Flash|SD/i.test(String(flash))) flash = String(flash).trim() + (type === 'Pi' || d.pi ? ' SD' : ' Flash');
  if (frequency && !/Hz$/i.test(String(frequency))) frequency = String(frequency).trim() + 'MHz';

  return { ram, flash, revision, package: pkg, frequency };
}

module.exports = {
  PI_OUIS,
  normalizeMac,
  isPi,
  safeRelative,
  remotePath,
  deviceKey,
  uniqueMacs,
  cleanVersion,
  modelParts,
  hardwareSpecs,
  crc32,
  createZipBuffer,
  parseZipBuffer,
  isRaspberryPi,
  envEnabled,
  selectMcpTransports,
  shouldOpenBrowser,
  asText,
  decodeMcpContent
};
