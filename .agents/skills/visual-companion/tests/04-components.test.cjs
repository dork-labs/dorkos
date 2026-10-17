// Every component renders in both themes with no console errors, and each
// one does its job: compare slider, both themes, phone, motion playground,
// reduced-motion toggle, theme toggle.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  SKILL,
  project,
  vc,
  write,
  port,
  browser,
  watchErrors,
  waitFor,
  stopAll,
} = require('./lib.cjs');

const dirs = [];
let b, url, dir;
test.before(async () => {
  b = await browser();
  dir = project();
  dirs.push(dir);
  const r = vc(dir, [
    'show',
    path.join(SKILL, 'examples/components.html'),
    '--port',
    String(port()),
    '--no-wait',
  ]);
  url = r.url;
});
test.after(async () => {
  stopAll(dirs);
  await b.close();
});

for (const theme of ['light', 'dark']) {
  test(`components render in ${theme} with no console errors`, async () => {
    const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = watchErrors(page);
    await page.goto(url + '?theme=' + theme);
    await page.waitForFunction(() => window.__vcReady === true);
    assert.equal(
      await page
        .locator('html')
        .getAttribute('class')
        .then((c) => c.includes(theme)),
      true
    );
    assert.equal(await page.locator('.vc-compare .vc-compare-stage').count(), 1);
    assert.equal(await page.locator('.vc-compare-handle[role="slider"]').count(), 1);
    assert.equal(await page.locator('.vc-themes .vc-theme-pane.light').count(), 1);
    assert.equal(await page.locator('.vc-themes .vc-theme-pane.dark').count(), 1);
    assert.equal(await page.locator('.vc-phone .vc-phone-device').count(), 2);
    assert.equal(await page.locator('.vc-motion .vc-motion-plot path.vc-curve').count(), 1);
    assert.equal(await page.locator('.vc-bar').count(), 1);
    // The dark pane really is dark and the light pane really is light, whatever the page theme.
    const bg = await page.evaluate(() =>
      ['.vc-theme-pane.light', '.vc-theme-pane.dark'].map(
        (s) => getComputedStyle(document.querySelector(s)).backgroundColor
      )
    );
    assert.deepEqual(bg, ['rgb(250, 250, 250)', 'rgb(10, 10, 10)']);
    // No pure white page or pure black text anywhere in the frame's own surfaces.
    const page_bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.notEqual(page_bg, 'rgb(255, 255, 255)');
    assert.notEqual(page_bg, 'rgb(0, 0, 0)');
    assert.deepEqual(errors, []);
    await page.close();
  });
}

test('before/after: drag, keyboard and side-by-side', async () => {
  const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(url);
  const handle = page.locator('.vc-compare-handle');
  assert.equal(await handle.getAttribute('aria-valuenow'), '50');
  await handle.focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await handle.getAttribute('aria-valuenow'), '48');
  await page.keyboard.press('Shift+ArrowRight');
  assert.equal(await handle.getAttribute('aria-valuenow'), '58');
  await page.keyboard.press('Home');
  assert.equal(await handle.getAttribute('aria-valuenow'), '0');
  const stage = await page.locator('.vc-compare-stage').boundingBox();
  await page.mouse.move(stage.x + stage.width * 0.25, stage.y + stage.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width * 0.75, stage.y + stage.height / 2, { steps: 5 });
  await page.mouse.up();
  assert.equal(await handle.getAttribute('aria-valuenow'), '75');
  const clip = await page
    .locator('.vc-compare-pane[data-side="after"]')
    .evaluate((el) => getComputedStyle(el).clipPath);
  assert.match(clip, /inset\(0px 0px 0px 75%\)/);
  await page.locator('.vc-compare .vc-seg button', { hasText: 'Side by side' }).click();
  assert.equal(await page.locator('.vc-compare').getAttribute('data-mode'), 'split');
  const [a, c] = await page
    .locator('.vc-compare-pane')
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().left));
  assert.ok(c > a + 100, 'panes sit side by side');
  await page.close();
});

test('phone frame is 390×844 and scales down to fit a narrow column', async () => {
  const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(url);
  const box = await page
    .locator('.vc-phone-screen')
    .first()
    .evaluate((el) => ({ w: el.offsetWidth, h: el.offsetHeight }));
  assert.deepEqual(box, { w: 390, h: 844 });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.waitForTimeout(150);
  const w = await page
    .locator('.vc-phone-fit')
    .first()
    .evaluate((el) => el.getBoundingClientRect().width);
  assert.ok(w < 360, 'scaled to the column, got ' + w);
  await page.close();
});

test('motion playground: plays, retargets mid-flight, reports, and copies values to events', async () => {
  const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(url);
  const subject = page.locator('.vc-motion-subject');
  const x = () => subject.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41);
  assert.equal(await x(), 0);
  await page.locator('.vc-motion .vc-btn', { hasText: 'Play' }).click();
  await page.waitForTimeout(60);
  const mid = await x();
  assert.ok(mid > 0, 'moving after 60ms');
  // Interrupt mid-flight. Velocity must stay continuous: no frame step beyond
  // the spring's own peak speed on a clean run.
  const sample = (interruptAt) =>
    page.evaluate(async (at) => {
      const el = document.querySelector('.vc-motion-subject');
      const btn = [...document.querySelectorAll('.vc-motion .vc-btn')].find((b) =>
        b.textContent.includes('Play')
      );
      const x = () => new DOMMatrix(getComputedStyle(el).transform).m41;
      const xs = [];
      btn.click();
      for (let i = 0; i < 40; i++) {
        if (i === at) btn.click();
        await new Promise((r) => requestAnimationFrame(r));
        xs.push(x());
      }
      return xs;
    }, interruptAt);
  await page.reload();
  const free = await sample(-1);
  const peak = Math.max(...free.slice(1).map((v, i) => Math.abs(v - free[i])));
  await page.reload();
  const xs = await sample(5);
  const steps = xs.slice(1).map((v, i) => Math.abs(v - xs[i]));
  assert.ok(
    Math.max(...steps) <= peak * 1.15 + 2,
    'retarget step ' + Math.max(...steps).toFixed(1) + 'px vs peak ' + peak.toFixed(1)
  );
  assert.ok(xs[4] > xs[0], 'was moving out');
  assert.ok(xs[39] < Math.max(...xs), 'turned around');
  await page.waitForTimeout(700);
  assert.ok(Math.abs(await x()) < 1, 'settled back home');
  assert.match(await page.locator('.vc-motion-stats').textContent(), /Settles in \d+ms/);
  assert.match(await page.locator('.vc-motion-stats').textContent(), /Damping ratio 0\.75/);
  // Stiffness slider updates the values.
  await page.locator('.vc-motion input[type="range"]').first().fill('600');
  assert.match(await page.locator('.vc-motion-code').textContent(), /stiffness: 600, damping: 30/);
  await page.locator('.vc-motion .vc-seg button', { hasText: 'Duration' }).click();
  assert.match(
    await page.locator('.vc-motion-code').textContent(),
    /duration: 0.2, ease: \[0, 0, 0.2, 1\]/
  );
  assert.equal(await page.locator('.vc-motion input[id$="stiffness"]').isVisible(), false);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('.vc-motion .vc-btn', { hasText: 'Copy CSS' }).click();
  await waitFor(() => {
    const f = path.join(vc(dir, ['status']).state_dir, 'events');
    return fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('"type":"motion"');
  });
  await page.close();
});

test("reduced-motion toggle rewrites the screen's own media rules and the playground jumps", async () => {
  const d = project();
  dirs.push(d);
  const html = `<style>.box{transition:transform 300ms}@media (prefers-reduced-motion: reduce){.box{transition:none}}</style>
<div class="box" style="width:40px;height:40px">x</div><div class="vc-motion"></div>`;
  const r = vc(d, ['show', write(d, 'rm.html', html), '--port', String(port()), '--no-wait']);
  const page = await b.newPage();
  await page.goto(r.url);
  const tr = () => page.locator('.box').evaluate((el) => getComputedStyle(el).transitionDuration);
  assert.equal(await tr(), '0.3s');
  await page.keyboard.press('m');
  assert.equal(await tr(), '0s');
  assert.equal(
    await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
    true
  );
  assert.match(page.url(), /motion=reduce/);
  assert.match(await page.locator('.vc-motion-stats').textContent(), /Reduced motion/);
  await page.locator('.vc-motion .vc-btn', { hasText: 'Play' }).click();
  const x = await page
    .locator('.vc-motion-subject')
    .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41);
  assert.ok(x > 100, 'jumped straight to the end');
  await page.keyboard.press('m');
  assert.equal(await tr(), '0.3s');
  // Survives a reload via the URL.
  await page.keyboard.press('m');
  await page.reload();
  assert.equal(await tr(), '0s');
  await page.close();
});

test('theme toggle flips the page, writes ?theme= and survives reload; meta and default apply', async () => {
  const page = await b.newPage();
  await page.goto(url);
  assert.equal(
    await page.evaluate(() => document.documentElement.className.includes('light')),
    true
  );
  await page.keyboard.press('t');
  assert.equal(
    await page.evaluate(() => document.documentElement.classList.contains('dark')),
    true
  );
  assert.match(page.url(), /theme=dark/);
  await page.reload();
  assert.equal(
    await page.evaluate(() => document.documentElement.classList.contains('dark')),
    true
  );
  // Per-screen meta.
  const d = project();
  dirs.push(d);
  const r = vc(d, [
    'show',
    write(d, 'm.html', '<meta name="vc-theme" content="dark"><h2>Dark by meta</h2>'),
    '--port',
    String(port()),
    '--no-wait',
  ]);
  await page.goto(r.url);
  assert.equal(
    await page.evaluate(() => document.documentElement.classList.contains('dark')),
    true
  );
  // Session default from `vc theme` (what get_ui_state said).
  vc(d, ['show', write(d, 'n.html', '<h2>Default</h2>'), '--no-wait']);
  vc(d, ['theme', 'dark']);
  await page.close();
  const fresh = await b.newPage();
  await fresh.goto(r.url + '?screen=n');
  assert.equal(
    await fresh.evaluate(() => document.documentElement.classList.contains('dark')),
    true
  );
  await fresh.close();
});

test('app.css opt-in loads the real DorkOS utilities', async () => {
  const d = project();
  dirs.push(d);
  const html =
    '<div class="bg-card text-muted-foreground shadow-elevated rounded-xl p-4 text-sm" id="t">App classes</div>';
  const r = vc(d, [
    'show',
    write(d, 'app.html', html),
    '--app-css',
    '--port',
    String(port()),
    '--no-wait',
  ]);
  const page = await b.newPage();
  const errors = watchErrors(page);
  await page.goto(r.url);
  const s = await page.locator('#t').evaluate((el) => {
    const c = getComputedStyle(el);
    return {
      pad: c.paddingTop,
      size: c.fontSize,
      radius: c.borderTopLeftRadius,
      shadow: c.boxShadow !== 'none',
    };
  });
  assert.deepEqual(s, { pad: '16px', size: '14px', radius: '12px', shadow: true });
  assert.deepEqual(errors, []);
  await page.close();
});
