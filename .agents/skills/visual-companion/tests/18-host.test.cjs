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
// Stop every server and wait for it to exit before removing its folder: it
// writes state/ as it shuts down, and a server left running would hold the
// test runner open.
test.after(async () => {
  await Promise.all(
    running.map(
      (s) =>
        new Promise((resolve) => {
          if (s.child.exitCode !== null || s.child.signalCode !== null) return resolve();
          s.child.once('exit', resolve);
          s.child.kill();
        })
    )
  );
  for (const s of running) {
    try {
      fs.rmSync(s.dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // A temp folder left behind is not worth failing the run.
    }
  }
});

// Start a server on `host`, port 0; resolves { port, info } or { error } (stderr).
function start(host, extra = {}, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-host-'))) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      BRAINSTORM_DIR: dir,
      BRAINSTORM_HOST: host,
      BRAINSTORM_PORT: '0',
      BRAINSTORM_SHOTS: '0',
      BRAINSTORM_IDLE_MS: '60000',
      ...extra,
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
      if (line) resolve({ ...s, info: JSON.parse(line), port: JSON.parse(line).port });
    });
    child.stderr.on('data', (c) => (err += c));
    child.on('exit', () => resolve({ ...s, error: err || out }));
    setTimeout(() => resolve({ ...s, error: 'timed out: ' + err }), 5000).unref();
  });
}

// One raw request on 127.0.0.1:port; resolves the status line and body.
function raw(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => socket.write(request));
    let data = '';
    socket.on('data', (c) => {
      data += c;
      if (data.startsWith('HTTP/1.1 101')) socket.destroy();
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

// The designer's fuzz inputs (DOR-3128): each is refused over POST and dropped
// over the websocket, nothing is recorded, and the server stays up.
test('null, [1], "x", 5 and {"type":7} are no event, over POST or websocket', async () => {
  const s = await start('127.0.0.1');
  assert.ok(s.port > 0, s.error);
  const host = `localhost:${s.port}`;
  const inputs = ['null', '[1]', '"x"', '5', '{"type":7}'];
  for (const body of inputs) {
    const r = await raw(
      s.port,
      `POST /vc/event HTTP/1.1\r\nHost: ${host}\r\nContent-Type: text/plain\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
    );
    assert.match(r, /^HTTP\/1\.1 400/, body);
  }
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: s.port }, () =>
      socket.write(
        `GET / HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      )
    );
    let sent = false;
    socket.on('data', () => {
      if (sent) return;
      sent = true;
      socket.write(Buffer.concat(inputs.map(textFrame)));
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 300);
    });
    socket.on('error', reject);
  });
  assert.strictEqual(s.child.exitCode, null, 'the server is still running');
  assert.match(await get(s.port, host), /^HTTP\/1\.1 200/);
  assert.ok(!fs.existsSync(path.join(s.dir, 'state', 'events')), 'nothing was recorded');
});

// Review findings on DOR-3128.
test('a client that resets while its upgrade is refused does not crash it', async () => {
  const s = await start('127.0.0.1');
  assert.ok(s.port > 0, s.error);
  for (const [host, origin] of [
    ['evil.example:' + s.port, null],
    ['localhost:' + s.port, 'http://evil.example'],
  ]) {
    await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: s.port }, () => {
        socket.write(
          `GET / HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            (origin ? `Origin: ${origin}\r\n` : '') +
            `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
        socket.resetAndDestroy();
        setTimeout(resolve, 200);
      });
      socket.on('error', () => {});
    });
  }
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(s.child.exitCode, null, 'the server is still running');
  assert.match(await get(s.port, `localhost:${s.port}`), /^HTTP\/1\.1 200/);
});

test('the DorkOS preview opened from a phone still works: its own page says same-origin', async () => {
  const s = await start('127.0.0.1');
  assert.ok(s.port > 0, s.error);
  const host = `localhost:${s.port}`;
  const phone = 'http://100.64.0.7:7001';
  const post = (site) =>
    raw(
      s.port,
      `POST /vc/event HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${phone}\r\n` +
        (site ? `Sec-Fetch-Site: ${site}\r\n` : '') +
        'Content-Type: text/plain\r\nContent-Length: 17\r\nConnection: close\r\n\r\n{"type":"submit"}'
    );
  assert.match(await post('same-origin'), /^HTTP\/1\.1 200/);
  assert.match(await post('cross-site'), /^HTTP\/1\.1 403/);
  assert.match(await post(null), /^HTTP\/1\.1 403/);
  const up = (site) =>
    raw(
      s.port,
      `GET / HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: ${phone}\r\n` +
        (site ? `Sec-Fetch-Site: ${site}\r\n` : '') +
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`
    );
  assert.match(await up('same-origin'), /^HTTP\/1\.1 101/);
  assert.match(await up('cross-site'), /^HTTP\/1\.1 403/);
});

test('a page cannot write a delivery, and bad notes cannot break the notes list', async () => {
  const s = await start('127.0.0.1');
  assert.ok(s.port > 0, s.error);
  const host = `localhost:${s.port}`;
  const post = (body) =>
    raw(
      s.port,
      `POST /vc/event HTTP/1.1\r\nHost: ${host}\r\nContent-Type: text/plain\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
    );
  assert.match(await post('{"type":"delivery","screen":"a","notes":5}'), /^HTTP\/1\.1 403/);
  assert.match(await post('{"type":"pin","screen":"a","n":1,"notes":5}'), /^HTTP\/1\.1 200/);
  assert.match(await get(s.port, host, '/vc/pins?screen=a'), /^HTTP\/1\.1 200/);
  assert.match(await get(s.port, host, '/vc/review?screen=a'), /^HTTP\/1\.1 200/);
});

test('a page cannot answer a note: pin-resolve only from a local tool', async () => {
  const s = await start('127.0.0.1');
  assert.ok(s.port > 0, s.error);
  const host = `localhost:${s.port}`;
  const resolve = '{"type":"pin-resolve","screen":"a","n":1,"status":"resolved","reply":"done"}';
  const post = (origin) =>
    raw(
      s.port,
      `POST /vc/event HTTP/1.1\r\nHost: ${host}\r\n` +
        (origin ? `Origin: ${origin}\r\nSec-Fetch-Site: same-origin\r\n` : '') +
        `Content-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(resolve)}\r\nConnection: close\r\n\r\n${resolve}`
    );
  assert.match(await post(`http://${host}`), /^HTTP\/1\.1 403/);
  assert.ok(!fs.existsSync(path.join(s.dir, 'state', 'events')), 'a page answered nothing');
  await new Promise((done, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: s.port }, () =>
      socket.write(
        `GET / HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      )
    );
    let sent = false;
    socket.on('data', () => {
      if (sent) return;
      sent = true;
      socket.write(textFrame(resolve));
      setTimeout(() => {
        socket.destroy();
        done();
      }, 300);
    });
    socket.on('error', reject);
  });
  assert.ok(!fs.existsSync(path.join(s.dir, 'state', 'events')), 'a socket answered nothing');
  // The agent's own tool, with no Origin, still can.
  assert.match(await post(null), /^HTTP\/1\.1 200/);
});

test('a malformed path costs one 400 or 404, never the server', async () => {
  const s = await start('127.0.0.1');
  assert.ok(s.port > 0, s.error);
  const host = `localhost:${s.port}`;
  for (const p of ['/files/%E0', '/vc/shot/%E0.png', '//', '/files/%2E%2E%2F']) {
    const r = await get(s.port, host, p);
    assert.match(r, /^HTTP\/1\.1 (400|404)/, p);
  }
  assert.strictEqual(s.child.exitCode, null, 'the server is still running');
  assert.match(await get(s.port, host), /^HTTP\/1\.1 200/);
});

test('a websocket frame claiming a huge length is refused, not buffered', async () => {
  const s = await start('127.0.0.1');
  assert.ok(s.port > 0, s.error);
  const closed = await new Promise((resolve) => {
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
      // FIN+TEXT, masked, 64-bit length of 2^40, then a mask and a few bytes.
      const head = Buffer.from([0x81, 0x80 | 127, 0, 0, 1, 0, 0, 0, 0, 0]);
      socket.write(Buffer.concat([head, crypto.randomBytes(4), Buffer.alloc(16)]));
    });
    socket.on('close', () => resolve(true));
    socket.on('error', () => resolve(true));
    setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 3000).unref();
  });
  assert.ok(closed, 'the server closed the socket');
  assert.strictEqual(s.child.exitCode, null, 'the server is still running');
});

test('prints a URL that loads: [::1] in brackets, no other names', async () => {
  const s = await start('::1');
  if (/EADDRNOTAVAIL|EAFNOSUPPORT/.test(s.error || '')) return;
  assert.strictEqual(s.info.url, `http://[::1]:${s.port}`);
  const bad = await start('127.0.0.1', { BRAINSTORM_URL_HOST: 'my-laptop.local' });
  assert.strictEqual(bad.port, undefined);
  assert.match(bad.error, /answers only to localhost/);
});

test('reads only what other local pages need: screens stay private', async () => {
  const s = await start('127.0.0.1');
  assert.ok(s.port > 0, s.error);
  const read = (p) =>
    raw(
      s.port,
      `GET ${p} HTTP/1.1\r\nHost: localhost:${s.port}\r\nOrigin: http://localhost:5173\r\nConnection: close\r\n\r\n`
    );
  assert.match(
    await read('/vc/pins?screen=x'),
    /Access-Control-Allow-Origin: http:\/\/localhost:5173/i
  );
  for (const p of ['/vc/state', '/vc/health', '/']) {
    assert.doesNotMatch(await read(p), /Access-Control-Allow-Origin/i, p);
  }
});

test('a Send with malformed fields neither crashes the server nor replays on restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-host-'));
  fs.mkdirSync(path.join(dir, 'content'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'content', 'a.html'),
    '<meta name="vc-wake" content="on"><h2>Routed</h2>\n'
  );
  // A session to wake, and a DorkOS port nothing listens on, so a delivery
  // that gets as far as fetching fails quietly instead of reaching anything.
  const closed = await new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
  const env = { VC_AGENT_SESSION: 'test-session', DORKOS_PORT: String(closed) };
  const s = await start('127.0.0.1', env, dir);
  assert.ok(s.port > 0, s.error);
  const body = JSON.stringify({
    type: 'send',
    screen: 'a',
    message: 7,
    selection: [null, 3, { choice: 'x' }],
    review: { notes: [null, { n: 1 }] },
  });
  const r = await raw(
    s.port,
    `POST /vc/event HTTP/1.1\r\nHost: localhost:${s.port}\r\nContent-Type: text/plain\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
  );
  assert.match(r, /"routed":true/);
  // Delivery runs about 0.8s later; give it time to fail if it is going to.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.strictEqual(s.child.exitCode, null, 'the server is still running');
  assert.match(await get(s.port, `localhost:${s.port}`), /^HTTP\/1\.1 200/);
  // Restart on the same folder: whatever was queued is replayed, and must not crash it.
  await new Promise((resolve) => {
    s.child.once('exit', resolve);
    s.child.kill();
  });
  const again = await start('127.0.0.1', env, dir);
  assert.ok(again.port > 0, again.error);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.strictEqual(again.child.exitCode, null, 'the restarted server is still running');
});

// DorkOS's preview proxy rewrites Host to the dev server's own name before it
// forwards (apps/server/src/services/workbench-serve/preview-listener.ts), so a
// page opened through it still passes, and no wider allowance (DorkOS's own
// port) is needed. Read the proxy's line so the two can't drift apart unseen.
const PROXY = path.join(
  __dirname,
  '../../../../apps/server/src/services/workbench-serve/preview-listener.ts'
);

test("a request through DorkOS's preview proxy still passes", async (t) => {
  if (!fs.existsSync(PROXY)) return t.skip('not inside the dorkos repo');
  const line = fs.readFileSync(PROXY, 'utf8').match(/headers\.host = `([^`]+)`;/);
  assert.ok(line, 'the proxy still sets Host in one template line');
  assert.strictEqual(line[1], 'localhost:${targetPort}', 'the proxy sends localhost:<target port>');
  const s = await start('127.0.0.1');
  assert.ok(s.port > 0, s.error);
  const proxied = line[1].replace('${targetPort}', String(s.port));
  assert.match(await get(s.port, proxied, '/vc/health'), /^HTTP\/1\.1 200/);
  assert.match(await upgrade(s.port, proxied), /^HTTP\/1\.1 101/);
  // DorkOS's own port is not one of this server's names.
  assert.match(await get(s.port, 'localhost:4242'), /^HTTP\/1\.1 421/);
});
