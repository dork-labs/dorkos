// AA audit of the frame: axe-core over the frame and every piece of chrome
// (bar, toast, send bar, pin note, components) in both themes, plus target
// size, focus rings and the keyboard.
//
// axe's colour-contrast only judges text inside the viewport, so each run
// first proves the page fits the viewport (contributing/design-system.md:
// "an axe run is not a gate until you have proved it can fail").
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {
  SKILL,
  AXE,
  project,
  vc,
  write,
  screen,
  OPTIONS,
  port,
  browser,
  stopAll,
  listen,
} = require('./lib.cjs');

const dirs = [];
let b, stub;
test.before(async () => {
  b = await browser();
  stub = await listen((req, res) => {
    res.writeHead(req.method === 'GET' ? 200 : 202, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
});
test.after(async () => {
  stopAll(dirs);
  stub.closeAllConnections();
  stub.close();
  await b.close();
});

// Resolve axe's checked nodes back to elements, and report which of the
// wanted classes had at least one element (or descendant) contrast-checked.
async function axe(page, wanted) {
  // The bar fades in when it expands (and peeks on a first visit); a contrast
  // check mid-fade reads blended colours, so wait for it to settle.
  await page.waitForFunction(() => {
    const bar = document.querySelector('.vc-bar');
    return !bar || bar.getAnimations({ subtree: true }).every((a) => a.playState !== 'running');
  });
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async (wanted) => {
    const r = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      resultTypes: ['violations', 'passes'],
    });
    const cc = r.passes.find((p) => p.id === 'color-contrast');
    const checked = new Set((cc ? cc.nodes : []).map((n) => document.querySelector(n.target[0])));
    const reached = {};
    for (const cls of wanted || [])
      reached[cls] = [...document.querySelectorAll('.' + cls + ', .' + cls + ' *')].some((el) =>
        checked.has(el)
      );
    return {
      violations: r.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.map(
          (n) => n.target.join(' ') + ' :: ' + n.failureSummary.split('\n').slice(1, 2).join('')
        ),
      })),
      checkedCount: checked.size,
      reached,
    };
  }, wanted || []);
}

async function fits(page) {
  const { h, vh } = await page.evaluate(() => ({
    h: document.documentElement.scrollHeight,
    vh: innerHeight,
  }));
  assert.ok(h <= vh, `page (${h}px) must fit the viewport (${vh}px) or axe skips text below it`);
}

for (const theme of ['light', 'dark']) {
  test(`frame chrome passes axe (WCAG 2.2 AA) in ${theme}`, async () => {
    const dir = project();
    dirs.push(dir);
    const env = { DORKOS_PORT: String(stub.address().port) };
    const r = vc(
      dir,
      [
        'show',
        write(dir, 'a11y.html', screen('Audit', OPTIONS)),
        '--wake',
        '--session',
        's',
        '--label',
        'Tester',
        '--port',
        String(port()),
        '--no-wait',
      ],
      { env }
    );
    const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(r.url + '?theme=' + theme);
    // Bring out every piece of chrome at once.
    await page.locator('[data-choice="a"]').click();
    await page.locator('.vc-send.vc-show').waitFor();
    await page.evaluate(() => document.querySelector('.vc-bar').classList.add('vc-show'));
    await page.keyboard.press('c');
    const box = await page.locator('h2').boundingBox();
    await page.mouse.click(box.x + 200, box.y + 10);
    await page.locator('.vc-note textarea').fill('A note');
    await page.waitForTimeout(250); // let entrances finish so axe sees settled colours
    await fits(page);
    const chrome = [
      'vc-count',
      'vc-where',
      'vc-send-btn',
      'vc-send-text',
      'vc-hint',
      'vc-note',
      'option',
    ];
    const res = await axe(page, chrome);
    // Prove the contrast check reached the chrome, not just the content.
    for (const cls of chrome) assert.ok(res.reached[cls], 'contrast checked .' + cls);
    assert.deepEqual(res.violations, [], JSON.stringify(res.violations, null, 2));
    await page.close();
  });

  test(`components pass axe in ${theme}`, async () => {
    const dir = project();
    dirs.push(dir);
    const r = vc(dir, [
      'show',
      path.join(SKILL, 'examples/components.html'),
      '--port',
      String(port()),
      '--no-wait',
    ]);
    // Tall enough to hold the whole showcase, so nothing escapes the contrast check.
    const page = await b.newPage({ viewport: { width: 1280, height: 3200 } });
    await page.goto(r.url + '?theme=' + theme);
    await page.waitForFunction(() => window.__vcReady === true);
    await fits(page);
    const parts = [
      'vc-motion-stats',
      'vc-motion-row',
      'vc-motion-code',
      'vc-compare-label',
      'vc-theme-tag',
      'vc-phone-caption',
      'vc-phone-status',
      'vc-seg',
      'vc-btn',
      'card-body',
      'pros',
      'cons',
      'mockup-header',
      'mock-button',
    ];
    const res = await axe(page, parts);
    for (const cls of parts) assert.ok(res.reached[cls], 'contrast checked .' + cls);
    assert.deepEqual(res.violations, [], JSON.stringify(res.violations, null, 2));
    await page.close();
  });
}

test('every chrome control is at least 24×24 and shows a 2px brand focus ring', async () => {
  const dir = project();
  dirs.push(dir);
  const env = { DORKOS_PORT: String(stub.address().port) };
  const r = vc(
    dir,
    [
      'show',
      write(dir, 't.html', screen('Targets', OPTIONS)),
      '--wake',
      '--session',
      's',
      '--port',
      String(port()),
      '--no-wait',
    ],
    { env }
  );
  const page = await b.newPage();
  await page.goto(r.url);
  await page.locator('[data-choice="a"]').click();
  await page.evaluate(() => document.querySelector('.vc-bar').classList.add('vc-show'));
  // The collapsed handle is hidden while the bar is expanded; it's checked at rest below.
  const sizes = await page.$$eval('.vc-bar button, .vc-send-btn, .vc-compare-handle', (els) =>
    els
      .filter((e) => e.offsetParent !== null)
      .map((e) => [
        e.getAttribute('aria-label') || e.textContent.trim(),
        e.offsetWidth,
        e.offsetHeight,
      ])
  );
  for (const [name, w, h] of sizes) assert.ok(w >= 24 && h >= 24, `${name} is ${w}×${h}`);
  // Keyboard: Tab from the top lands in the bar first, and the bar reveals itself.
  await page.evaluate(() => sessionStorage.setItem('vc-seen-bar', '1'));
  await page.reload();
  await page.mouse.move(600, 600);
  await page.keyboard.press('Tab');
  const focus = await page.evaluate(() => {
    const el = document.activeElement;
    const c = getComputedStyle(el);
    const bar = getComputedStyle(document.querySelector('.vc-bar'));
    return {
      inBar: !!el.closest('.vc-bar'),
      outline: c.outlineStyle + ' ' + c.outlineWidth,
      color: c.outlineColor,
      barOpacity: bar.opacity,
    };
  });
  assert.equal(focus.inBar, true);
  assert.equal(focus.outline, 'solid 2px');
  assert.equal(focus.color, 'rgb(213, 92, 11)', 'brand orange ring (hsl 24 90% 44%)');
  await page.waitForTimeout(200);
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.querySelector('.vc-bar')).opacity),
    '1',
    'bar shows on focus'
  );
  // Esc closes the pin note, then leaves pin mode.
  await page.keyboard.press('c');
  await page.mouse.click(400, 300);
  await page.locator('.vc-note').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.vc-note').count(), 0);
  assert.equal(
    await page.evaluate(() => document.documentElement.classList.contains('vc-pinning')),
    true
  );
  await page.keyboard.press('Escape');
  assert.equal(
    await page.evaluate(() => document.documentElement.classList.contains('vc-pinning')),
    false
  );
  await page.close();
});

test('at rest the bar is a visible handle; near the top it expands to the full controls', async () => {
  const dir = project();
  dirs.push(dir);
  const r = vc(dir, [
    'show',
    write(dir, 'h.html', screen('Hidden chrome')),
    '--port',
    String(port()),
    '--no-wait',
  ]);
  const page = await b.newPage();
  await page.goto(r.url);
  await page.evaluate(() => sessionStorage.setItem('vc-seen-bar', '1'));
  await page.reload();
  await page.mouse.move(600, 500);
  await page.waitForTimeout(300);
  const vis = (sel) =>
    page.evaluate((s) => getComputedStyle(document.querySelector(s)).display !== 'none', sel);
  assert.equal(await vis('.vc-handle'), true, 'handle visible at rest');
  assert.equal(await vis('.vc-bar-full'), false, 'full controls collapsed at rest');
  const [w, h] = await page.$eval('.vc-handle', (e) => [e.offsetWidth, e.offsetHeight]);
  assert.ok(w >= 24 && h >= 24, `handle is ${w}×${h}`);
  await page.mouse.move(600, 20);
  await page.waitForTimeout(250);
  assert.equal(await vis('.vc-bar-full'), true, 'expanded near the top');
  assert.equal(await vis('.vc-handle'), false);
  await page.mouse.move(600, 500);
  await page.waitForTimeout(700);
  assert.equal(await vis('.vc-bar-full'), false, 'collapses again');
  await page.close();
});

test('the audit can fail: an injected 1.9:1 label is caught', async () => {
  const dir = project();
  dirs.push(dir);
  const r = vc(dir, [
    'show',
    write(dir, 'bad.html', screen('Bad', '<p style="color:hsl(0 0% 78%)">Too faint to read</p>')),
    '--port',
    String(port()),
    '--no-wait',
  ]);
  const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(r.url);
  await fits(page);
  const res = await axe(page, []);
  assert.ok(
    res.violations.some((v) => v.id === 'color-contrast'),
    'contrast violation reported'
  );
  await page.close();
});
