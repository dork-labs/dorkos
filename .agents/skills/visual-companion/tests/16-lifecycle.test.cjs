// The agent's chat lifecycle, as DorkOS reports it (status.lifecycle: idle |
// streaming | blocked | error | interrupted), drives what a sent note says. It is
// matched exactly: blocked reads as "needs you", and a word outside the enum
// (another case, a near miss) is unknown, never "on it".
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {
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

const dirs = [];
const servers = [];
let b, staticPort;

test.before(async () => {
  b = await browser();
  const s = await serveDir(buildExample());
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

test('blocked says it needs you; words outside the enum are not "on it"', async () => {
  const fake = { lifecycle: 'blocked' };
  const dork = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(req.method === 'GET' ? 200 : 202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'chat-b', status: { lifecycle: fake.lifecycle } }));
    });
  });
  servers.push(dork);
  const env = { DORKOS_PORT: String(dork.address().port) };
  const dir = project();
  dirs.push(dir);
  const s = vc(dir, ['start', '--port', String(port())], { env });
  const open = vc(
    dir,
    [
      'review',
      'open',
      `http://localhost:${staticPort}/index.html`,
      '--name',
      'blk',
      '--wake',
      '--session',
      'chat-b',
      '--label',
      'Tester',
    ],
    { env }
  );
  const statusOf = async () =>
    (await fetch(s.url.replace(/\/?$/, '/') + 'vc/review-status?screen=blk')).json();
  const page = await b.newPage({ viewport: { width: 1280, height: 860 } });
  await page.goto(open.url);
  await page.waitForFunction(() => window.__review && window.director);
  await note(page, 1, 'Let long titles wrap');
  await page.evaluate(() => window.__review.openPanel(true));
  await page.locator('.vc-rpanel .vc-send2').click();

  // blocked: delivered, and the chat waits on the person.
  await waitFor(
    async () => /Tester needs you/.test(await txt(page, '.vc-rpanel')),
    15000,
    200,
    'needs you'
  );
  assert.match(
    await page.locator('.vc-rbar .vc-rstat').getAttribute('aria-label'),
    /Tester needs you/
  );
  assert.equal(
    await page.locator('.vc-rpanel').getByRole('button', { name: 'Open chat' }).isVisible(),
    true
  );
  const st = await statusOf();
  assert.equal(st.lifecycle, 'blocked');
  assert.equal(st.working, false);
  await shot(page, 'needs-you-light');
  await page.evaluate(() => window.director.set('theme', 'dark'));
  await page.evaluate(() => window.__review.openPanel(true));
  await page.waitForTimeout(200);
  await shot(page, 'needs-you-dark');

  // Not in DorkOS's enum (or not its case): unknown, so just "with", never "on it".
  for (const word of ['running', 'Streaming', 'streaming-ish']) {
    fake.lifecycle = word;
    await waitFor(async () => /With Tester/.test(await txt(page, '.vc-rpanel')), 15000, 200, word);
    assert.doesNotMatch(await txt(page, '.vc-rpanel'), /is on it|needs you/);
    const u = await statusOf();
    assert.equal(u.lifecycle, null, word + ' reads as unknown');
    assert.equal(u.working, null);
  }
  fake.lifecycle = 'streaming';
  await waitFor(
    async () => /Tester is on it/.test(await txt(page, '.vc-rpanel')),
    15000,
    200,
    'on it'
  );
  assert.equal((await statusOf()).working, true);
  for (const word of ['idle', 'error', 'interrupted']) {
    fake.lifecycle = word;
    await waitFor(
      async () => /Still open with Tester/.test(await txt(page, '.vc-rpanel')),
      15000,
      200,
      word
    );
  }
  await page.close();
});
