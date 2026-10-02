import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupViewer as setup } from './viewer-test-setup.mjs';

async function publishPointer(s, page, x, y) {
  const tab = s.manager.getTab(s.tab.tabId);
  const state = s.viewer.control.state(s.tab.tabId);
  const action = await s.viewer.control.submit(
    state.controllerId === 'human-a' ? s.human : s.agent,
    {
      requestId: randomUUID(),
      tabId: tab.tabId,
      navigationGeneration: tab.navigationGeneration,
      viewportVersion: tab.viewportVersion,
      epoch: state.epoch,
      action: { type: 'mouseMove', x, y },
    }
  );
  assert.equal(action.outcome, 'completed');
  const capture = await s.manager.capture(s.tab.tabId, {
    epoch: s.viewer.control.state(s.tab.tabId).epoch,
  });
  assert.deepEqual(capture.pointer, {
    tabId: s.tab.tabId,
    navigationGeneration: capture.receipt.navigationGeneration,
    viewportVersion: capture.receipt.viewportVersion,
    x,
    y,
  });
  s.viewer.publish(s.tab.tabId, capture);
  await page.waitForFunction(
    (seq) => globalThis.viewer.current()?.captureSequence === seq,
    capture.receipt.captureSequence
  );
  return capture;
}

test('canonical pointer scales with the captured viewport and clears on control reset and stale frames', async (t) => {
  const s = await setup(t);
  const page = await s.open(s.observer);
  const second = await s.open(s.observer);
  await s.viewer.pauseCapture(s.tab.tabId);
  await page.setViewportSize({ width: 420, height: 900 });
  const centered = await publishPointer(s, page, 640, 360);
  await second.waitForFunction(
    (seq) => globalThis.viewer.current()?.captureSequence === seq,
    centered.receipt.captureSequence
  );
  const pointer = page.locator('#browser-pointer');
  assert.equal(await pointer.isVisible(), true);
  const canvas = await page.locator('#screen').boundingBox();
  const position = await pointer.boundingBox();
  assert.ok(Math.abs(position.x - canvas.x - canvas.width / 2) < 1);
  assert.ok(Math.abs(position.y - canvas.y - canvas.height / 2) < 1);
  const secondCanvas = await second.locator('#screen').boundingBox();
  const secondPointer = await second.locator('#browser-pointer').boundingBox();
  assert.ok(Math.abs(secondPointer.x - secondCanvas.x - secondCanvas.width / 2) < 1);
  assert.ok(Math.abs(secondPointer.y - secondCanvas.y - secondCanvas.height / 2) < 1);
  await s.viewer.control.takeover(s.human, s.tab.tabId).barrier;
  // Publish old pointer data with a current capture epoch: a manager reset cannot retain it.
  const reset = await s.manager.capture(s.tab.tabId, {
    epoch: s.viewer.control.state(s.tab.tabId).epoch,
  });
  assert.equal(reset.pointer, null);
  s.viewer.publish(s.tab.tabId, reset);
  await page.waitForFunction(
    (seq) => globalThis.viewer.current()?.captureSequence === seq,
    reset.receipt.captureSequence
  );
  assert.equal(await pointer.isVisible(), false);
  await publishPointer(s, page, 320, 180);
  assert.equal(await pointer.isVisible(), true);
  await page.waitForFunction(
    () => globalThis.document.getElementById('browser-pointer').hidden,
    null,
    { timeout: 3000 }
  );
  await page.evaluate(() => globalThis.viewer.disconnect());
  assert.equal(await pointer.isVisible(), false);
});

test('pointer metadata cannot cross tab, navigation, viewport or control epochs', async (t) => {
  const s = await setup(t);
  const page = await s.open(s.human);
  await s.viewer.pauseCapture(s.tab.tabId);
  const capture = await publishPointer(s, page, 100, 120);
  for (const field of ['tabId', 'navigationGeneration', 'viewportVersion']) {
    const next = await s.manager.capture(s.tab.tabId, { epoch: capture.receipt.epoch });
    next.pointer = {
      ...capture.pointer,
      [field]: field === 'tabId' ? 'foreign-tab' : capture.pointer[field] + 1,
    };
    assert.throws(() => s.viewer.publish(s.tab.tabId, next), /pointer-identity/);
  }
  // An old-epoch capture delivered with the current /state header must hide its old cursor.
  await s.viewer.control.takeover(s.human, s.tab.tabId).barrier;
  const oldEpoch = await s.manager.capture(s.tab.tabId, { epoch: capture.receipt.epoch });
  oldEpoch.pointer = capture.pointer;
  s.viewer.publish(s.tab.tabId, oldEpoch);
  await page.waitForFunction(
    (seq) => globalThis.viewer.current()?.captureSequence === seq,
    oldEpoch.receipt.captureSequence
  );
  assert.equal(await page.locator('#browser-pointer').isVisible(), false);
  await publishPointer(s, page, 100, 120);
  assert.equal(await page.locator('#browser-pointer').isVisible(), true);
  await s.manager.resize(s.tab.tabId, { width: 900, height: 600 });
  const resized = await s.manager.capture(s.tab.tabId, {
    epoch: s.viewer.control.state(s.tab.tabId).epoch,
  });
  assert.equal(resized.pointer, null);
  s.viewer.publish(s.tab.tabId, resized);
  await page.waitForFunction(
    (seq) => globalThis.viewer.current()?.captureSequence === seq,
    resized.receipt.captureSequence
  );
  assert.equal(await page.locator('#browser-pointer').isVisible(), false);
  await s.tab.page.goto(s.fixture.url + '/?marker=NAVIGATION');
  const navigated = await s.manager.capture(s.tab.tabId, {
    epoch: s.viewer.control.state(s.tab.tabId).epoch,
  });
  assert.equal(navigated.pointer, null);
  s.viewer.publish(s.tab.tabId, navigated);
  await page.waitForFunction(
    (seq) => globalThis.viewer.current()?.captureSequence === seq,
    navigated.receipt.captureSequence
  );
  assert.equal(await page.locator('#browser-pointer').isVisible(), false);
});

test('acknowledged takeover hides the old cursor throughout the real reset barrier', async (t) => {
  const s = await setup(t);
  const page = await s.open(s.human);
  await s.viewer.pauseCapture(s.tab.tabId);
  await publishPointer(s, page, 200, 180);
  const reset = s.manager.resetInput.bind(s.manager);
  let release;
  const held = new Promise((r) => (release = r));
  t.after(() => release());
  s.manager.resetInput = async (...args) => {
    await held;
    return reset(...args);
  };
  await page.getByRole('button', { name: 'Take control' }).click();
  await page.waitForFunction(() => globalThis.viewer.controlState()?.status === 'barrier');
  assert.equal(await page.locator('#browser-pointer').isVisible(), false);
  release();
  await page.waitForFunction(
    () =>
      globalThis.viewer.controlState()?.status === 'ready' &&
      globalThis.viewer.controlState()?.controllerId === 'human-a'
  );
  assert.equal(await page.locator('#browser-pointer').isVisible(), false);
});

test('actual viewer retains visible canonical pointer and native focused caret evidence', async (t) => {
  const s = await setup(t);
  const page = await s.open(s.observer);
  await s.viewer.pauseCapture(s.tab.tabId);
  const text = await s.tab.page.locator('#text').boundingBox();
  const tab = s.manager.getTab(s.tab.tabId);
  const x = text.x + 16,
    y = text.y + 16;
  const result = await s.viewer.control.submit(s.agent, {
    requestId: randomUUID(),
    tabId: tab.tabId,
    navigationGeneration: tab.navigationGeneration,
    viewportVersion: tab.viewportVersion,
    epoch: s.viewer.control.state(tab.tabId).epoch,
    action: {
      type: 'sequence',
      steps: [
        { type: 'click', x, y },
        { type: 'text', text: 'Fixture pointer and caret' },
      ],
    },
  });
  assert.equal(result.outcome, 'completed');
  assert.equal(await s.tab.page.locator('#text').inputValue(), 'Fixture pointer and caret');
  assert.equal(
    await s.tab.page
      .locator('#text')
      .evaluate((element) => element === globalThis.document.activeElement),
    true
  );
  const capture = await s.manager.capture(tab.tabId, {
    epoch: s.viewer.control.state(tab.tabId).epoch,
  });
  assert.deepEqual(capture.pointer, {
    tabId: tab.tabId,
    navigationGeneration: tab.navigationGeneration,
    viewportVersion: tab.viewportVersion,
    x,
    y,
  });
  s.viewer.publish(tab.tabId, capture);
  await page.waitForFunction(
    (seq) => globalThis.viewer.current()?.captureSequence === seq,
    capture.receipt.captureSequence
  );
  assert.equal(await page.locator('#browser-pointer').isVisible(), true);
  const artifactDir = await mkdtemp(join(tmpdir(), 'viewer-pointer-caret-'));
  await page.screenshot({ path: join(artifactDir, 'actual-viewer.png'), fullPage: true });
  t.diagnostic('Fixture-only pointer/caret viewer artifact: ' + artifactDir);
  t.diagnostic(
    'Canonical fixture browser identity: ' +
      JSON.stringify(
        await s.tab.page.evaluate(() => ({
          userAgent: globalThis.navigator.userAgent,
          brands: globalThis.navigator.userAgentData?.brands ?? null,
          platform: globalThis.navigator.userAgentData?.platform ?? globalThis.navigator.platform,
        }))
      )
  );
});
