import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { loadPlaywright } from '../runtime.mjs';
import { injectRtt } from '../mechanics/mechanics-transport.mjs';
// Teardown waits for a known in-flight route.fetch rather than closing its Page underneath it.
test('RTT teardown drains an actual delayed fetch and leaves no active route callback', async (t) => {
  let received, finish;
  const fetching = new Promise((r) => (received = r)),
    responseGate = new Promise((r) => (finish = r));
  const server = createServer(async (req, res) => {
    if (req.url === '/frame') {
      received();
      await responseGate;
      res.end('fake-fixture-frame');
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end('<title>Fixture transport</title>');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    finish();
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });
  const runtime = await loadPlaywright({
    repoRoot: resolve(new URL('../../../', import.meta.url).pathname),
  });
  const browser = await runtime.chromium.launch(runtime.launchOptions);
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const transport = await injectRtt(page, 150);
  t.after(() => transport.close());
  const request = page.evaluate(() =>
    fetch('/frame')
      .then((r) => r.text())
      .catch(() => null)
  );
  await fetching;
  assert.equal(transport.activeCount(), 1);
  const closing = transport.close();
  finish();
  await closing;
  await request;
  assert.equal(transport.activeCount(), 0);
  assert.equal(transport.error(), null);
  assert.equal(page.isClosed(), false);
});
