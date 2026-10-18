// A full prototype with the director kit, reviewed through the companion:
// the bar renders from knobs and keeps values in the URL; `vc review open`
// brings the review layer in; a note remembers the state; pins hide in another
// scenario but not under a lens; Go there puts the page back; Send wakes once,
// with crops replayed in state; the agent's answer reaches the page; AA in both
// themes. Uses examples/prototype (built in a temp copy with build-proto.cjs).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  SKILL,
  AXE,
  project,
  vc,
  port,
  browser,
  events,
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
  // The prototype lives on its own port, another origin than the companion.
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

const shadow = (page, sel) => page.locator(sel); // Playwright's CSS pierces open shadow roots
// Hovering the handle swaps it for the full bar, so point at it rather than hover() it.
async function openBar(page) {
  const h = await page.locator('director-bar .handle').boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.locator('director-bar .full').waitFor();
}

test('the director bar renders from knobs, keeps non-defaults in the URL, and replays', async () => {
  const page = await b.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${staticPort}/index.html`);
  await page.waitForFunction(() => window.director);
  // At rest: a handle with the name; the full bar on hover.
  assert.equal(await shadow(page, 'director-bar .handle').isVisible(), true);
  assert.equal(await shadow(page, 'director-bar .full').isVisible(), false);
  await openBar(page);
  assert.equal(await shadow(page, 'director-bar .full').isVisible(), true);
  // Knobs: a scenario, a lens, a state.
  await shadow(page, 'director-bar [data-k="data"][data-v="empty"]').click();
  await shadow(page, 'director-bar [data-k="theme"][data-v="dark"]').click();
  assert.match(page.url(), /data=empty/);
  assert.match(page.url(), /theme=dark/);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  assert.match(await page.locator('#list').textContent(), /No sessions yet/);
  assert.deepEqual(await page.evaluate(() => window.director.state()), {
    data: 'empty',
    theme: 'dark',
    motion: false,
  });
  assert.equal(
    await page.evaluate(() => window.director.describe(window.director.state())),
    'Data Empty · Theme Dark'
  );
  // Defaults stay out of the URL.
  await shadow(page, 'director-bar [data-k="data"][data-v="many"]').click();
  assert.doesNotMatch(page.url(), /data=/);
  // A reload comes back the same.
  await page.goto(`http://localhost:${staticPort}/index.html?data=error&state=compose`);
  await page.waitForFunction(() => window.director);
  assert.equal(await page.locator('#compose').isVisible(), true);
  assert.match(await page.locator('#list').textContent(), /Couldn’t load/);
  // go() puts back exactly that, from anywhere.
  await page.evaluate(() => window.director.go({ data: 'one', step: 2 }));
  assert.equal(await page.evaluate(() => window.director.values.step), 2);
  // Play: steps in the bar, and the handle says where you are.
  await page.evaluate(() => window.director.stop());
  await page.mouse.move(640, 400);
  await openBar(page);
  await shadow(page, 'director-bar .play').click();
  assert.match(await shadow(page, 'director-bar .steps .lbl').textContent(), /1\/4 · First light/);
  await shadow(page, 'director-bar .next').click();
  assert.match(page.url(), /step=1/);
  assert.match(await page.locator('#list').textContent(), /Tune the Block Buddies/);
  // Reduced motion is a lens that the page's CSS can follow.
  await shadow(page, 'director-bar [data-k="motion"]').click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.motion), 'reduce');
  assert.deepEqual(errors, []);
  await page.close();
});

test('keyboard: Tab reaches the handle and the bar opens; Esc closes the states menu', async () => {
  const page = await b.newPage();
  await page.goto(`http://localhost:${staticPort}/index.html`);
  await page.waitForFunction(() => window.director);
  await page.mouse.move(640, 600);
  await page.evaluate(() =>
    document.querySelector('director-bar').shadowRoot.querySelector('.handle').focus()
  );
  assert.equal(
    await shadow(page, 'director-bar .full').isVisible(),
    true,
    'a focused handle shows the controls'
  );
  await page.keyboard.press('Enter');
  assert.equal(
    await page.evaluate(
      () =>
        document.querySelector('director-bar').shadowRoot.activeElement?.closest('.full') !== null
    ),
    true,
    'Enter moves into them'
  );
  assert.equal(await shadow(page, 'director-bar .handle').isVisible(), false);
  await shadow(page, 'director-bar .statesbtn').focus();
  await page.keyboard.press('Enter');
  assert.equal(await shadow(page, 'director-bar .menu').isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await shadow(page, 'director-bar .menu').isVisible(), false);
  await page.close();
});

test('reviewing a prototype: state, pins across scenarios and lenses, Go there, Send with crops, answers', async () => {
  const calls = [];
  const dork = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method !== 'GET') calls.push(JSON.parse(body || '{}'));
      res.writeHead(req.method === 'GET' ? 200 : 202, { 'Content-Type': 'application/json' });
      res.end('{"id":"chat-p","title":"Test"}');
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
      `http://localhost:${staticPort}/index.html`,
      '--name',
      'sessions',
      '--title',
      'Example · Sessions',
      '--wake',
      '--session',
      'chat-p',
      '--label',
      'Tester',
    ],
    { env }
  );
  assert.equal(open.ok, true, JSON.stringify(open));
  assert.match(open.url, /review=sessions/);

  const page = await b.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(open.url);
  await page.waitForFunction(() => window.__review && window.director);

  // 1. A note in the default scenario, on a JS-rendered row: exact source from the build.
  await page.keyboard.press('c');
  const row = await page.locator('.row').nth(1).boundingBox();
  await page.mouse.click(row.x + 120, row.y + 18);
  await page.locator('.vc-note textarea').fill('Let long titles wrap to two lines');
  await page.screenshot({ path: path.join(ART, 'proto-note-light.png') });
  await page.keyboard.press('Enter');
  const p1 = await page.evaluate(() => window.__review.pins[0]);
  assert.match(p1.source?.markup || '', /^src\/app\.js:\d+$/, JSON.stringify(p1));
  assert.equal(p1.source.exact, true);
  assert.deepEqual(p1.state, { data: 'many', theme: 'light', motion: false });
  assert.match(
    await page.evaluate(() => window.__review.ref(window.__review.pins[0])),
    /src\/app\.js:\d+ · in Data Many · Theme Light/
  );

  // 2. A note inside a state from the menu (the detail sheet).
  await page.evaluate(() => window.director.set('state', 'detail'));
  await page.keyboard.press('c');
  const sheet = await page.locator('#sheet h2').boundingBox();
  await page.mouse.click(sheet.x + 30, sheet.y + 10);
  await page.locator('.vc-note [data-intent="explore"]').click();
  await page.locator('.vc-note textarea').fill('Try the steps as a timeline');
  await page.keyboard.press('Enter');
  const p2 = await page.evaluate(() => window.__review.pins[1]);
  assert.equal(p2.state.state, 'detail');
  assert.equal(
    p2.source.markup,
    'src/app.js:' +
      (fs
        .readFileSync(path.join(PROTO, 'src/app.js'), 'utf8')
        .split('\n')
        .findIndex((l) => l.includes('sheet.innerHTML')) +
        1)
  );

  // 3. A lens keeps pins; a new scenario hides them.
  await page.evaluate(() => window.director.set('theme', 'dark'));
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.vc-pin[data-n="2"]').isVisible(), true, 'dark is a lens');
  await page.evaluate(() => window.director.set('data', 'empty'));
  await page.waitForTimeout(100);
  assert.equal(
    await page.locator('.vc-pin[data-n="1"]').isHidden(),
    true,
    'empty is another place'
  );
  assert.equal(await page.locator('.vc-pin[data-n="2"]').isHidden(), true);
  await page.evaluate(() => window.__review.openPanel(true));
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.vc-rpanel li.vc-away').count(), 2);
  await page.screenshot({ path: path.join(ART, 'proto-away-dark.png') });

  // 4. Go there: back to the detail sheet, still in dark.
  await page
    .locator('.vc-rpanel li', { hasText: 'timeline' })
    .getByRole('button', { name: 'Go there' })
    .click();
  await waitFor(() => page.locator('.vc-pin[data-n="2"]').isVisible(), 3000, 50, 'pin 2 back');
  assert.equal(await page.locator('#sheet').isVisible(), true);
  assert.equal(
    await page.evaluate(() => window.director.values.theme),
    'dark',
    'Go there keeps today’s lenses'
  );

  // 5. Send: pins ride on one send, one wake, crops replayed in state.
  await page.locator('.vc-rpanel textarea').fill('Both are about the sheet, really');
  await page.locator('.vc-rpanel .vc-send2').click();
  await waitFor(() => calls.length >= 1, 15000, 100, 'one wake');
  await page.waitForTimeout(1200);
  assert.equal(calls.length, 1, 'notes posted with the send do not wake on their own');
  const pl = calls[0].payload.screens[0];
  assert.equal(pl.title, 'Example · Sessions');
  assert.deepEqual(pl.pins.map((x) => x.n).sort(), [1, 2]);
  assert.match(pl.message, /about the sheet/);
  for (const x of pl.pins) {
    assert.ok(x.crop && fs.existsSync(x.crop), 'crop for ' + x.n + ': ' + x.crop);
    fs.copyFileSync(x.crop, path.join(ART, 'crop-' + x.n + '.png'));
  }
  assert.equal(events(dir).filter((e) => e.type === 'send').length, 1);

  // 6. The agent answers; the page hears it (polling across origins).
  await page.evaluate(() => window.__review.openPanel(false));
  vc(dir, ['review', 'resolve', 'sessions#1', 'Titles wrap to two lines now'], { env });
  await waitFor(
    async () =>
      (await page.locator('.vc-pin[data-n="1"]').getAttribute('data-status')) === 'resolved',
    8000,
    100,
    'answer reaches the page'
  );
  assert.match(await page.locator('.vc-rtoast').textContent(), /Tester resolved note 1/);
  await page.evaluate(() => window.director.go({ data: 'many', theme: 'light' }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(ART, 'proto-resolved-light.png') });
  assert.equal(vc(dir, ['review', 'list'], { env }).count, 1, 'one still open');
  assert.deepEqual(errors, []);
  await page.close();
});

for (const theme of ['light', 'dark']) {
  test(`prototype chrome (director bar, review bar, note, panel) passes axe in ${theme}`, async () => {
    const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`http://localhost:${staticPort}/index.html?theme=${theme}`);
    await page.waitForFunction(() => window.director);
    // The review layer without a companion: local notes, clipboard Send.
    await page.addScriptTag({ path: path.join(SKILL, 'scripts/review.js') });
    await page.waitForFunction(() => window.__review);
    await page.evaluate(() => localStorage.clear());
    await openBar(page);
    await page.keyboard.press('c');
    const t = await page.locator('.title').boundingBox();
    await page.mouse.click(t.x + 10, t.y + 10);
    await page.locator('.vc-note textarea').fill('Saved note');
    await page.keyboard.press('Enter');
    await page.evaluate(() => window.__review.openPanel(true));
    await page.keyboard.press('c');
    const s = await page.locator('.sub').boundingBox();
    await page.mouse.click(s.x + 10, s.y + 6);
    await page.locator('.vc-note textarea').fill('Draft note');
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(ART, `proto-chrome-${theme}.png`) });
    await page.addScriptTag({ path: AXE });
    const res = await page.evaluate(async () => {
      const r = await window.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
        resultTypes: ['violations', 'passes'],
      });
      const cc = r.passes.find((p) => p.id === 'color-contrast');
      const targets = (cc ? cc.nodes : []).map((n) => JSON.stringify(n.target));
      return {
        violations: r.violations.map(
          (v) => v.id + ': ' + v.nodes.map((n) => JSON.stringify(n.target)).join(' | ')
        ),
        chrome: targets.filter((t) => /review-layer|director-bar/.test(t)).length,
      };
    });
    assert.deepEqual(res.violations, []);
    assert.ok(res.chrome >= 10, 'contrast checked inside the shadow roots: ' + res.chrome);
    await page.close();
  });
}
