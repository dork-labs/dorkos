import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserManager } from '../manager.mjs';
import { loadPlaywright } from '../runtime.mjs';
import { createServer } from 'node:http';

const runtime = await loadPlaywright({
  repoRoot: fileURLToPath(new URL('../../../', import.meta.url)),
});
async function subject(t) {
  const root = await mkdtemp(join(tmpdir(), 'manager-pointer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new BrowserManager({
    profilesDir: root,
    runtime,
    fixtureOrigin: 'http://127.0.0.1:4241',
  });
  const tab = {
    tabId: 'pointer-tab',
    browserId: 'pointer-browser',
    navigationGeneration: 1,
    viewportVersion: 1,
    viewport: { width: 1280, height: 720 },
    buttons: new Set(),
    keys: new Set(),
    pendingCaptures: 0,
    captureTail: Promise.resolve(),
    captureSequence: 0,
    closed: false,
    page: {
      mouse: { move: async () => {}, click: async () => {}, up: async () => {} },
      screenshot: async () => Buffer.from('fixture-pixels'),
      setViewportSize: async () => {},
    },
  };
  manager.requireTab = () => tab;
  return { manager, tab };
}

test('canonical pointer snapshot follows successful mouse dispatch and reset cannot resurrect old input', async (t) => {
  // Display metadata cannot speculate before the actual dispatch resolves.
  const { manager, tab } = await subject(t);
  assert.equal(manager.pointerSnapshot(tab.tabId), null);
  let finish;
  tab.page.mouse.move = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const moving = manager.dispatchInput(tab.tabId, { type: 'mouseMove', x: 30, y: 40 });
  assert.equal(manager.pointerSnapshot(tab.tabId), null);
  finish();
  await moving;
  const expected = { tabId: tab.tabId, navigationGeneration: 1, viewportVersion: 1, x: 30, y: 40 };
  assert.deepEqual(manager.pointerSnapshot(tab.tabId), expected);
  assert.throws(() => {
    manager.pointerSnapshot(tab.tabId).x = 0;
  }, TypeError);
  const late = manager.dispatchInput(tab.tabId, { type: 'mouseMove', x: 50, y: 60 });
  await manager.resetInput(tab.tabId);
  finish();
  await late;
  assert.equal(manager.pointerSnapshot(tab.tabId), null);
  await manager.dispatchInput(tab.tabId, { type: 'click', x: 70, y: 80 });
  assert.deepEqual((await manager.capture(tab.tabId)).pointer, { ...expected, x: 70, y: 80 });
  tab.buttons.add('left');
  tab.page.mouse.up = async () => {
    throw Error('fixture release failure');
  };
  await assert.rejects(manager.resetInput(tab.tabId), /fixture release failure/);
  assert.equal(
    manager.pointerSnapshot(tab.tabId),
    null,
    'failed reset cannot preserve displayed coordinates'
  );
  const navigating = manager.dispatchInput(tab.tabId, { type: 'mouseMove', x: 90, y: 100 });
  tab.navigationGeneration++;
  finish();
  await navigating;
  assert.equal(
    manager.pointerSnapshot(tab.tabId),
    null,
    'late old navigation cannot publish pointer'
  );
});

test('capture refuses pointer changed while screenshots are in flight and resize clears old coordinates', async (t) => {
  // A later canonical point must never be paired with earlier captured pixels.
  const { manager, tab } = await subject(t);
  await manager.dispatchInput(tab.tabId, { type: 'mouseMove', x: 10, y: 20 });
  let finish;
  const entered = new Promise((resolve) => {
    tab.page.screenshot = () => {
      resolve();
      return new Promise((r) => {
        finish = r;
      });
    };
  });
  const capture = manager.capture(tab.tabId);
  await entered;
  await manager.dispatchInput(tab.tabId, { type: 'mouseMove', x: 90, y: 100 });
  finish(Buffer.from('earlier-fixture-pixels'));
  assert.equal((await capture).pointer, null);
  await manager.resize(tab.tabId, { width: 1000, height: 600 });
  assert.equal(manager.pointerSnapshot(tab.tabId), null);
});

test(
  'real canonical mouse dispatch updates pointer identity for both callers and clears lifecycle boundaries',
  { timeout: 15000 },
  async (t) => {
    // Human and agent control use the same manager dispatch seam; this proves actual browser movement, not authority.
    const cleanups = [];
    t.after(async () => {
      const errors = [];
      for (const close of cleanups.reverse()) {
        try {
          await close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Pointer test cleanup failed');
    });
    const root = await mkdtemp(join(tmpdir(), 'manager-pointer-real-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const server = createServer((_, response) =>
      response.end(
        '<!doctype html><body><script>globalThis.pointerInputs=[];document.addEventListener("mousemove",e=>pointerInputs.push({x:e.clientX,y:e.clientY}));</script></body>'
      )
    );
    cleanups.push(() => new Promise((resolve) => server.close(resolve)));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const manager = new BrowserManager({ profilesDir: root, runtime, fixtureOrigin: origin });
    cleanups.push(() => manager.shutdown());
    const browser = await manager.openClean(),
      tab = manager.getTab(browser.tabIds[0]);
    await tab.page.goto(origin);
    for (const [caller, x, y] of [
      ['agent', 30, 40],
      ['human', 60, 80],
    ]) {
      await manager.dispatchInput(tab.tabId, { type: 'mouseMove', x, y });
      assert.deepEqual(
        await tab.page.evaluate(() => globalThis.pointerInputs.at(-1)),
        { x, y },
        caller
      );
      const expected = {
        tabId: tab.tabId,
        navigationGeneration: manager.getTab(tab.tabId).navigationGeneration,
        viewportVersion: 1,
        x,
        y,
      };
      assert.deepEqual(manager.pointerSnapshot(tab.tabId), expected);
      assert.deepEqual((await manager.capture(tab.tabId)).pointer, expected);
      await manager.resetInput(tab.tabId);
      assert.equal(manager.pointerSnapshot(tab.tabId), null);
    }
    await manager.dispatchInput(tab.tabId, { type: 'click', x: 100, y: 120 });
    assert.equal(manager.pointerSnapshot(tab.tabId).x, 100);
    await tab.page.goto(origin + '/second');
    assert.equal(manager.pointerSnapshot(tab.tabId), null);
    await manager.dispatchInput(tab.tabId, { type: 'mouseMove', x: 80, y: 90 });
    await manager.resize(tab.tabId, { width: 1000, height: 600 });
    assert.equal(manager.pointerSnapshot(tab.tabId), null);
    await manager.dispatchInput(tab.tabId, { type: 'mouseMove', x: 20, y: 30 });
    await manager.closeBrowser(browser.browserId);
    assert.equal(manager.tabs.get(tab.tabId).pointer, null);
    assert.throws(() => manager.pointerSnapshot(tab.tabId), { code: 'TAB_UNAVAILABLE' });
  }
);
