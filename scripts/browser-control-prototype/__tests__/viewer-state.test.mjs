import test from 'node:test';
import assert from 'node:assert/strict';
import { setupViewer as setup } from './viewer-test-setup.mjs';
// A delayed real capture response must not revoke the newly acknowledged local control state.
test('delayed pre-takeover frame preserves the newer controller epoch', async (t) => {
  const s = await setup(t);
  const page = await s.open(s.human);
  let captured, release, releaseLater;
  const caught = new Promise((r) => (captured = r)),
    gate = new Promise((r) => (release = r)),
    laterFrames = new Promise((r) => (releaseLater = r));
  t.after(() => {
    release();
    releaseLater();
  });
  let held = false;
  await page.route('**/frame', async (route) => {
    if (held) {
      // Keep every later frame from masking the response under observation.
      await laterFrames;
      return route.abort().catch(() => {}); // The frontend may already be closed by cleanup.
    }
    held = true;
    const response = await route.fetch();
    const old = JSON.parse(response.headers()['x-control-state']);
    captured({ old, receipt: JSON.parse(response.headers()['x-frame-receipt']) });
    await gate;
    await route.fulfill({ response });
  });
  const { old, receipt } = await caught;
  assert.equal(old.controllerId, 'agent-a');
  await page.getByRole('button', { name: 'Take control' }).click();
  await page.waitForFunction((epoch) => {
    const state = globalThis.viewer.controlState();
    return state?.controllerId === 'human-a' && state.epoch > epoch && state.status === 'ready';
  }, old.epoch);
  const current = await page.evaluate(() => globalThis.viewer.controlState());
  release();
  await page.waitForFunction(
    (seq) => globalThis.viewer.current()?.captureSequence === seq,
    receipt.captureSequence
  );
  // Observe delivery of the held response before a later frame can mask a regression.
  await page.evaluate(() => new Promise((r) => globalThis.requestAnimationFrame(r)));
  try {
    assert.deepEqual(await page.evaluate(() => globalThis.viewer.controlState()), current);
  } finally {
    releaseLater();
  }
});

// Epochs belong to tabs: a response from a detached view cannot update a newly connected tab.
test('late state response from detached tab cannot replace the reconnected tab state', async (t) => {
  const s = await setup(t);
  const page = await s.open(s.human);
  const browser = await s.manager.openClean();
  const tab = s.manager.getTab(browser.tabIds[0]);
  await tab.page.goto(s.fixture.url + '/?marker=RECONNECTED-B');
  const token = s.viewer.control.issueParticipant({
    actorId: 'human-b',
    kind: 'human',
    tabIds: [tab.tabId],
    canControl: true,
  });
  await s.viewer.control.acquire(token, tab.tabId).barrier;
  let caught, release;
  const captured = new Promise((r) => (caught = r)),
    gate = new Promise((r) => (release = r));
  t.after(() => release());
  let held = false;
  await page.route('**/state', async (route) => {
    if (held) return route.continue();
    held = true;
    const response = await route.fetch();
    caught();
    await gate;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Take control' }).click();
  await captured;
  await page.evaluate(
    async ({ token, tabId }) => {
      await globalThis.viewer.disconnect();
      await globalThis.viewer.connect({ token, tabId });
    },
    { token, tabId: tab.tabId }
  );
  await page.waitForFunction((id) => globalThis.viewer.current()?.tabId === id, tab.tabId);
  const expected = await page.evaluate(() => globalThis.viewer.controlState());
  assert.equal(expected.controllerId, 'human-b');
  const resolved = page.waitForResponse((r) => new URL(r.url()).pathname === '/state');
  release();
  await resolved;
  await page.evaluate(
    () =>
      new Promise((r) =>
        globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(r))
      )
  );
  assert.deepEqual(await page.evaluate(() => globalThis.viewer.controlState()), expected);
});
