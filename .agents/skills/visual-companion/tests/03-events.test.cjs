// Clicks and pin notes land in events; only explicit intent on a vc-wake
// screen wakes the agent (a stub DorkOS stands in for the real one).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  project,
  vc,
  write,
  screen,
  OPTIONS,
  port,
  browser,
  watchErrors,
  events,
  waitFor,
  stopAll,
  listen,
} = require('./lib.cjs');

const dirs = [];
const stubs = [];
let b;
test.before(async () => (b = await browser()));
test.after(async () => {
  stubs.forEach((c) => c());
  stopAll(dirs);
  await b.close();
});

test('a click on a choice is recorded with its screen; vc events reads only what is new', async () => {
  const dir = project();
  dirs.push(dir);
  const r = vc(dir, [
    'show',
    write(dir, 'pick.html', screen('Pick one', OPTIONS)),
    '--port',
    String(port()),
    '--no-wait',
  ]);
  const page = await b.newPage();
  const errors = watchErrors(page);
  await page.goto(r.url);
  await page.locator('[data-choice="b"]').click();
  await waitFor(() => events(dir).some((e) => e.type === 'click'));
  const click = events(dir).find((e) => e.type === 'click');
  assert.equal(click.choice, 'b');
  assert.equal(click.screen, 'pick');
  assert.equal(click.theme, 'light');
  assert.equal(await page.locator('[data-choice="b"]').getAttribute('aria-pressed'), 'true');
  // Keyboard: Tab to option A and press Space.
  await page.locator('[data-choice="a"]').focus();
  await page.keyboard.press(' ');
  await waitFor(() => events(dir).filter((e) => e.type === 'click').length === 2);
  // Each pick also saves the screen's selection (a `select` event).
  const clicksIn = (out) =>
    out
      .trim()
      .split('\n')
      .filter((l) => JSON.parse(l).type === 'click').length;
  await waitFor(() => events(dir).filter((e) => e.type === 'select').length === 2);
  assert.equal(clicksIn(vc(dir, ['events'], { raw: true }).stdout), 2);
  assert.equal(vc(dir, ['events'], { raw: true }).stdout.trim(), '', 'cursor advanced');
  assert.equal(clicksIn(vc(dir, ['events', '--all'], { raw: true }).stdout), 2);
  assert.deepEqual(errors, []);
  await page.close();
});

test('a pin note is recorded with x/y, a selector and the note, and survives a reload', async () => {
  const dir = project();
  dirs.push(dir);
  const r = vc(dir, [
    'show',
    write(dir, 'pins.html', screen('Pin me', OPTIONS)),
    '--port',
    String(port()),
    '--no-wait',
  ]);
  const page = await b.newPage();
  await page.goto(r.url);
  await page.keyboard.press('c');
  assert.equal(
    await page.locator('.vc-bar button[aria-label="Pin a note"]').getAttribute('aria-pressed'),
    'true'
  );
  const box = await page.locator('[data-choice="a"] h3').boundingBox();
  await page.mouse.click(box.x + 10, box.y + 8);
  await page.locator('.vc-note textarea').fill('Make this calmer');
  await page.keyboard.press('Enter');
  await waitFor(() => events(dir).some((e) => e.type === 'pin'));
  const pin = events(dir).find((e) => e.type === 'pin');
  assert.equal(pin.n, 1);
  assert.equal(pin.note, 'Make this calmer');
  assert.equal(pin.screen, 'pins');
  assert.ok(
    Math.abs(pin.x - (box.x + 10)) <= 1 && Math.abs(pin.y - (box.y + 8)) <= 1,
    'x/y are page coordinates'
  );
  assert.match(pin.selector, /h3/);
  assert.ok(pin.rel && pin.rel.x >= 0 && pin.rel.x <= 1);
  // The click in pin mode did not select the option underneath.
  assert.equal(events(dir).filter((e) => e.type === 'click').length, 0);
  await page.keyboard.press('Escape');
  assert.equal(
    await page.locator('html').evaluate((el) => el.classList.contains('vc-pinning')),
    false
  );
  await page.reload();
  await page.locator('.vc-pin').first().waitFor();
  assert.equal(await page.locator('.vc-pin').count(), 1);
  // Remove it.
  await page.locator('.vc-pin').first().click();
  await page.locator('.vc-note [data-act="delete"]').click();
  await waitFor(() => events(dir).some((e) => e.type === 'pin-delete'));
  await page.reload();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.vc-pin').count(), 0);
  await page.close();
});

async function stubDorkos() {
  const calls = [];
  let busy = 1;
  const server = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: 'test-session', title: 'Test chat' }));
      }
      calls.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
      if (busy-- > 0) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end('{"code":"SESSION_LOCKED"}');
      }
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end('{"sessionId":"test-session"}');
    });
  });
  const close = () => {
    server.closeAllConnections();
    server.close();
  };
  stubs.push(close);
  return { server, calls, port: server.address().port, close };
}

test('on a vc-wake screen, Send wakes the chat that ran vc show, once, with selection and pins', async () => {
  const stub = await stubDorkos();
  const dir = project();
  dirs.push(dir);
  const env = { DORKOS_PORT: String(stub.port) };
  const r = vc(
    dir,
    [
      'show',
      write(dir, 'wake.html', screen('Wake me', OPTIONS)),
      '--wake',
      '--session',
      'test-session',
      '--label',
      'Tester',
      '--port',
      String(port()),
      '--no-wait',
    ],
    { env }
  );
  assert.equal(r.route.session, 'test-session');
  const page = await b.newPage();
  await page.goto(r.url);
  // Exploration: several clicks. None of them wakes anyone.
  await page.locator('[data-choice="a"]').click();
  await page.locator('[data-choice="b"]').click();
  await waitFor(
    async () =>
      /B · Busy/.test(
        (await page
          .locator('.vc-send-text')
          .textContent()
          .catch(() => '')) || ''
      ),
    3000,
    50,
    'send bar shows B'
  );
  assert.equal((await page.locator('.vc-send-btn').textContent()).trim(), 'Send to @Tester');
  assert.equal(await page.locator('[data-choice="b"]').getAttribute('aria-label'), 'B · Busy');
  await page.waitForTimeout(1200);
  assert.equal(stub.calls.length, 0, 'clicks alone never wake the agent');
  // Intent: Send.
  await page.locator('.vc-send-btn').click();
  await page.locator('.vc-send.vc-sent').waitFor();
  // First attempt is refused as busy (409), the retry lands.
  await waitFor(() => stub.calls.length >= 2, 12000);
  const ok = stub.calls[1];
  assert.equal(ok.url, '/api/sessions/test-session/ui-action');
  assert.equal(ok.body.actionId, 'visual-companion.send');
  assert.match(ok.body.widgetTitle, /Wake me/);
  assert.deepEqual(
    ok.body.payload.screens[0].selection.map((s) => s.choice),
    ['b']
  );
  assert.match(ok.body.payload.summary[0], /chose B · Busy/);
  // The server logs a delivery after the stub answers, so wait for the line.
  const readLog = () =>
    fs
      .readFileSync(path.join(r.state_dir, 'route.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
  await waitFor(() => readLog().length >= 2, 3000, 50, 'route.log records the delivery');
  assert.deepEqual(
    readLog().map((l) => l.status),
    ['busy', 'delivered']
  );
  // A submitted pin note is intent too.
  await page.keyboard.press('c');
  const box = await page.locator('h2').boundingBox();
  await page.mouse.click(box.x + 20, box.y + 10);
  await page.locator('.vc-note textarea').fill('Title too loud');
  await page.keyboard.press('Enter');
  await waitFor(() => stub.calls.length >= 3, 6000);
  const pinCall = stub.calls[2].body;
  assert.equal(pinCall.actionId, 'visual-companion.pin');
  assert.equal(pinCall.payload.screens[0].pins[0].note, 'Title too loud');
  assert.deepEqual(pinCall.payload.screens[0].new_pins, [1]);
  await page.close();
  stub.close();
});

test('a screen without vc-wake never wakes anyone, even with a session', async () => {
  const stub = await stubDorkos();
  const dir = project();
  dirs.push(dir);
  const env = { DORKOS_PORT: String(stub.port) };
  const r = vc(
    dir,
    [
      'show',
      write(dir, 'quiet.html', screen('Quiet', OPTIONS)),
      '--session',
      'test-session',
      '--port',
      String(port()),
      '--no-wait',
    ],
    { env }
  );
  const page = await b.newPage();
  await page.goto(r.url);
  await page.locator('[data-choice="a"]').click();
  assert.equal(await page.locator('.vc-send').count(), 0, 'no send bar');
  await page.locator('.vc-toast.vc-show').waitFor();
  assert.match(await page.locator('.vc-toast').textContent(), /noted, reply in chat/);
  // Forge a send from the page: the server checks the screen, not the page.
  await page.evaluate(() => window.vc.send({ type: 'send', selection: [{ choice: 'a' }] }));
  await page.waitForTimeout(1500);
  assert.equal(stub.calls.length, 0);
  assert.ok(
    events(dir).some((e) => e.type === 'send'),
    'still recorded'
  );
  await page.close();
  stub.close();
});

test('vc route off silences a wake screen', async () => {
  const stub = await stubDorkos();
  const dir = project();
  dirs.push(dir);
  const env = { DORKOS_PORT: String(stub.port) };
  const r = vc(
    dir,
    [
      'show',
      write(dir, 'w.html', screen('W', OPTIONS)),
      '--wake',
      '--session',
      'test-session',
      '--port',
      String(port()),
      '--no-wait',
    ],
    { env }
  );
  assert.equal(vc(dir, ['route', 'off'], { env }).route.mode, 'off');
  const page = await b.newPage();
  await page.goto(r.url);
  await page.locator('[data-choice="a"]').click();
  assert.equal(await page.locator('.vc-send').count(), 0);
  await page.evaluate(() => window.vc.send({ type: 'send' }));
  await page.waitForTimeout(1200);
  assert.equal(stub.calls.length, 0);
  await page.close();
  stub.close();
});
