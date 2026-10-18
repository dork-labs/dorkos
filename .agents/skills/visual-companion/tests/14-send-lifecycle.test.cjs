// The Send lifecycle on a reviewed prototype.
// Every note always says where it is; Send never repeats; pinning is always safe.
// A fake DorkOS answers 409 (busy) or 202 (taken) and reports the chat's lifecycle.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {
  AXE,
  project,
  vc,
  port,
  browser,
  waitFor,
  stopAll,
  listen,
  ART,
  buildExample,
  serveDir,
} = require('./lib.cjs');

let PROTO;
const dirs = [];
const servers = [];
let b, staticPort;

test.before(async () => {
  b = await browser();
  PROTO = buildExample();
  const s = await serveDir(PROTO);
  servers.push(s);
  staticPort = s.address().port;
});
test.after(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
  stopAll(dirs);
  await b.close();
});

async function note(page, nth, text) {
  await page.keyboard.press('c');
  const row = await page.locator('.row').nth(nth).boundingBox();
  await page.mouse.click(row.x + 120, row.y + 18);
  await page.locator('.vc-note textarea').fill(text);
  await page.keyboard.press('Enter');
}
const txt = (page, sel) => page.locator(sel).first().textContent();
const shot = (page, name) => page.screenshot({ path: path.join(ART, name + '.png') });

test('Send: ready → queued → on it → still open → done, never sendable twice, safe to keep pinning', async () => {
  const fake = { busy: true, lifecycle: 'streaming', calls: [] };
  const dork = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({ id: 'chat-s', title: 'Test', status: { lifecycle: fake.lifecycle } })
        );
      }
      fake.calls.push(JSON.parse(body || '{}'));
      res.writeHead(fake.busy ? 409 : 202, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  servers.push(dork);
  const env = { DORKOS_PORT: String(dork.address().port) };
  const dir = project();
  dirs.push(dir);
  const vport = port();
  vc(dir, ['start', '--port', String(vport)], { env });
  const open = vc(
    dir,
    [
      'review',
      'open',
      `http://localhost:${staticPort}/index.html`,
      '--name',
      'life',
      '--title',
      'Example · Lifecycle',
      '--wake',
      '--session',
      'chat-s',
      '--label',
      'Tester',
    ],
    { env }
  );
  assert.equal(open.ok, true, JSON.stringify(open));
  // (The synchronous vc helper blocks this process's static server, so the page check can't fetch here: null, never false.)
  assert.notEqual(open.pins, false, 'never claims a page with the layer has none');

  const page = await b.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(open.url);
  await page.waitForFunction(() => window.__review && window.director);

  // Ready: two notes, "Send 2", the handle counts what's waiting on you.
  await note(page, 1, 'Let long titles wrap');
  await note(page, 2, 'The date column is too faint');
  await page.evaluate(() => window.__review.openPanel(true));
  assert.match(await txt(page, '.vc-rpanel .vc-send2'), /^Send 2 to Tester$/);
  assert.match(await txt(page, '.vc-rpanel .vc-grp h3'), /To send/);
  await shot(page, '1-ready-light');

  // Send while the agent is busy: queued, said in words, and nothing to send again.
  await page.locator('.vc-rpanel .vc-send2').click();
  await waitFor(async () => /Queued/.test(await txt(page, '.vc-rpanel')), 10000, 100, 'queued');
  assert.equal(
    await page.locator('.vc-rpanel .vc-send2').isHidden(),
    true,
    'no second Send for the same notes'
  );
  assert.match(await txt(page, '.vc-rpanel'), /in the middle of something/);
  assert.match(await txt(page, '.vc-rpanel .vc-foot'), /New notes go in your next Send/);
  assert.match(await page.locator('.vc-rbar .vc-rstat').getAttribute('aria-label'), /Queued/);
  assert.equal(
    await page
      .locator('.vc-rpanel #vc-out')
      .evaluate((el) => el.getRootNode().activeElement === el),
    true,
    'focus lands where the notes went'
  );
  await shot(page, '2-queued-light');

  // Keep pinning while it waits: the new note is the only one Send offers.
  await note(page, 3, 'Add an empty state');
  await page.evaluate(() => window.__review.openPanel(true));
  assert.match(await txt(page, '.vc-rpanel .vc-send2'), /^Send 1 to Tester$/);
  assert.equal(
    await page
      .locator('.vc-rpanel #vc-out ~ ol li, .vc-rpanel .vc-grp[data-k="queued"] li')
      .count(),
    2
  );
  await shot(page, '3-queued-plus-new-light');

  // The agent frees up: DorkOS takes it, and the chat is working on it.
  fake.busy = false;
  await waitFor(
    async () => /Tester is on it/.test(await txt(page, '.vc-rpanel')),
    30000,
    200,
    'on it'
  );
  assert.equal(fake.calls.length >= 1, true);
  const delivered = fake.calls[fake.calls.length - 1].payload.screens[0];
  assert.deepEqual(delivered.new_pins.sort(), [1, 2], 'the queued Send carries notes 1 and 2');
  await shot(page, '4-on-it-light');

  // Send the third: only note 3 goes.
  await page.locator('.vc-rpanel .vc-send2').click();
  await waitFor(
    () =>
      fake.calls.length >= 2 &&
      fake.calls[fake.calls.length - 1].payload.screens[0].new_pins.includes(3),
    15000,
    100,
    'note 3 delivered'
  );
  assert.deepEqual(fake.calls[fake.calls.length - 1].payload.screens[0].new_pins, [3]);

  // The agent's turn ends without closing them: say so, offer the chat.
  fake.lifecycle = 'idle';
  await waitFor(
    async () => /Still open with Tester/.test(await txt(page, '.vc-rpanel')),
    15000,
    200,
    'still open'
  );
  assert.equal(
    await page.locator('.vc-rpanel').getByRole('button', { name: 'Open chat' }).isVisible(),
    true
  );
  await shot(page, '5-still-open-light');

  // Answers arrive one by one into Done.
  // (With the panel closed, a toast says so; with it open, the panel shows it in place.)
  await page.evaluate(() => window.__review.openPanel(false));
  vc(dir, ['review', 'resolve', 'life#1', 'Titles wrap to two lines now'], { env });
  await waitFor(
    async () =>
      /Tester resolved note 1: Titles wrap/.test(
        (await page
          .locator('.vc-rtoast')
          .textContent()
          .catch(() => '')) || ''
      ),
    10000,
    100,
    'toast'
  );
  await page.evaluate(() => window.__review.openPanel(true));
  await waitFor(async () => /Done · 1/.test(await txt(page, '.vc-rpanel')), 10000, 100, 'done 1');
  assert.equal(
    (await page
      .locator('.vc-rtoast')
      .isHidden()
      .catch(() => true)) || !(await page.locator('.vc-rtoast').count()),
    true
  );
  await shot(page, '6-partly-done-light');

  // A reload reopens on the truth, never on "Send 3".
  await page.reload();
  await page.waitForFunction(() => window.__review);
  await page.evaluate(() => window.__review.openPanel(true));
  await waitFor(
    async () => /Still open with Tester/.test(await txt(page, '.vc-rpanel')),
    10000,
    200,
    'state after reload'
  );
  assert.equal(await page.locator('.vc-rpanel .vc-send2').isHidden(), true);
  assert.match(await txt(page, '.vc-rpanel'), /Done · 1/);

  // Dark, for the eye.
  await page.evaluate(() => window.director.set('theme', 'dark'));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__review.openPanel(true));
  await shot(page, '7-still-open-dark');

  // The rest answered: all done, a moment of ✓, then rest.
  vc(dir, ['review', 'resolve', 'life#2', 'Darkened to the muted token'], { env });
  vc(dir, ['review', 'dismiss', 'life#3', 'Covered by the existing empty state'], { env });
  await waitFor(async () => /Done · 3/.test(await txt(page, '.vc-rpanel')), 10000, 100, 'done 3');
  assert.match(await page.locator('.vc-rbar .vc-rstat').getAttribute('aria-label'), /3 done/);
  await shot(page, '8-all-done-dark');

  // The companion goes away: a new note can't leave, and says why, with Retry.
  vc(dir, ['stop'], { env });
  await note(page, 0, 'One more thing');
  await page.evaluate(() => window.__review.openPanel(true));
  await page.locator('.vc-rpanel .vc-send2').click();
  await waitFor(
    async () => /companion isn’t running/.test(await txt(page, '.vc-rpanel')),
    8000,
    100,
    'offline'
  );
  assert.match(await txt(page, '.vc-rpanel .vc-send2'), /Try again/);
  await shot(page, '9-offline-dark');
  assert.deepEqual(errors, []);
});

for (const theme of ['light', 'dark']) {
  test(`the lifecycle panel passes axe in ${theme}`, async () => {
    const dork = await listen((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(req.method === 'GET' ? 200 : 409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'chat-a', status: { lifecycle: 'streaming' } }));
      });
    });
    servers.push(dork);
    const env = { DORKOS_PORT: String(dork.address().port) };
    const dir = project();
    dirs.push(dir);
    vc(dir, ['start', '--port', String(port())], { env });
    const open = vc(
      dir,
      [
        'review',
        'open',
        `http://localhost:${staticPort}/index.html?theme=${theme}`,
        '--name',
        'ax',
        '--wake',
        '--session',
        'chat-a',
        '--label',
        'Tester',
      ],
      { env }
    );
    const page = await b.newPage({ viewport: { width: 1280, height: 860 } });
    await page.goto(open.url);
    await page.waitForFunction(() => window.__review && window.director);
    await note(page, 1, 'First');
    await note(page, 2, 'Second');
    await page.evaluate(() => window.__review.openPanel(true));
    await page.locator('.vc-rpanel .vc-send2').click();
    await waitFor(async () => /Queued/.test(await txt(page, '.vc-rpanel')), 10000, 100, 'queued');
    await note(page, 3, 'Third, not sent yet');
    await page.evaluate(() => window.__review.openPanel(true));
    await page.addScriptTag({ path: AXE });
    const res = await page.evaluate(async () => {
      const r = await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag22aa'] });
      return r.violations
        .filter((v) => v.nodes.some((n) => JSON.stringify(n.target).includes('review-layer')))
        .map((v) => v.id + ': ' + v.nodes.map((n) => JSON.stringify(n.target)).join(' | '));
    });
    assert.deepEqual(res, []);
  });
}
