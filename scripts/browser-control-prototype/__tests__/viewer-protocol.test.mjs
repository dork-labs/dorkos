import test from 'node:test';
import assert from 'node:assert/strict';
import { setupViewer as setup } from './viewer-test-setup.mjs';

async function post(s, path, body) {
  return fetch(s.viewer.url + path, {
    method: 'POST',
    headers: {
      origin: s.viewer.url,
      authorization: 'Bearer ' + s.observer,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}
async function subscription(s) {
  return (await (await post(s, '/subscribe', { tabId: s.tab.tabId })).json()).viewerId;
}
async function receipt(response) {
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  return JSON.parse(response.headers.get('x-frame-receipt'));
}

test('next frame accepts exactly one genuine prior render receipt and retains legacy ACK', async (t) => {
  const s = await setup(t);
  const viewerId = await subscription(s);
  const first = await receipt(await post(s, '/frame', { viewerId }));
  assert.equal((await post(s, '/frame', { viewerId })).status, 409);
  assert.equal(
    (await post(s, '/frame', { viewerId, receipt: { ...first, epoch: first.epoch + 1 } })).status,
    403
  );
  assert.equal(s.viewer.stats().rendered, 0);
  const next = await post(s, '/frame', { viewerId, receipt: first });
  assert.equal(next.status, 200); // Red on the original protocol: optional receipt is refused.
  const second = await receipt(next);
  assert.ok(second.captureSequence > first.captureSequence);
  assert.equal(s.viewer.stats().rendered, 1);
  assert.equal((await post(s, '/frame', { viewerId, receipt: first })).status, 403);
  assert.equal((await post(s, '/ack', { viewerId, receipt: first })).status, 403);
  assert.equal(s.viewer.stats().rendered, 1);
  assert.equal((await post(s, '/ack', { viewerId, receipt: second })).status, 200);
  assert.equal((await post(s, '/ack', { viewerId, receipt: second })).status, 403);
  assert.equal(s.viewer.stats().rendered, 2);
  assert.equal((await post(s, '/unsubscribe', { viewerId })).status, 200);
  assert.equal((await post(s, '/frame', { viewerId, receipt: second })).status, 403);
});

test('pending frame requests stay bounded and an aborted response cannot fabricate a render', async (t) => {
  const s = await setup(t);
  const viewerId = await subscription(s);
  const first = await receipt(await post(s, '/frame', { viewerId }));
  await s.viewer.pauseCapture(s.tab.tabId);
  // Publish a known second capture, then hold the next response with no new captures.
  s.viewer.publish(s.tab.tabId, await s.manager.capture(s.tab.tabId));
  const second = await receipt(await post(s, '/frame', { viewerId, receipt: first }));
  const abort = new AbortController();
  const waiting = fetch(s.viewer.url + '/frame', {
    method: 'POST',
    signal: abort.signal,
    headers: {
      origin: s.viewer.url,
      authorization: 'Bearer ' + s.observer,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ viewerId, receipt: second }),
  });
  waiting.catch(() => {});
  t.after(() => abort.abort());
  for (let n = 0; n < 100 && s.viewer.stats().rendered !== 2; n++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.viewer.stats().rendered, 2);
  assert.equal((await post(s, '/frame', { viewerId, receipt: second })).status, 409);
  abort.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  for (let n = 0; n < 100 && s.viewer.stats().viewers; n++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.viewer.stats().viewers, 0);
  assert.equal(s.viewer.stats().rendered, 2);
  const replacement = await subscription(s);
  for (let n = 0; n < 5; n++) s.viewer.publish(s.tab.tabId, await s.manager.capture(s.tab.tabId));
  const state = s.viewer.stats().viewerStates[0];
  assert.equal(state.pendingFrames, 1);
  assert.ok(state.pendingBytes <= 2 * 1024 * 1024);
  const fresh = await receipt(await post(s, '/frame', { viewerId: replacement }));
  assert.ok(fresh.captureSequence > second.captureSequence);
  assert.equal(s.viewer.stats().rendered, 2);
});

test('real frontend recovers a lost frame response without acknowledging undrawn pixels', async (t) => {
  const s = await setup(t);
  const page = await s.open(s.human);
  let caught, release;
  const intercepted = new Promise((r) => (caught = r));
  const gate = new Promise((r) => (release = r));
  t.after(() => release());
  let held = false;
  await page.route('**/frame', async (route) => {
    if (held) return route.continue();
    held = true;
    const response = await route.fetch();
    const lost = JSON.parse(response.headers()['x-frame-receipt']);
    caught(lost);
    await gate;
    await route.abort('failed');
  });
  const lost = await intercepted;
  release();
  await page.waitForFunction(
    (seq) => globalThis.viewer.current()?.captureSequence > seq,
    lost.captureSequence
  );
  assert.equal(
    s.viewer.stats().renderAcks.some((a) => a.receipt.captureSequence === lost.captureSequence),
    false
  );
  assert.equal(s.viewer.stats().viewers, 1);
  assert.equal(s.viewer.control.state(s.tab.tabId).controllerId, 'agent-a');
  await page.evaluate(() => globalThis.viewer.disconnect());
  assert.equal(s.viewer.stats().viewers, 0);
  assert.equal(s.manager.getTab(s.tab.tabId).page.isClosed(), false);
});
