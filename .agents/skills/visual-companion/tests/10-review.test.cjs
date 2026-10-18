// The review layer in the frame (one pin implementation), and the agent's verbs:
// exact source from the server's data-src stamps, intent, request vs note, the
// one-line ref, vc review list / resolve / dismiss, answers showing on the page,
// and crops taken at Send.
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
let b;
const servers = [];
test.before(async () => (b = await browser()));
test.after(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
  stopAll(dirs);
  await b.close();
});

async function stub() {
  const calls = [];
  const s = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method !== 'GET') calls.push(JSON.parse(body || '{}'));
      res.writeHead(req.method === 'GET' ? 200 : 202, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  servers.push(s);
  return { calls, port: s.address().port };
}

async function pin(page, sel, text, opts = {}) {
  await page.keyboard.press('c');
  const box = await page.locator(sel).first().boundingBox();
  await page.mouse.click(box.x + Math.min(20, box.width / 2), box.y + box.height / 2);
  await page.locator('.vc-note textarea').fill(text);
  if (opts.kind) await page.locator(`.vc-note [data-kind="${opts.kind}"]`).click();
  if (opts.intent) await page.locator(`.vc-note [data-intent="${opts.intent}"]`).click();
  await page.locator('.vc-note [data-act="save"]').click();
}

test('a pin on a fragment carries exact source, intent, kind and a one-line ref', async () => {
  const dir = project();
  dirs.push(dir);
  const r = vc(dir, [
    'show',
    write(dir, 'src.html', screen('Source', OPTIONS)),
    '--port',
    String(port()),
    '--no-wait',
  ]);
  const page = await b.newPage();
  await page.goto(r.url);
  // The server stamps every tag of the fragment with its line in content/.
  assert.equal(await page.locator('h2').getAttribute('data-src'), 'content/src.html:1');
  await pin(page, '[data-choice="b"] h3', 'Busy is too busy', { intent: 'refine' });
  await waitFor(() => events(dir).some((e) => e.type === 'pin'));
  const p = events(dir).find((e) => e.type === 'pin');
  assert.equal(p.source.markup, 'content/src.html:3');
  assert.equal(p.source.exact, true);
  assert.equal(p.intent, 'refine');
  assert.equal(p.kind, 'request');
  assert.match(p.ref, /h3 .*content\/src\.html:3/);
  assert.equal(p.role, 'heading');
  await page.close();
});

test('a private note never wakes the agent and stays out of the payload; a request does', async () => {
  const s = await stub();
  const dir = project();
  dirs.push(dir);
  const env = { DORKOS_PORT: String(s.port) };
  const r = vc(
    dir,
    [
      'show',
      write(dir, 'w.html', screen('Wake', OPTIONS)),
      '--wake',
      '--session',
      'chat-r',
      '--label',
      'Tester',
      '--port',
      String(port()),
      '--no-wait',
    ],
    { env }
  );
  const page = await b.newPage();
  await page.goto(r.url);
  await pin(page, 'h2', 'Just for me', { kind: 'note' });
  await waitFor(() => events(dir).some((e) => e.type === 'pin'));
  await page.waitForTimeout(1300);
  assert.equal(s.calls.length, 0, 'a note wakes nobody');
  assert.equal(await page.locator('.vc-pin[data-kind="note"]').count(), 1);
  await pin(page, '[data-choice="a"] h3', 'Make Quiet the default');
  await waitFor(() => s.calls.length >= 1, 8000, 50, 'request delivered');
  const pins = s.calls[0].payload.screens[0].pins;
  assert.deepEqual(
    pins.map((x) => x.note),
    ['Make Quiet the default'],
    'only the request travels'
  );
  assert.equal(pins[0].intent, 'fix');
  assert.ok(pins[0].ref);
  assert.match(s.calls[0].payload.answer, /vc review resolve/);
  await page.close();
});

test('vc review list, resolve and dismiss; the page shows the answer', async () => {
  const dir = project();
  dirs.push(dir);
  const p = String(port());
  const r = vc(dir, [
    'show',
    write(dir, 'ans.html', screen('Answers', OPTIONS)),
    '--port',
    p,
    '--no-wait',
  ]);
  const page = await b.newPage();
  await page.goto(r.url);
  await pin(page, 'h2', 'Title is too loud');
  await pin(page, '[data-choice="a"] h3', 'Rename Quiet');
  await pin(page, '.subtitle', 'Mine only', { kind: 'note' });
  await waitFor(() => events(dir).filter((e) => e.type === 'pin').length === 3);

  const list = vc(dir, ['review', 'list']);
  assert.equal(list.count, 2, 'open requests only');
  assert.match(list.lines[0], /^ans#1 · fix · open · Title is too loud/);
  assert.equal(vc(dir, ['review', 'list', '--all']).count, 3);

  // Through the running server, so the open page hears it at once.
  const res = vc(dir, ['review', 'resolve', '1', 'Dropped it to 22px']);
  assert.equal(res.via, 'server');
  assert.equal(res.status, 'resolved');
  await waitFor(
    async () =>
      (await page.locator('.vc-pin[data-n="1"]').getAttribute('data-status')) === 'resolved',
    4000,
    50,
    'pin 1 resolved on the page'
  );
  assert.equal(await page.locator('.vc-pin[data-n="1"] svg').count(), 1, 'a check, not a number');
  await page.locator('.vc-pin[data-n="1"]').hover();
  await page.locator('.vc-reply').waitFor();
  assert.match(await page.locator('.vc-reply').textContent(), /Dropped it to 22px/);
  vc(dir, ['review', 'dismiss', 'ans#2', 'Quiet is the name we tested']);
  await waitFor(
    async () =>
      (await page.locator('.vc-pin[data-n="2"]').getAttribute('data-status')) === 'dismissed',
    4000
  );
  assert.equal(vc(dir, ['review', 'list']).count, 0);
  const all = vc(dir, ['review', 'list', '--all']).notes;
  assert.equal(all.find((x) => x.n === 1).reply, 'Dropped it to 22px');
  // A resolved note survives a reload as resolved.
  await page.reload();
  await page.locator('.vc-pin[data-n="1"][data-status="resolved"]').waitFor();
  // Errors are plain.
  assert.equal(vc(dir, ['review', 'resolve', '9', 'x']).ok, false);
  assert.match(vc(dir, ['review', 'resolve', '3']).error, /no open note 3|say it in a line/);
  await page.close();
});

test('Send crops each open request into shots/notes, and the wake carries the path', async () => {
  const s = await stub();
  const dir = project();
  dirs.push(dir);
  const env = { DORKOS_PORT: String(s.port) };
  const r = vc(
    dir,
    [
      'show',
      write(dir, 'crop.html', screen('Crop me', OPTIONS)),
      '--wake',
      '--session',
      'chat-c',
      '--port',
      String(port()),
      '--no-wait',
    ],
    { env }
  );
  const page = await b.newPage({ viewport: { width: 1100, height: 760 } });
  await page.goto(r.url);
  await pin(page, '[data-choice="b"]', 'More air around Busy');
  await waitFor(() => s.calls.length >= 1, 8000, 50, 'pin delivered');
  await page.locator('[data-choice="b"]').click();
  await page.locator('.vc-send-btn').click();
  await waitFor(() => s.calls.length >= 2, 15000, 100, 'send delivered');
  const sent = s.calls[1].payload.screens[0].pins[0];
  assert.ok(sent.crop && sent.crop.endsWith('shots/notes/crop-1.png'), 'crop path: ' + sent.crop);
  assert.ok(fs.existsSync(sent.crop));
  assert.ok(fs.statSync(sent.crop).size > 2000, 'a real image');
  // And on demand.
  const again = vc(dir, ['review', 'crop', 'crop#1']);
  assert.equal(again.ok, true, JSON.stringify(again));
  await page.close();
});

test('vc review list with no session says nothing rather than failing', async () => {
  const dir = project();
  dirs.push(dir);
  const r = vc(dir, ['review', 'list']);
  assert.equal(r.ok, true);
  assert.equal(r.count, 0);
});
