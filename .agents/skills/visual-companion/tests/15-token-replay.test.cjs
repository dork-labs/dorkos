// Two promises the Send path makes.
// 1. Only the reviewed page can wake the agent from another origin: a write from
//    any other local page needs the review's token (`vt`), and without the right
//    one it is refused and wakes nobody. The token never shows up where a page
//    can read it.
// 2. A queued Send replayed after a restart never goes twice: one DorkOS took
//    is skipped, whatever was written after it; one that never landed goes once.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const {
  SKILL,
  project,
  vc,
  port,
  browser,
  events,
  waitFor,
  stopAll,
  listen,
} = require('./lib.cjs');

const dirs = [];
const servers = [];
let b;
test.before(async () => (b = await browser()));
test.after(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
  stopAll(dirs);
  await b.close();
});

// A fake DorkOS: `answer` decides the status of each POST; `accepted` keeps
// the ones it took (202), `calls` every one.
async function fakeDorkos(answer = () => 202) {
  const fake = { calls: [], accepted: [], answer };
  const s = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: 'chat-t', status: { lifecycle: 'idle' } }));
      }
      const status = fake.answer();
      fake.calls.push(JSON.parse(body || '{}'));
      if (status === null) return; // hold the request open: DorkOS never answers
      if (status === 202) fake.accepted.push(fake.calls[fake.calls.length - 1]);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  servers.push(s);
  fake.port = s.address().port;
  return fake;
}

// A review the companion wakes `chat-t` for. The target URL is never fetched
// successfully here (nothing listens on port 9), which `vc review open` allows.
function openReview(dir, fake, name) {
  const env = { DORKOS_PORT: String(fake.port) };
  const s = vc(dir, ['start', '--port', String(port())], { env });
  const open = vc(
    dir,
    [
      'review',
      'open',
      'http://127.0.0.1:9/proto.html',
      '--name',
      name,
      '--wake',
      '--session',
      'chat-t',
      '--label',
      'Tester',
    ],
    { env }
  );
  assert.equal(open.ok, true, JSON.stringify(open));
  return { env, base: s.url.replace(/\/?$/, '/'), token: new URL(open.url).searchParams.get('vt') };
}

// POST an event the way a local tool does (no Origin), or with headers that
// make it a page on another origin.
function post(base, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL('vc/event', base);
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('another origin without the right token is refused and wakes nobody', async () => {
  const fake = await fakeDorkos();
  const dir = project();
  dirs.push(dir);
  const { base, token } = openReview(dir, fake, 'tok');
  assert.match(token, /^[\w-]{20,}$/, 'a random token in the link');

  // A real page on another loopback origin, posting a Send the way the layer would.
  const other = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Some other local page</title>');
  });
  servers.push(other);
  const page = await b.newPage();
  await page.goto(`http://localhost:${other.address().port}/`);
  const attempt = (vt) =>
    page.evaluate(
      async ({ base, vt }) => {
        const r = await fetch(base + 'vc/event', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({
            type: 'send',
            screen: 'tok',
            message: 'wake up',
            review: { notes: [] },
            ...(vt ? { vt } : {}),
          }),
        });
        return { status: r.status, body: await r.json() };
      },
      { base, vt }
    );
  const none = await attempt(null);
  assert.equal(none.status, 403);
  assert.equal(none.body.error, 'stale-link');
  const wrong = await attempt(token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa'));
  assert.equal(wrong.status, 403);
  // The same refusal through a raw socket from another origin, and a WebSocket.
  const raw = await post(
    base,
    { type: 'send', screen: 'tok', message: 'wake up' },
    { Origin: 'http://localhost:1', 'Sec-Fetch-Site': 'same-site' }
  );
  assert.equal(raw.status, 403);
  await page.evaluate(
    (base) =>
      new Promise((resolve) => {
        const ws = new WebSocket(base.replace(/^http/, 'ws'));
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'send', screen: 'tok', message: 'via socket' }));
          setTimeout(() => (ws.close(), resolve()), 300);
        };
        ws.onerror = () => resolve();
      }),
    base
  );
  await new Promise((r) => setTimeout(r, 2500)); // past the 800ms batch, and then some
  assert.equal(fake.calls.length, 0, 'the fake DorkOS was never called');
  assert.equal(events(dir).filter((e) => e.type === 'send').length, 0, 'nothing recorded');

  // The control: the same page with the right token gets through, once.
  const ok = await attempt(token);
  assert.equal(ok.status, 200);
  await waitFor(() => fake.accepted.length === 1, 8000, 50, 'the tokened Send wakes the chat');
  // And nothing a page can read gives the token away.
  const sent = events(dir).find((e) => e.type === 'send');
  assert.equal(sent.vt, undefined, 'the token is not logged');
  const readable = await page.evaluate(async (base) => {
    const out = [];
    for (const p of ['vc/pins?screen=tok', 'vc/review?screen=tok', 'vc/review-status?screen=tok'])
      out.push(await (await fetch(base + p)).text());
    return out.join('\n');
  }, base);
  assert.ok(!readable.includes(token), 'no read route returns the token');
  await page.close();
});

test('a Send DorkOS already took is not sent again after a restart', async () => {
  const fake = await fakeDorkos();
  const dir = project();
  dirs.push(dir);
  const { base, env } = openReview(dir, fake, 'once');
  const r = await post(base, { type: 'send', screen: 'once', message: 'just once' });
  assert.equal(r.status, 200, 'a local tool needs no token');
  await waitFor(() => fake.accepted.length === 1, 8000, 50, 'delivered');
  await waitFor(
    () => events(dir).some((e) => e.type === 'delivery' && e.state === 'delivered'),
    3000,
    50,
    'the success is recorded'
  );
  // A `queued` line landing after the success (an overlapping server writes one)
  // must not make the replay think it never went.
  const send = events(dir).find((e) => e.type === 'send');
  const st = vc(dir, ['status']);
  fs.appendFileSync(
    path.join(st.state_dir || path.join(st.session_dir, 'state'), 'events'),
    JSON.stringify({
      type: 'delivery',
      screen: 'once',
      notes: [],
      message: true,
      state: 'queued',
      reason: 'busy',
      send: send.timestamp,
      timestamp: Date.now(),
    }) + '\n'
  );
  vc(dir, ['stop'], { env });
  vc(dir, ['start', '--port', String(port())], { env });
  await new Promise((r) => setTimeout(r, 4000)); // replay runs 1.5s after start
  assert.equal(fake.calls.length, 1, 'exactly one call, before and after the restart');
});

test('a Send that never landed is replayed once after a restart', async () => {
  const fake = await fakeDorkos(() => 409); // the agent is mid-turn
  const dir = project();
  dirs.push(dir);
  const { base, env } = openReview(dir, fake, 'later');
  await post(base, { type: 'send', screen: 'later', message: 'when you are free' });
  await waitFor(() => fake.calls.length >= 1, 8000, 50, 'tried and queued');
  await waitFor(
    () => events(dir).some((e) => e.type === 'delivery' && e.reason === 'busy'),
    3000,
    50,
    'queued (busy) is recorded'
  );
  vc(dir, ['stop'], { env });
  fake.answer = () => 202; // free now
  vc(dir, ['start', '--port', String(port())], { env });
  await waitFor(() => fake.accepted.length === 1, 10000, 50, 'replayed after the restart');
  assert.equal(fake.accepted[0].payload.screens[0].message, 'when you are free');
  // Once more round: it is delivered now, so a second restart sends nothing.
  vc(dir, ['stop'], { env });
  vc(dir, ['start', '--port', String(port())], { env });
  await new Promise((r) => setTimeout(r, 4000));
  assert.equal(fake.accepted.length, 1, 'replayed exactly once');
});

test('a Send caught mid-request is never replayed blind; it is marked unsure', async () => {
  const fake = await fakeDorkos(() => null); // DorkOS takes the request and never answers
  const dir = project();
  dirs.push(dir);
  const { base, env } = openReview(dir, fake, 'midway');
  await post(base, { type: 'send', screen: 'midway', message: 'did this land?' });
  await waitFor(() => fake.calls.length === 1, 8000, 50, 'the request reached DorkOS');
  const deliveries = () => events(dir).filter((e) => e.type === 'delivery');
  assert.equal(deliveries().at(-1).state, 'delivering', 'written before the request left');
  // The server dies before any answer, so it never learns whether DorkOS took it.
  vc(dir, ['stop'], { env });
  fake.answer = () => 202;
  vc(dir, ['start', '--port', String(port())], { env });
  await waitFor(
    () => deliveries().some((e) => e.state === 'failed' && e.reason === 'unsure'),
    5000,
    50,
    'marked unsure on restart'
  );
  await new Promise((r) => setTimeout(r, 3000)); // replay runs 1.5s after start
  assert.equal(fake.calls.length, 1, 'not sent again on its own');
});

test('a crop only loads an http(s) page on this computer', () => {
  // A note's page comes from a posted pin, so it must never point the headless
  // browser at a file or another machine.
  const { isLocalPage } = require(path.join(SKILL, 'scripts', 'crop.cjs'));
  for (const ok of [
    'http://localhost:5173/',
    'http://127.0.0.1:8080/x?state=a',
    'https://[::1]:3000/',
  ])
    assert.equal(isLocalPage(ok), true, ok);
  for (const no of [
    'file:///etc/hosts',
    'http://10.0.0.1/',
    'http://example.com/',
    'http://localhost.example.com/',
    'javascript:alert(1)',
    'not a url',
    undefined,
  ])
    assert.equal(isLocalPage(no), false, String(no));
});
