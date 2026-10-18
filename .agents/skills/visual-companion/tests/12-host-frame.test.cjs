// A prototype inside a same-origin host page, the way an exploration wraps one:
// the host injects the review layer into the frame from the companion, and the
// layer reads its review, companion and token from the host's link. Built
// without stamps, so source comes from grepping the configured files. Picking
// never clicks through; state, lenses and Go there work inside the frame; Send
// reaches the companion with the token, and the crop is made in the frame, in
// the note's state.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  project,
  vc,
  port,
  browser,
  events,
  waitFor,
  stopAll,
  ART,
  buildExample,
  serveDir,
} = require('./lib.cjs');

const HOST = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Host · Sessions</title>
    <style>html, body { margin: 0; height: 100%; } iframe { border: 0; width: 100%; height: 100%; display: block; }</style>
  </head>
  <body>
    <iframe id="proto" src="index.html" title="Prototype"></iframe>
    <script>
      // The layer comes from the companion (?vc=), never from a local copy.
      const q = new URLSearchParams(location.search);
      const frame = document.getElementById('proto');
      frame.addEventListener('load', () => {
        const w = frame.contentWindow;
        w.REVIEW_CONFIG = {
          name: 'Host · Sessions',
          sources: ['src/head.html', 'src/style.css', 'src/app.js'],
        };
        const s = w.document.createElement('script');
        s.src = new URL('vc/review.js', q.get('vc')).href;
        w.document.head.appendChild(s);
      });
    </script>
  </body>
</html>
`;

const dirs = [];
let b, srv, proto;

test.before(async () => {
  b = await browser();
  proto = buildExample(['--no-stamp']);
  fs.writeFileSync(path.join(proto, 'host.html'), HOST);
  srv = await serveDir(proto);
});
test.after(async () => {
  srv.closeAllConnections();
  srv.close();
  stopAll(dirs);
  await b.close();
});

test('a host page: pick, grep source, state, lenses, Go there, Send with a crop in state', async () => {
  const dir = project();
  dirs.push(dir);
  vc(dir, ['start', '--port', String(port())]);
  const open = vc(dir, [
    'review',
    'open',
    `http://localhost:${srv.address().port}/host.html`,
    '--name',
    'host',
    '--title',
    'Host · Sessions',
  ]);
  assert.equal(open.ok, true, JSON.stringify(open));
  assert.match(open.url, /[?&]vt=/);
  const page = await b.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(open.url);
  await waitFor(() => page.frames().length > 1, 5000, 50, 'frame');
  const fr = page.frames()[1];
  await fr.waitForFunction(() => window.__review && window.director);
  await fr.evaluate(() => localStorage.clear());
  await page.waitForTimeout(300);
  await page.focus('iframe');

  // Pick the New session button: the click must not reach the prototype.
  await page.keyboard.press('c');
  const btn = await fr.locator('#newBtn').boundingBox();
  await page.mouse.click(btn.x + btn.width / 2, btn.y + btn.height / 2);
  await fr.locator('.vc-note textarea').waitFor();
  assert.equal(
    await fr.evaluate(() => document.getElementById('compose').hidden),
    true,
    'the dialog stayed shut'
  );
  await page.keyboard.type('Make this the primary action');
  await page.keyboard.press('Enter');
  const p1 = await fr.evaluate(() => window.__review.pins[0]);
  assert.equal(p1.selector, '#newBtn');
  assert.match(p1.source.markup, /^src\/head\.html:\d+$/);
  assert.match(p1.source.style, /^src\/style\.css:\d+$/);
  assert.notEqual(p1.source.exact, true, 'an unstamped build is a grep, not exact');
  assert.deepEqual(p1.state, { data: 'many', theme: 'light', motion: false });
  assert.doesNotMatch(p1.page, /vt=/, 'the token stays out of the note');
  assert.match(p1.frame, /index\.html$/);

  // Into the detail sheet (a state from the menu) and pin a step there, widened
  // from the item to the list with ArrowUp.
  await fr.evaluate(() => window.director.set('state', 'detail'));
  await page.waitForTimeout(300);
  const step = await fr.locator('#sheet .steps li').first().boundingBox();
  await page.keyboard.press('c');
  await page.mouse.move(step.x + 20, step.y + step.height / 2);
  await page.keyboard.press('ArrowUp');
  await page.mouse.click(step.x + 20, step.y + step.height / 2);
  await fr.locator('.vc-note textarea').waitFor();
  await page.keyboard.type('Show the steps as a timeline');
  await page.keyboard.press('Enter');
  const p2 = await fr.evaluate(() => window.__review.pins[1]);
  assert.equal(p2.state.state, 'detail');
  assert.match(p2.selector, /ol(\.steps)?$/, 'widened to the list: ' + p2.selector);

  // Dark is a lens: pins stay. Empty is another place: pin 2 hides.
  await fr.evaluate(() => window.director.set('theme', 'dark'));
  await page.waitForTimeout(250);
  assert.equal(await fr.locator('.vc-pin[data-n="2"]').isVisible(), true);
  await fr.evaluate(() => window.director.set('data', 'empty'));
  await page.waitForTimeout(400);
  assert.equal(await fr.locator('.vc-pin[data-n="2"]').isHidden(), true);
  await fr.evaluate(() => window.__review.openPanel(true));
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(ART, 'host-away-dark.png') });
  await fr
    .locator('.vc-rpanel li', { hasText: 'timeline' })
    .getByRole('button', { name: 'Go there' })
    .click();
  await waitFor(() => fr.locator('#sheet').isVisible(), 3000, 50, 'sheet back');
  await waitFor(() => fr.locator('.vc-pin[data-n="2"]').isVisible(), 3000, 50, 'pin back');

  // Send: two pins and one send reach the companion (with the token, from
  // another origin), and the sheet note is cropped inside the frame, in its state.
  await fr.evaluate(() => window.director.set('theme', 'light'));
  await fr.evaluate(() => window.__review.send());
  await waitFor(() => events(dir).some((e) => e.type === 'send'), 5000, 50, 'send recorded');
  const ev = events(dir);
  assert.equal(ev.filter((e) => e.type === 'pin').length, 2);
  assert.equal(ev.find((e) => e.type === 'send').review.notes[1].state.state, 'detail');
  assert.ok(!JSON.stringify(ev).includes('vt='), 'no token in the log');
  const crop = await waitFor(
    () => {
      const n = vc(dir, ['review', 'list']).notes.find((x) => x.n === 2);
      return n && n.crop;
    },
    20000,
    250,
    'crop of the sheet note'
  );
  assert.ok(fs.statSync(crop).size > 2000, 'a real image');
  fs.copyFileSync(crop, path.join(ART, 'host-crop-sheet.png'));
  assert.deepEqual(errors, []);
  await page.close();
});
