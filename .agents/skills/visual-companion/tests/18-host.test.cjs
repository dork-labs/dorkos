// The server answers only to this computer's names (DOR-3121 review). It starts
// on each loopback host it allows; it refuses a request or websocket upgrade
// whose Host names anything else (a DNS-rebinding page names its own domain);
// it refuses a write or a socket from a website's Origin; and a websocket
// message that parses to no event cannot crash it. No browser.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'scripts', 'server.cjs');

const running = [];
test.after(() => {
  for (const s of running) {
    s.child.kill();
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

// Start a server on `host`, port 0; resolves { port } or { error } (stderr).
function start(host) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-host-'));
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      BRAINSTORM_DIR: dir,
      BRAINSTORM_HOST: host,
      BRAINSTORM_PORT: '0',
      BRAINSTORM_SHOTS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const s = { child, dir };
  running.push(s);
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => {
      out += c;
      const line = out.split('\n').find((l) => l.includes('"server-started"'));
      if (line) resolve({ ...s, port: JSON.parse(line).port });
    });
    child.stderr.on('data', (c) => (err += c));
    child.on('exit', () => resolve({ ...s, error: err || out }));
    setTimeout(() => resolve({ ...s, error: 'timed out: ' + err }), 5000);
  });
}

// One raw request on 127.0.0.1:port; resolves the status line and body.
function raw(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => socket.write(request));
    let data = '';
    socket.on('data', (c) => {
      data += c;
      if (data.startsWith('HTTP/1.1 101')) socket.end();
    });
    socket.on('end', () => resolve(data));
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
    socket.setTimeout(3000, () => socket.destroy());
  });
}

const get = (port, host, p = '/vc/health') =>
  raw(port, `GET ${p} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
const upgrade = (port, host, origin) =>
  raw(
    port,
    `GET / HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      (origin ? `Origin: ${origin}\r\n` : '') +
      `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`
  );

// A masked client text frame (servers refuse unmasked ones).
function textFrame(text) {
  const payload = Buffer.from(text);
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
}

for (const host of ['127.0.0.1', 'localhost', '::1']) {
  test(`starts on ${host}`, async (t) => {
    const s = await start(host);
    if (host === '::1' && /EADDRNOTAVAIL|EAFNOSUPPORT/.test(s.error || '')) {
      return t.skip('this machine has no IPv6 loopback');
    }
    assert.ok(s.port > 0, s.error);
  });
}

test('answers only to localhost, 127.0.0.1 or [::1] on its own port', async () => {
  const s = await start('127.0.0.1');
  assert.ok(s.port > 0, s.error);
  for (const ok of [
    `localhost:${s.port}`,
    `127.0.0.1:${s.port}`,
    `[::1]:${s.port}`,
    `LOCALHOST:${s.port}`,
    `localhost.:${s.port}`,
  ]) {
    assert.match(await get(s.port, ok), /^HTTP\/1\.1 200/, ok);
  }
  for (const bad of [
    `rebind.example:${s.port}`,
    `localhost.rebind.example:${s.port}`,
    `localhost:${s.port + 1}`,
    'localhost',
    `127.0.0.1.nip.io:${s.port}`,
    `localhost..:${s.port}`,
    `localhost:0${s.port}`,
  ]) {
    const r = await get(s.port, bad);
    assert.match(r, /^HTTP\/1\.1 421/, bad);
    assert.match(r, /wrong-host/, bad);
  }
  // A screen page and a Send are refused the same way.
  assert.match(await get(s.port, `rebind.example:${s.port}`, '/'), /^HTTP\/1\.1 421/);
  const post = await raw(
    s.port,
    `POST /vc/event HTTP/1.1\r\nHost: rebind.example:${s.port}\r\nContent-Type: text/plain\r\n` +
      'Content-Length: 18\r\nConnection: close\r\n\r\n{"type":"submit"}\n'
  );
  assert.match(post, /^HTTP\/1\.1 421/);
  assert.ok(!fs.existsSync(path.join(s.dir, 'state', 'events')), 'nothing was recorded');
});

test('refuses a websocket upgrade from another Host', async () => {
  const s = await start('127.0.0.1');
  assert.ok(s.port > 0, s.error);
  assert.match(await upgrade(s.port, `rebind.example:${s.port}`), /^HTTP\/1\.1 421/);
  assert.match(await upgrade(s.port, `localhost:${s.port}`), /^HTTP\/1\.1 101/);
});

test('refuses a write or a socket from a website, not from a page on this computer', async () => {
  const s = await start('127.0.0.1');
  assert.ok(s.port > 0, s.error);
  const host = `localhost:${s.port}`;
  const post = (origin) =>
    raw(
      s.port,
      `POST /vc/event HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\n` +
        'Content-Type: text/plain\r\nContent-Length: 18\r\nConnection: close\r\n\r\n{"type":"submit"}\n'
    );
  for (const origin of ['https://attacker.example', 'null', 'http://localhost.attacker.example']) {
    const r = await post(origin);
    assert.match(r, /^HTTP\/1\.1 403/, origin);
    assert.match(r, /foreign-origin/, origin);
    assert.match(await upgrade(s.port, host, origin), /^HTTP\/1\.1 403/, origin);
  }
  assert.ok(!fs.existsSync(path.join(s.dir, 'state', 'events')), 'nothing was recorded');
  // A page on another local port may still listen (it needs a token to write).
  assert.match(await upgrade(s.port, host, 'http://localhost:5173'), /^HTTP\/1\.1 101/);
});

test('a websocket message of null, a number or an array does not crash it', async () => {
  const s = await start('127.0.0.1');
  assert.ok(s.port > 0, s.error);
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: s.port }, () =>
      socket.write(
        `GET / HTTP/1.1\r\nHost: localhost:${s.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      )
    );
    let sent = false;
    socket.on('data', () => {
      if (sent) return;
      sent = true;
      socket.write(Buffer.concat(['null', '42', '[]', '"x"'].map(textFrame)));
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 300);
    });
    socket.on('error', reject);
  });
  assert.strictEqual(s.child.exitCode, null, 'the server is still running');
  assert.match(await get(s.port, `localhost:${s.port}`), /^HTTP\/1\.1 200/);
});
