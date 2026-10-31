'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
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
} = require('../lib');

test('normalizes and identifies Pi MAC addresses', () => {
  assert.equal(normalizeMac('b8:27:eb:1:2:3'), 'b8:27:eb:01:02:03');
  assert.equal(normalizeMac('DC:A6:32:4:5:6'), 'dc:a6:32:04:05:06');
  assert.equal(normalizeMac('not-a-mac'), 'not-a-mac');
  assert.equal(normalizeMac(''), '');

  // Known Raspberry Pi OUIs
  assert.equal(isPi('b8:27:eb:01:02:03', 'host'), true);
  assert.equal(isPi('DC:A6:32:00:00:01', 'host'), true);
  assert.equal(isPi('e4:5f:01:11:22:33', 'host'), true);
  assert.equal(isPi('28:cd:c1:44:55:66', 'host'), true);
  assert.equal(isPi('d8:3a:dd:77:88:99', 'host'), true);
  assert.equal(isPi('2c:cf:67:aa:bb:cc', 'host'), true);
  assert.equal(isPi('3a:35:41:dd:ee:ff', 'host'), true);
  assert.equal(isPi('88:a2:9e:01:02:03', 'host'), true);
  assert.equal(isPi('BA:FB:B3:12:34:56', 'host'), true);

  // Hostname matching
  assert.equal(isPi('', 'raspberrypi'), true);
  assert.equal(isPi('', 'raspberrypi-office'), true);
  assert.equal(isPi('', 'RaspberryPi-LivingRoom'), true);

  // Non-Pi
  assert.equal(isPi('00:11:22:33:44:55', 'desktop'), false);
  assert.equal(isPi('', 'debian-server'), false);
  assert.equal(isPi('', ''), false);
});

test('contains remote paths inside home', () => {
  assert.equal(safeRelative('/docs/a.txt'), 'docs/a.txt');
  assert.equal(safeRelative('docs/a.txt'), 'docs/a.txt');
  assert.equal(safeRelative('file.txt'), 'file.txt');
  assert.equal(safeRelative(''), '');
  assert.equal(safeRelative('.'), '');
  assert.equal(safeRelative('/'), '');

  assert.equal(remotePath('/home/alice', 'docs/a.txt'), '/home/alice/docs/a.txt');
  assert.equal(remotePath('/home/alice', ''), '/home/alice');
  assert.equal(remotePath('/home/alice', 'nested/dir/file.sh'), '/home/alice/nested/dir/file.sh');

  // Traversal & safety rejections
  assert.throws(() => safeRelative('../outside'));
  assert.throws(() => safeRelative('a/../b'));
  assert.throws(() => safeRelative('a//b'));
  assert.throws(() => safeRelative('a/\0/b'));
  assert.throws(() => safeRelative(null));
  assert.throws(() => remotePath('/home/alice', '../root'));
  assert.throws(() => remotePath('/home/alice', 'a//b'));
});

test('uniqueMacs drops MACs shared by several IPs', () => {
  const shared = new Set();
  const arp = {
    '192.168.68.93': '88:a2:9e:ba:f2:2d',
    '192.168.68.101': 'ba:fb:b3:00:a6:0c',
    '192.168.68.106': 'ba:fb:b3:00:a6:0c'
  };
  assert.deepEqual(uniqueMacs(arp, shared), { '192.168.68.93': '88:a2:9e:ba:f2:2d' });
  assert.ok(shared.has('ba:fb:b3:00:a6:0c'));
  // Remembered from an earlier scan even when only one IP shows it now.
  assert.deepEqual(uniqueMacs({ '192.168.68.107': 'ba:fb:b3:00:a6:0c' }, shared), {});
  assert.deepEqual(uniqueMacs({ '10.0.0.2': 'b8:27:eb:01:02:03' }), { '10.0.0.2': 'b8:27:eb:01:02:03' });
});

test('deviceKey and cleanVersion format identifiers correctly', () => {
  assert.equal(deviceKey('192.168.1.10', 'b8:27:eb:1:2:3'), 'b8:27:eb:01:02:03');
  assert.equal(deviceKey('192.168.1.10', ''), '192.168.1.10');
  assert.equal(deviceKey('raspberrypi.local', null), 'raspberrypi.local');

  assert.equal(cleanVersion('v1.2.3'), '1.2.3');
  assert.equal(cleanVersion('V2.0'), '2.0');
  assert.equal(cleanVersion('0.9.1'), '0.9.1');
  assert.equal(cleanVersion(''), '');
  assert.equal(cleanVersion(null), '');
});

test('modelParts parses model strings and provides fallbacks', () => {
  assert.deepEqual(modelParts(null, 'Pi'), { pill: 'Pi', suffix: '' });
  assert.deepEqual(modelParts('', 'Fallback'), { pill: 'Fallback', suffix: '' });

  assert.deepEqual(
    modelParts('Raspberry Pi 4 Model B Rev 1.4', 'Pi'),
    { pill: 'Raspberry Pi 4 Model B', suffix: 'Rev 1.4' }
  );

  assert.deepEqual(
    modelParts('Raspberry Pi Zero 2 W with Headers', 'Pi'),
    { pill: 'Raspberry Pi Zero 2 W', suffix: 'with Headers' }
  );

  assert.deepEqual(
    modelParts('Raspberry Pi 5', 'Pi'),
    { pill: 'Raspberry Pi 5', suffix: '' }
  );

  assert.deepEqual(
    modelParts('ESP32C3 module with ESP32-C3', 'ESP32'),
    { pill: 'ESP32-C3', suffix: '' }
  );

  assert.deepEqual(
    modelParts('ESP32S3 module with ESP32-S3', 'ESP32'),
    { pill: 'ESP32-S3', suffix: '' }
  );

  assert.deepEqual(
    modelParts('Generic ESP32S3 module with ESP32-S3', 'ESP32'),
    { pill: 'ESP32-S3', suffix: '' }
  );

  assert.deepEqual(
    modelParts('Generic ESP32S3 module', 'ESP32'),
    { pill: 'ESP32-S3', suffix: '' }
  );

  assert.deepEqual(
    modelParts('ESP32 module with ESP32', 'ESP32'),
    { pill: 'ESP32', suffix: '' }
  );

  assert.deepEqual(
    modelParts('Generic ESP32 module with ESP32', 'ESP32'),
    { pill: 'ESP32', suffix: '' }
  );

  assert.deepEqual(
    modelParts('Generic ESP32C3 module with ESP32-C3', 'ESP32'),
    { pill: 'ESP32-C3', suffix: '' }
  );

  assert.deepEqual(
    modelParts('Generic ESP32C3 module', 'ESP32'),
    { pill: 'ESP32-C3', suffix: '' }
  );

  assert.deepEqual(
    modelParts('Generic ESP32 module', 'ESP32'),
    { pill: 'ESP32', suffix: '' }
  );

  assert.deepEqual(
    modelParts('Generic ESP32 module', 'Fallback'),
    { pill: 'ESP32', suffix: '' }
  );

  assert.deepEqual(
    modelParts('ESP32C3 module', 'Fallback'),
    { pill: 'ESP32-C3', suffix: '' }
  );
});

test('hardwareSpecs extracts and deduces RAM, Flash, Revision, Package, and Frequency', () => {
  // Pico W
  assert.deepEqual(
    hardwareSpecs({ model: 'Pico W with RP2040', type: 'Pico' }),
    { ram: '264KB RAM', flash: '2MB Flash', revision: null, package: 'RP2040', frequency: '133MHz' }
  );

  // Pico 2 W
  assert.deepEqual(
    hardwareSpecs({ model: 'Pico 2 W with RP2350', type: 'Pico' }),
    { ram: '520KB RAM', flash: '4MB Flash', revision: null, package: 'RP2350', frequency: '150MHz' }
  );

  // ESP32-S3
  assert.deepEqual(
    hardwareSpecs({ model: 'Generic ESP32S3 module with ESP32-S3', type: 'ESP32' }),
    { ram: '512KB RAM', flash: '8MB Flash', revision: null, package: 'Xtensa LX7', frequency: '240MHz' }
  );

  // ESP32-C3
  assert.deepEqual(
    hardwareSpecs({ model: 'Generic ESP32C3 module with ESP32-C3', type: 'ESP32' }),
    { ram: '400KB RAM', flash: '4MB Flash', revision: null, package: 'RISC-V', frequency: '160MHz' }
  );

  // Classic ESP32
  assert.deepEqual(
    hardwareSpecs({ model: 'Generic ESP32 module with ESP32', type: 'ESP32' }),
    { ram: '520KB RAM', flash: '4MB Flash', revision: null, package: 'Xtensa LX6', frequency: '240MHz' }
  );

  // Pi Zero 2 W with revision
  assert.deepEqual(
    hardwareSpecs({ model: 'Pi Zero 2 W Rev 1.0', pi: true }),
    { ram: '512MB RAM', flash: null, revision: 'Rev 1.0', package: null, frequency: '1.0GHz' }
  );

  // Device with explicit hardware specs passed from API / SSH
  assert.deepEqual(
    hardwareSpecs({
      model: 'Pi 4 B Rev 1.1',
      ram: '4GB',
      flash: '32GB',
      frequency: '1.5GHz',
      pi: true
    }),
    { ram: '4GB RAM', flash: '32GB SD', revision: 'Rev 1.1', package: null, frequency: '1.5GHz' }
  );
});

test('crc32 produces correct standard checksums', () => {
  assert.equal(crc32(Buffer.alloc(0)), 0x00000000);
  // Standard test vector for ASCII "123456789" is 0xcbf43926
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.from('hello world')), 0x0d4a1185);
});

test('createZipBuffer creates valid ZIP archives', () => {
  const entries = [
    { path: 'hello.txt', content: Buffer.from('Hello, Pi Bay!'), mtime: 1700000000 },
    { path: 'nested/test.py', content: 'print("hello")', mtime: 1700000000 }
  ];

  const zipBuf = createZipBuffer(entries);
  assert.ok(Buffer.isBuffer(zipBuf));
  assert.ok(zipBuf.length > 0);

  // First 4 bytes must be local file header magic: 0x04034b50 (PK\x03\x04)
  assert.equal(zipBuf.readUInt32LE(0), 0x04034b50);

  // Verify end of central directory record magic (PK\x05\x06) exists near the end
  const eocdIndex = zipBuf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocdIndex > 0);
  assert.equal(zipBuf.readUInt16LE(eocdIndex + 8), 2); // 2 total entries
  assert.equal(zipBuf.readUInt16LE(eocdIndex + 10), 2); // 2 entries on disk
});

test('parseZipBuffer reads back archives from createZipBuffer', () => {
  const zipBuf = createZipBuffer([
    { path: 'hello.txt', content: Buffer.from('Hello, Pi Bay!') },
    { path: 'nested/deep/test.py', content: 'print("hello")' }
  ]);
  const entries = parseZipBuffer(zipBuf);
  assert.deepEqual(entries.map(e => e.path), ['hello.txt', 'nested/deep/test.py']);
  assert.equal(entries[0].content.toString(), 'Hello, Pi Bay!');
  assert.equal(entries[1].content.toString(), 'print("hello")');
});

test('parseZipBuffer inflates deflated entries', () => {
  const zlib = require('zlib');
  const name = Buffer.from('a.txt');
  const content = Buffer.from('a'.repeat(400));
  const data = zlib.deflateRawSync(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(content), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(content), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const centralAt = 30 + name.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + name.length, 12); eocd.writeUInt32LE(centralAt, 16);
  const zipBuf = Buffer.concat([local, name, data, central, name, eocd]);
  const [entry] = parseZipBuffer(zipBuf);
  assert.equal(entry.path, 'a.txt');
  assert.equal(entry.content.toString(), 'a'.repeat(400));
});

test('parseZipBuffer rejects unsafe paths, garbage, and oversized archives', () => {
  for (const bad of ['../escape.txt', '/abs.txt', 'a/../b.txt', 'a//b.txt']) {
    assert.throws(() => parseZipBuffer(createZipBuffer([{ path: bad, content: 'x' }])), /Invalid ZIP path/);
  }
  assert.throws(() => parseZipBuffer(Buffer.from('not a zip at all, just some text here')), /end record not found/);
  const two = createZipBuffer([{ path: 'a', content: 'x' }, { path: 'b', content: 'y' }]);
  assert.throws(() => parseZipBuffer(two, { maxFiles: 1 }), /too many files/);
  assert.throws(() => parseZipBuffer(two, { maxTotal: 1 }), /exceed/);
});

test('isRaspberryPi detects platform and device-tree model', () => {
  assert.equal(isRaspberryPi('darwin'), false);
  assert.equal(isRaspberryPi('win32'), false);
  assert.equal(isRaspberryPi('linux', 'Raspberry Pi 4 Model B'), true);
  assert.equal(isRaspberryPi('linux', 'Raspberry Pi 5'), true);
  assert.equal(isRaspberryPi('linux', 'Generic x86_64 PC'), false);
});

test('envEnabled detects truthy values', () => {
  assert.equal(envEnabled('1'), true);
  assert.equal(envEnabled('true'), true);
  assert.equal(envEnabled('TRUE'), true);
  assert.equal(envEnabled('yes'), true);
  assert.equal(envEnabled('0'), false);
  assert.equal(envEnabled('false'), false);
  assert.equal(envEnabled(''), false);
  assert.equal(envEnabled(undefined), false);
});

test('selectMcpTransports resolves stdio and http transports correctly', () => {
  const base = { noMcp: false, cliStdio: false, cliHttp: false, raspberryPiHost: false };
  assert.deepEqual(selectMcpTransports({ ...base, noMcp: true }), { stdio: false, http: false });
  assert.deepEqual(selectMcpTransports({ ...base, cliStdio: true }), { stdio: true, http: false });
  assert.deepEqual(selectMcpTransports({ ...base, cliHttp: true }), { stdio: false, http: true });
  // Raspberry Pi host enables HTTP MCP by default
  assert.deepEqual(selectMcpTransports({ ...base, raspberryPiHost: true }), { stdio: false, http: true });
  // Non-Pi host defaults to disabled
  assert.deepEqual(selectMcpTransports({ ...base, raspberryPiHost: false }), { stdio: false, http: false });
  // env vars
  assert.deepEqual(selectMcpTransports({ ...base, envStdio: '1' }), { stdio: true, http: false });
  assert.deepEqual(selectMcpTransports({ ...base, envHttp: '1' }), { stdio: false, http: true });
});

test('shouldOpenBrowser honors flags and host', () => {
  assert.equal(shouldOpenBrowser(false, false), true);
  assert.equal(shouldOpenBrowser(true, false), false);
  assert.equal(shouldOpenBrowser(false, true), false);
  assert.equal(shouldOpenBrowser(true, true), false);
});

test('asText identifies valid UTF-8 text vs binary data', () => {
  assert.equal(asText(Buffer.from('hello world')), 'hello world');
  assert.equal(asText(Buffer.from([0, 1, 2])), null);
  assert.equal(asText(Buffer.from([0x01, 0x02])), null);
});

test('decodeMcpContent decodes UTF-8 and base64 strings', () => {
  assert.equal(decodeMcpContent('hello', 'utf8').toString('utf8'), 'hello');
  const b64 = Buffer.from('binary-data').toString('base64');
  assert.equal(decodeMcpContent(b64, 'base64').toString('utf8'), 'binary-data');
  assert.throws(() => decodeMcpContent('invalid base64!!!', 'base64'));
});
