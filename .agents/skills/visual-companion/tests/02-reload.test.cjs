// Live reload: WebSocket, polling when the socket is blocked, and polling
// through a proxy that drops WebSocket upgrades.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const {
  project,
  vc,
  write,
  screen,
  port,
  browser,
  watchErrors,
  waitFor,
  stopAll,
  listen,
} = require('./lib.cjs');

const dirs = [];
let b;
test.before(async () => (b = await browser()));
test.after(async () => {
  stopAll(dirs);
  await b.close();
});

async function setup() {
  const dir = project();
  dirs.push(dir);
  const first = vc(dir, [
    'show',
    write(dir, 'first.html', screen('First screen')),
    '--port',
    String(port()),
    '--no-wait',
  ]);
  return { dir, first };
}
const heading = (page) => page.locator('#claude-content h2').first().textContent();
const dot = (page) => page.locator('.vc-dot').getAttribute('data-state');

test('a second screen arrives over the WebSocket', async () => {
  const { dir, first } = await setup();
  const page = await b.newPage();
  const errors = watchErrors(page);
  await page.goto(first.url);
  await waitFor(async () => (await dot(page)) === 'live');
  vc(dir, ['show', write(dir, 'second.html', screen('Second screen')), '--no-wait']);
  await waitFor(async () => (await heading(page).catch(() => '')) === 'Second screen', 5000);
  assert.equal(await dot(page), 'live');
  assert.deepEqual(errors, []);
  await page.close();
});

test('with WebSocket unavailable, polling picks up the second screen', async () => {
  const { dir, first } = await setup();
  const page = await b.newPage();
  await page.addInitScript(() => {
    window.WebSocket = function () {
      throw new Error('blocked for test');
    };
  });
  await page.goto(first.url);
  await waitFor(async () => (await dot(page)) === 'polling');
  vc(dir, ['show', write(dir, 'second.html', screen('Polled screen')), '--no-wait']);
  await waitFor(async () => (await heading(page).catch(() => '')) === 'Polled screen', 6000);
  await page.close();
});

test('through a proxy that drops WebSocket upgrades, polling takes over', async () => {
  const { dir, first } = await setup();
  const target = new URL(first.url);
  let upgrades = 0;
  const proxy = await listen((req, res) => {
    const up = http.request(
      {
        host: '127.0.0.1',
        port: target.port,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      }
    );
    req.pipe(up);
  });
  proxy.on('upgrade', (req, socket) => {
    upgrades++;
    socket.destroy();
  });
  const page = await b.newPage();
  try {
    await page.goto('http://127.0.0.1:' + proxy.address().port + '/');
    await waitFor(async () => (await dot(page)) === 'polling', 6000);
    assert.ok(upgrades >= 1, 'the page tried the socket first');
    vc(dir, ['show', write(dir, 'second.html', screen('Through the proxy')), '--no-wait']);
    await waitFor(async () => (await heading(page).catch(() => '')) === 'Through the proxy', 6000);
  } finally {
    await page.close();
    proxy.close();
  }
});

test('editing the screen being viewed reloads it in place; a pinned old screen gets a chip, not a jump', async () => {
  const { dir, first } = await setup();
  const page = await b.newPage();
  await page.goto(first.url + '?screen=first');
  await waitFor(async () => (await dot(page)) === 'live');
  // Overwrite in place (same file): an update, not a new screen.
  require('fs').writeFileSync(first.file, screen('First, edited'));
  await waitFor(
    async () => (await heading(page).catch(() => '')) === 'First, edited',
    5000,
    50,
    'edit reload'
  );
  await waitFor(
    async () => (await dot(page).catch(() => null)) === 'live',
    5000,
    50,
    'live after edit'
  );
  vc(dir, ['show', write(dir, 'newer.html', screen('Newer')), '--no-wait']);
  await waitFor(
    () =>
      page
        .locator('.vc-chip')
        .isVisible()
        .catch(() => false),
    5000,
    50,
    'chip'
  );
  assert.equal(await heading(page), 'First, edited', 'stayed on the pinned screen');
  await page.locator('.vc-chip').click();
  await waitFor(
    async () => (await heading(page).catch(() => '')) === 'Newer',
    5000,
    50,
    'chip click'
  );
  await page.close();
});

test('history: chevrons and ⌘←/⌘→ step through every screen', async () => {
  const { dir, first } = await setup();
  vc(dir, ['show', write(dir, 'b.html', screen('Two')), '--no-wait']);
  vc(dir, ['show', write(dir, 'c.html', screen('Three')), '--no-wait']);
  const page = await b.newPage();
  await page.goto(first.url);
  assert.equal(await heading(page), 'Three');
  assert.equal((await page.locator('.vc-count').textContent()).trim(), '3 / 3');
  assert.equal(await page.locator('.vc-bar button[aria-label="Next screen"]').isDisabled(), true);
  await page.keyboard.press('Meta+ArrowLeft');
  await waitFor(async () => (await heading(page).catch(() => '')) === 'Two');
  await page.locator('.vc-bar').evaluate((el) => el.classList.add('vc-show'));
  await page.locator('.vc-bar button[aria-label="Previous screen"]').click();
  await waitFor(async () => (await heading(page).catch(() => '')) === 'First screen');
  assert.equal(
    await page.locator('.vc-bar button[aria-label="Previous screen"]').isDisabled(),
    true
  );
  await page.keyboard.press('Control+ArrowRight');
  await waitFor(async () => (await heading(page).catch(() => '')) === 'Two');
  await page.close();
});
