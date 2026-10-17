// One server, several chats: a Send goes back to the chat that showed that
// screen, not to whichever chat ran `vc show` last.
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

test('each screen wakes the chat that showed it', async () => {
  const calls = [];
  server = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(req.method === 'GET' ? 200 : 202, { 'Content-Type': 'application/json' });
      if (req.method !== 'GET') calls.push({ url: req.url, body: JSON.parse(body || '{}') });
      res.end('{}');
    });
  });
  const env = { DORKOS_PORT: String(server.address().port) };
  const dir = project();
  dirs.push(dir);
  const p = String(port());
  const a = vc(
    dir,
    [
      'show',
      write(dir, 'from-a.html', screen('From A', OPTIONS)),
      '--wake',
      '--session',
      'chat-a',
      '--port',
      p,
      '--no-wait',
    ],
    { env }
  );
  vc(
    dir,
    [
      'show',
      write(dir, 'from-b.html', screen('From B', OPTIONS)),
      '--wake',
      '--session',
      'chat-b',
      '--port',
      p,
      '--no-wait',
    ],
    { env }
  );
  const page = await b.newPage();
  // Chat B showed last, but a Send on A's screen still goes to chat A.
  await page.goto(a.url + '?screen=from-a');
  await page.locator('[data-choice="a"]').click();
  await page.locator('.vc-send-btn').click();
  await waitFor(() => calls.length >= 1, 8000, 50, 'A delivered');
  assert.equal(calls[0].url, '/api/sessions/chat-a/ui-action');
  assert.match(calls[0].body.widgetTitle, /From A/);
  await page.goto(a.url + '?screen=from-b');
  await page.locator('[data-choice="b"]').click();
  await page.locator('.vc-send-btn').click();
  await waitFor(() => calls.length >= 2, 8000, 50, 'B delivered');
  assert.equal(calls[1].url, '/api/sessions/chat-b/ui-action');
  assert.match(calls[1].body.widgetTitle, /From B/);
  await page.close();
});
