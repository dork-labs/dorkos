// The reply budget with pins on the screen (08-review-fixes covers a reply on
// its own, and the message route): pin details and older pins go before the
// person's words, a reply that fits with them is never clipped, and a trimmed
// one points at the events file, which keeps all of it. The stub refuses an
// oversize payload the way DorkOS does (400).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const {
  project,
  vc,
  write,
  screen,
  OPTIONS,
  port,
  browser,
  events,
  waitFor,
  stopAll,
  listen,
} = require('./lib.cjs');

const dirs = [];
let b, srv;
const bodies = [];
test.before(async () => {
  b = await browser();
  srv = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('{}');
      }
      const j = JSON.parse(body || '{}');
      const big = JSON.stringify(j.payload).length > 8192;
      bodies.push({ j, big });
      res.writeHead(big ? 400 : 202, { 'Content-Type': 'application/json' });
      res.end(big ? '{"error":"payload exceeds 8192 serialized characters"}' : '{}');
    });
  });
});
test.after(async () => {
  srv.closeAllConnections();
  srv.close();
  stopAll(dirs);
  await b.close();
});

const words = (n) => {
  let s = '';
  for (let i = 0; s.length < n; i++) s += `word${i} `;
  return s.slice(0, n);
};

async function reply(text) {
  const dir = project();
  dirs.push(dir);
  const env = { DORKOS_PORT: String(srv.address().port) };
  const r = vc(
    dir,
    [
      'show',
      write(dir, 'long.html', screen('Long reply', OPTIONS)),
      '--wake',
      '--session',
      'chat-l',
      '--port',
      String(port()),
      '--no-wait',
    ],
    { env }
  );
  const page = await b.newPage();
  await page.goto(r.url);
  // Two request pins too, so trimming has metadata and pins to drop before the words.
  for (const [sel, note] of [
    ['h2', 'Title note ' + 'x'.repeat(200)],
    ['[data-choice="a"] h3', 'Option note'],
  ]) {
    await page.keyboard.press('c');
    const box = await page.locator(sel).boundingBox();
    await page.mouse.click(box.x + 10, box.y + box.height / 2);
    await page.locator('.vc-note textarea').fill(note);
    await page.keyboard.press('Enter');
  }
  const before = bodies.length;
  await waitFor(() => bodies.length >= before + 1, 8000, 50, 'pins delivered');
  await page.waitForTimeout(1000);
  const start = bodies.length;
  await page.locator('.vc-send-input').fill(text);
  await page.locator('.vc-send-btn').click();
  await waitFor(() => bodies.length > start, 10000, 50, 'send delivered');
  const got = bodies[bodies.length - 1];
  await page.close();
  return { got, dir };
}

test('a 6,000-character reply beside two pins arrives whole', async () => {
  const text = words(6000);
  const { got } = await reply(text);
  assert.equal(got.big, false, 'within DorkOS budget');
  const sc = got.j.payload.screens[0];
  assert.equal(sc.message, text);
  assert.equal(sc.message_truncated, undefined);
});

test('a 20,000-character reply: pin details and older pins go first, then the words', async () => {
  const text = words(20000);
  const { got, dir } = await reply(text);
  assert.equal(got.big, false, 'within DorkOS budget');
  const sc = got.j.payload.screens[0];
  assert.deepEqual(
    sc.pins.map((p) => p.n),
    [2],
    'the newest pin stays, the older one goes'
  );
  for (const k of ['state', 'source', 'target', 'selector'])
    assert.equal(sc.pins[0][k], undefined, k + ' dropped (vc review list has it)');
  assert.ok(sc.pins[0].note, 'the note itself stays');
  assert.ok(sc.message.length > 4000, 'keeps as much as fits: ' + sc.message.length);
  assert.ok(text.startsWith(sc.message.slice(0, -1)));
  const [file, ts] = sc.message_full_at.split('#');
  assert.ok(fs.existsSync(file));
  const ev = events(dir).find((e) => e.type === 'send' && String(e.timestamp) === ts);
  assert.equal(ev.message, text, 'the events file has all of it');
});
