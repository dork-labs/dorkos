// Review fixes: choices read as choices, picks survive navigation, a jump
// list, the bar doesn't flash between screens, Send moves on to the next unsent
// screen, and the reply dock sends a written reply and remembers what was sent.
const test = require('node:test');
const assert = require('node:assert');
const {
  project,
  vc,
  write,
  screen,
  OPTIONS,
  port,
  browser,
  waitFor,
  stopAll,
  listen,
  events,
  watchErrors,
} = require('./lib.cjs');

const dirs = [];
let b, server;
test.before(async () => (b = await browser()));
test.after(async () => {
  if (server) {
    server.closeAllConnections();
    server.close();
  }
  stopAll(dirs);
  await b.close();
});

function three(dir, p, env, extra = []) {
  const shown = [];
  for (const n of ['one', 'two', 'three'])
    shown.push(
      vc(
        dir,
        [
          'show',
          write(dir, n + '.html', screen('Screen ' + n, OPTIONS)),
          '--port',
          p,
          '--no-wait',
          ...extra,
        ],
        { env }
      )
    );
  return shown;
}

test('choices get a radio and a "Choose one" label', async () => {
  const dir = project();
  dirs.push(dir);
  const [r] = three(dir, String(port()), {});
  const page = await b.newPage();
  await page.goto(r.url + '?screen=one');
  assert.ok(await page.locator('.vc-choose').first().isVisible());
  assert.equal(
    await page.locator('[data-choice] > .vc-radio').count(),
    await page.locator('[data-choice]').count()
  );
  await page.locator('[data-choice="a"]').click();
  await page.waitForTimeout(250); // the fill transitions in over 150ms
  const filled = await page.$eval(
    '[data-choice="a"] .vc-radio',
    (e) => getComputedStyle(e).backgroundColor
  );
  assert.notEqual(filled, 'rgba(0, 0, 0, 0)', 'selected radio fills');
  await page.close();
});

test('picks survive moving to another screen and back', async () => {
  const dir = project();
  dirs.push(dir);
  const [r] = three(dir, String(port()), {});
  const page = await b.newPage();
  await page.goto(r.url + '?screen=one');
  await page.locator('[data-choice="b"]').click();
  await waitFor(() => events(dir).some((e) => e.type === 'select'), 3000, 50, 'pick saved');
  await page.goto(r.url + '?screen=two');
  await page.goto(r.url + '?screen=one');
  assert.equal(
    await page.$eval('[data-choice="b"]', (e) => e.classList.contains('selected')),
    true
  );
  await page.close();
});

test('the bar stays open across prev/next with no entrance animation', async () => {
  const dir = project();
  dirs.push(dir);
  const [r] = three(dir, String(port()), {});
  const page = await b.newPage();
  await page.goto(r.url + '?screen=one');
  await page.mouse.move(600, 20);
  await page.waitForTimeout(200);
  // Record the bar's classes the moment the next page builds it: vc-noanim only
  // lasts two frames, so reading it after the load would race.
  await page.addInitScript(() => {
    new MutationObserver((_, obs) => {
      const bar = document.querySelector('.vc-bar');
      if (!bar) return;
      window.__vcBarAtStart = bar.className;
      obs.disconnect();
    }).observe(document, { childList: true, subtree: true });
  });
  await page.locator('.vc-iconbtn[aria-label="Next screen"]').click();
  await page.waitForURL(/screen=two/);
  const start = await page.waitForFunction(() => window.__vcBarAtStart).then((h) => h.jsonValue());
  assert.match(start, /\bvc-show\b/, 'open on arrival');
  assert.match(start, /\bvc-noanim\b/, 'no entrance on arrival');
  await page.close();
});

test('G opens a jump list that filters and jumps', async () => {
  const dir = project();
  dirs.push(dir);
  const p = String(port());
  three(dir, p, {});
  const extra = [];
  for (let i = 4; i <= 9; i++)
    extra.push(
      vc(dir, [
        'show',
        write(dir, 's' + i + '.html', screen('Extra ' + i)),
        '--port',
        p,
        '--no-wait',
      ])
    );
  const page = await b.newPage();
  await page.goto(extra[0].url + '?screen=one');
  await page.mouse.move(600, 600);
  await page.keyboard.press('g');
  await page.locator('.vc-jump').waitFor();
  assert.equal(await page.locator('.vc-jump-item').count(), 9);
  await page.locator('.vc-jump-filter').fill('three');
  assert.equal(await page.locator('.vc-jump-item').count(), 1);
  await page.keyboard.press('Enter');
  await page.waitForURL(/screen=three/);
  await page.close();
});

test('Send moves on to the next unsent screen; the last says it was the last screen', async () => {
  const calls = [];
  server = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method !== 'GET') calls.push(req.url);
      res.writeHead(req.method === 'GET' ? 200 : 202, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  const env = { DORKOS_PORT: String(server.address().port) };
  const dir = project();
  dirs.push(dir);
  const [r] = three(dir, String(port()), env, ['--wake', '--session', 'chat-x']);
  const page = await b.newPage();
  await page.goto(r.url + '?screen=two');
  await page.locator('[data-choice="a"]').click();
  await page.locator('.vc-send-btn').click();
  await page.waitForURL((u) => !/screen=two/.test(u.toString()), { timeout: 5000 });
  assert.match(await page.locator('h2').first().textContent(), /three/i);
  await page.locator('[data-choice="b"]').click();
  await page.locator('.vc-send-btn').click();
  await waitFor(
    async () => /last screen/.test((await page.locator('.vc-send-text').textContent()) || ''),
    3000
  );
  await waitFor(() => calls.length >= 2, 8000, 50, 'both delivered');
  await page.close();
});

test('a written reply sends on its own, and the screen remembers what was sent', async () => {
  const bodies = [];
  const srv = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method !== 'GET') bodies.push(JSON.parse(body || '{}'));
      res.writeHead(req.method === 'GET' ? 200 : 202, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  try {
    const env = { DORKOS_PORT: String(srv.address().port) };
    const dir = project();
    dirs.push(dir);
    const [r] = three(dir, String(port()), env, [
      '--wake',
      '--session',
      'chat-y',
      '--label',
      'Tester',
    ]);
    const page = await b.newPage();
    await page.goto(r.url + '?screen=three');
    assert.equal(await page.locator('.vc-send-btn').isDisabled(), true, 'nothing to send yet');
    await page.locator('.vc-own').first().click();
    await page.locator('.vc-send-input').fill('Neither; make it a toggle');
    await page.keyboard.press('Enter');
    await waitFor(() => bodies.length >= 1, 8000, 50, 'delivered');
    assert.equal(bodies[0].payload.screens[0].message, 'Neither; make it a toggle');
    await page.reload();
    await waitFor(
      async () =>
        /Sent to @Tester at/.test((await page.locator('.vc-send-text').textContent()) || ''),
      3000
    );
    assert.match(await page.locator('.vc-send-text').textContent(), /make it a toggle/);
    // A pick now turns it back into a send.
    await page.locator('[data-choice="a"]').click();
    await waitFor(
      async () => /Send update/.test((await page.locator('.vc-send-btn').textContent()) || ''),
      2000
    );
    await page.close();
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});

test('the reply dock keeps working after a pin note is dropped', async () => {
  const dir = project();
  dirs.push(dir);
  const [r] = three(dir, String(port()), {}, ['--wake', '--session', 'chat-z']);
  const page = await b.newPage();
  const errors = watchErrors(page);
  await page.goto(r.url + '?screen=one');
  // A pin note in progress used to shadow the dock's reply-draft reader, so
  // every later pick threw and the dock froze.
  await page.keyboard.press('c');
  const box = await page.locator('h2').boundingBox();
  await page.mouse.click(box.x + 20, box.y + 10);
  await page.locator('.vc-note textarea').fill('A note');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.locator('[data-choice="a"]').click();
  await waitFor(
    async () => /A · Quiet/.test((await page.locator('.vc-send-text').textContent()) || ''),
    3000,
    50,
    'dock shows the pick'
  );
  assert.equal(await page.locator('.vc-send-btn').isDisabled(), false);
  assert.deepEqual(errors, []);
  await page.close();
});
