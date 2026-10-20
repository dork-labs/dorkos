// Server lifecycle: start, fixed port, reuse, busy port, restart, idle timeout.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { project, vc, write, screen, port, listen, waitFor, stopAll } = require('./lib.cjs');

const dirs = [];
test.after(() => stopAll(dirs));

test('starts on the requested fixed port and reuses a running server', () => {
  const dir = project();
  dirs.push(dir);
  const p = port();
  const a = vc(dir, ['start', '--port', String(p)]);
  assert.equal(a.ok, true);
  assert.equal(a.port, p);
  assert.equal(a.server, 'started');
  const b = vc(dir, ['start', '--port', String(p)]);
  assert.equal(b.server, 'running');
  assert.equal(b.port, p);
  const s = vc(dir, ['status']);
  assert.equal(s.running, true);
  assert.equal(s.idle_ms, 4 * 3600e3, 'default idle timeout is 4 hours');
});

test('skips a port held by a foreign process and never touches it', async () => {
  const dir = project();
  dirs.push(dir);
  const p = port();
  let hits = 0;
  const foreign = await listen((req, res) => {
    hits++;
    res.end('not the companion');
  }, p);
  try {
    const r = vc(dir, ['start', '--port', String(p)]);
    assert.equal(r.ok, true);
    assert.equal(r.port, p + 1, 'moved to the next port');
    assert.deepEqual(r.skipped_ports, [p]);
    // The foreign server is still up and still answering.
    const body = await new Promise((res) =>
      http.get({ host: '127.0.0.1', port: p, path: '/' }, (x) => {
        let b = '';
        x.on('data', (c) => (b += c));
        x.on('end', () => res(b));
      })
    );
    assert.equal(body, 'not the companion');
    assert.ok(hits >= 2);
  } finally {
    foreign.close();
  }
});

test('restart keeps the session, its screens and its port', async () => {
  const dir = project();
  dirs.push(dir);
  const p = port();
  const first = vc(dir, [
    'show',
    write(dir, 'one.html', screen('One')),
    '--port',
    String(p),
    '--no-wait',
  ]);
  assert.equal(first.port, p);
  const stop = vc(dir, ['stop']);
  assert.equal(stop.status, 'stopped');
  assert.equal(vc(dir, ['status']).running, false);
  const again = vc(dir, [
    'show',
    write(dir, 'two.html', screen('Two')),
    '--port',
    String(p),
    '--no-wait',
  ]);
  assert.equal(again.server, 'started');
  assert.equal(again.port, p);
  assert.equal(again.session, first.session);
  const state = await (await fetch(again.url + 'vc/state')).json();
  assert.deepEqual(
    state.screens.map((s) => s.name),
    ['one', 'two']
  );
});

test('with no port pinned, it takes a free port and a restart gets the same one back', async () => {
  const dir = project();
  dirs.push(dir);
  const env = { VC_PORT: '', BRAINSTORM_PORT: '' };
  const first = vc(dir, ['show', write(dir, 'one.html', screen('One')), '--no-wait'], { env });
  assert.equal(first.server, 'started');
  assert.ok(first.port > 0);
  assert.equal((await fetch(first.url + 'vc/health')).status, 200);
  assert.equal(vc(dir, ['stop']).status, 'stopped');
  const again = vc(dir, ['show', write(dir, 'two.html', screen('Two')), '--no-wait'], { env });
  assert.equal(again.server, 'started');
  assert.equal(again.port, first.port, 'an open canvas tab finds the server again');
});

test('show never reuses a filename', () => {
  const dir = project();
  dirs.push(dir);
  const f = write(dir, 'layout.html', screen('Layout'));
  const p = String(port());
  assert.equal(vc(dir, ['show', f, '--port', p, '--no-wait']).screen, 'layout');
  assert.equal(vc(dir, ['show', f, '--port', p, '--no-wait']).screen, 'layout-2');
  assert.equal(
    vc(dir, ['show', '-', '--name', 'from stdin', '--port', p, '--no-wait'], {
      input: screen('Stdin'),
    }).screen,
    'from-stdin'
  );
});

test('idle timeout stops the server, and polling does not count as activity', async () => {
  const dir = project();
  dirs.push(dir);
  const r = vc(dir, ['start', '--port', String(port()), '--idle', '1500ms']);
  assert.equal(r.ok, true);
  const t0 = Date.now();
  // Poll like an open tab would; the server must still idle out.
  const poller = setInterval(() => fetch(r.url + 'vc/state').catch(() => {}), 200);
  try {
    await waitFor(() => fs.existsSync(path.join(r.state_dir, 'server-stopped')), 6000);
  } finally {
    clearInterval(poller);
  }
  const stopped = JSON.parse(fs.readFileSync(path.join(r.state_dir, 'server-stopped'), 'utf8'));
  assert.equal(stopped.reason, 'idle timeout');
  assert.ok(Date.now() - t0 >= 1400);
  assert.equal(vc(dir, ['status']).running, false);
});
