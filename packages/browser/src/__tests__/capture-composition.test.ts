import { retirementFixture as captureRetirement } from './parent-fixture.js';
import { captureTab as retirementCapture } from '../tabs/capture.js';
import { it, expect, vi } from 'vitest';
import { composeInput } from '../lifecycle/input-owner.js';
import { submitInput, resetInput } from '../lifecycle/parent-actions.js';
import { captureTab } from '../tabs/capture.js';
import { closeRecord } from '../lifecycle/close.js';
import { configuration, tabFixture, deferred, tick, fakeJPEG, fakePage } from './parent-fixture.js';
vi.mock('../profiles/owned-directory.js', () => ({ assertDirectory: vi.fn() }));
vi.mock('../runtime/host-identity.js', () => ({
  hostIdentity: () => ({ pid: 41, birth: 'MOCK_ROOT' }),
}));
vi.mock('../lifecycle/acquisition.js', () => ({ acquireBrowser: vi.fn() }));
const capture = (h: ReturnType<typeof tabFixture>) =>
  captureTab(configuration(), h.record, {
    kind: 'capture',
    requestId: h.command().requestId,
    binding: { ...h.tab.binding },
  });
it('publishes only native-completed movement, preserves successful click and invalidates reset', async () => {
  const h = tabFixture();
  await composeInput(configuration(), h.record, h.tab).readiness;
  const move = { ...h.command(), steps: [{ kind: 'mouseMove' as const, x: 4, y: 5 }] };
  expect((await submitInput(h.record, move)).outcome).toBe('completed');
  expect((await capture(h)).receipt.pointer).toMatchObject({ x: 4, y: 5 });
  expect((await submitInput(h.record, h.command())).outcome).toBe('completed');
  expect((await capture(h)).receipt.pointer).toMatchObject({ x: 4, y: 5 });
  await submitInput(h.record, { ...h.command(), steps: move.steps });
  await resetInput(h.record, { ...h.tab.binding });
  expect(h.tab.pointer.read().marker).toBe(null);
  expect((await submitInput(h.record, { ...h.command(), steps: move.steps })).outcome).toBe(
    'completed'
  );
  await closeRecord(configuration(), h.record);
  expect(h.tab.pointer.read().marker).toBe(null);
});
it('movement during held capture suppresses the marker without publishing unrelated pointer truth', async () => {
  const h = tabFixture();
  await composeInput(configuration(), h.record, h.tab).readiness;
  await submitInput(h.record, { ...h.command(), steps: [{ kind: 'mouseMove', x: 1, y: 2 }] });
  const held = deferred<Uint8Array>();
  h.raw.screenshot.mockImplementation(() => held.promise);
  const pending = capture(h);
  await tick();
  await submitInput(h.record, { ...h.command(), steps: [{ kind: 'mouseMove', x: 3, y: 4 }] });
  held.resolve(fakeJPEG());
  expect((await pending).receipt.pointer).toBe(null);
  expect(h.tab.pointer.read().marker).toMatchObject({ x: 3, y: 4 });
  await closeRecord(configuration(), h.record);
});
it('failed movement retains its native failure and never leaves a completed marker', async () => {
  const h = tabFixture();
  await composeInput(configuration(), h.record, h.tab).readiness;
  h.raw.mouse.move.mockRejectedValueOnce(Error('OWNED_MOVE_FAILURE'));
  expect(
    (await submitInput(h.record, { ...h.command(), steps: [{ kind: 'mouseMove', x: 1, y: 2 }] }))
      .outcome
  ).not.toBe('completed');
  expect(h.tab.pointer.read().marker).toBe(null);
  await closeRecord(configuration(), h.record);
});
it('retirement in viewport metadata refuses capture before sequence publication', async () => {
  const h = tabFixture();
  h.raw.viewportSize = () =>
    Object.defineProperty({ height: 80 }, 'width', {
      get: () => {
        h.record.lifetime.gate.stop();
        return 100;
      },
    }) as { width: number; height: number };
  await expect(capture(h)).rejects.toMatchObject({ code: 'STALE_BINDING' });
  expect(h.tab.captureSequence).toBe(0);
});

it('successful expanded click preserves movement but failed down invalidates it', async () => {
  const h = tabFixture();
  await composeInput(configuration(), h.record, h.tab).readiness;
  const click = {
    ...h.command(),
    steps: [{ kind: 'click' as const, x: 7, y: 8, button: 'left' as const }],
  };
  expect((await submitInput(h.record, click)).outcome).toBe('completed');
  expect((await capture(h)).receipt.pointer).toMatchObject({ x: 7, y: 8 });
  h.raw.mouse.down.mockRejectedValueOnce(Error('DOWN_FAILED'));
  expect((await submitInput(h.record, click)).outcome).not.toBe('completed');
  expect(h.tab.pointer.read().marker).toBe(null);
  await closeRecord(configuration(), h.record);
});
it('terminal pointer transition at equal MAX revision suppresses an in-flight marker', async () => {
  const { createPointerLedger } = await import('../tabs/pointer.js');
  const h = tabFixture();
  h.tab.pointer = createPointerLedger(() => h.tab.binding, Number.MAX_SAFE_INTEGER - 1);
  h.tab.pointer.success(h.tab.pointer.beginMove(1, 2));
  expect(h.tab.pointer.read().revision).toBe(Number.MAX_SAFE_INTEGER);
  const held = deferred<Uint8Array>();
  h.raw.screenshot.mockImplementation(() => held.promise);
  const pending = capture(h);
  await tick();
  h.tab.pointer.invalidate();
  held.resolve(fakeJPEG());
  expect((await pending).receipt.pointer).toBe(null);
  expect(h.tab.pointer.read()).toMatchObject({ revision: Number.MAX_SAFE_INTEGER, terminal: true });
});

it('successful composed reset refreshes diagnostics and releases old request correlations', async () => {
  const h = tabFixture();
  await composeInput(configuration(), h.record, h.tab).readiness;
  const old = { method: () => 'GET', resourceType: () => 'fetch' };
  h.event('request', old);
  expect(h.record.diagnosticsBudget.snapshot()).toMatchObject({
    owners: 1,
    entries: 1,
    correlations: 1,
  });
  const before = { ...h.tab.binding };
  const result = await resetInput(h.record, before);
  expect(result.status).toBe('ready');
  expect(result.binding).toEqual({
    ...before,
    epoch: before.epoch + 1,
    inputGeneration: before.inputGeneration + 1,
  });
  expect(h.tab.diagnostics.read()).toMatchObject({
    binding: h.tab.binding,
    entries: [],
    terminal: 'none',
    subsequentEventsUncounted: false,
  });
  expect(h.record.diagnosticsBudget.snapshot()).toMatchObject({
    owners: 1,
    entries: 0,
    correlations: 0,
    bytes: 0,
    correlationBytes: 0,
  });
  h.event('console', { type: () => 'info' });
  h.event('requestfinished', old);
  expect(h.tab.diagnostics.read()).toMatchObject({
    binding: h.tab.binding,
    terminal: 'none',
    subsequentEventsUncounted: false,
    counts: { dropped: 1, unmatchedCallbacks: 1, correlationDropped: 0 },
  });
  expect(h.tab.diagnostics.read()?.entries).toEqual([
    expect.objectContaining({ category: 'console', severity: 'info' }),
  ]);
  expect(h.record.diagnosticsBudget.snapshot()).toMatchObject({
    owners: 1,
    entries: 1,
    correlations: 0,
    correlationBytes: 0,
  });
  expect((await submitInput(h.record, h.command())).outcome).toBe('completed');
  await closeRecord(configuration(), h.record);
});
it('failed composed reset closes diagnostic ownership without ready revival', async () => {
  const h = tabFixture();
  await composeInput(configuration(), h.record, h.tab).readiness;
  expect(
    (await submitInput(h.record, { ...h.command(), steps: [{ kind: 'keyDown', key: 'Shift' }] }))
      .outcome
  ).toBe('completed');
  h.event('request', { method: () => 'GET', resourceType: () => 'fetch' });
  h.raw.keyboard.up.mockRejectedValueOnce(Error('RELEASE_FAILURE'));
  expect((await resetInput(h.record, { ...h.tab.binding })).status).toBe('stopped');
  expect(h.record.lifetime.ordinary.phase).not.toBe('ordinary');
  expect((await submitInput(h.record, h.command())).outcome).toBe('rejected');
  await h.record.lifetime.ordinary.retirement.promise;
  expect(h.record.lifetime.gate.stopped).toBe(true);
  expect(h.tab.diagnostics.read()).toBe(null);
  expect(h.record.diagnosticsBudget.snapshot()).toMatchObject({
    owners: 0,
    entries: 0,
    correlations: 0,
  });
  expect((await submitInput(h.record, h.command())).outcome).not.toBe('completed');
  await closeRecord(configuration(), h.record);
});
it('diagnostic refresh close reentry stops composed reset before ready publication', async () => {
  let armed = false;
  const h = tabFixture(undefined, () => {
    if (armed) h.record.lifetime.gate.stop();
    return 0;
  });
  await composeInput(configuration(), h.record, h.tab).readiness;
  h.event('request', { method: () => 'GET', resourceType: () => 'fetch' });
  armed = true;
  expect((await resetInput(h.record, { ...h.tab.binding })).status).toBe('stopped');
  expect(h.tab.diagnostics.read()).toBe(null);
  expect(h.record.diagnosticsBudget.snapshot()).toMatchObject({
    owners: 0,
    entries: 0,
    correlations: 0,
  });
  expect((await submitInput(h.record, h.command())).outcome).not.toBe('completed');
  await closeRecord(configuration(), h.record);
});
it('nested event during composed diagnostic refresh honestly terminalizes without changing reset authority', async () => {
  let armed = false;
  const h = tabFixture(undefined, () => {
    if (armed) h.event('console', { type: () => 'info' });
    return 0;
  });
  await composeInput(configuration(), h.record, h.tab).readiness;
  h.event('request', { method: () => 'GET', resourceType: () => 'fetch' });
  armed = true;
  expect((await resetInput(h.record, { ...h.tab.binding })).status).toBe('ready');
  expect(h.tab.diagnostics.read()).toMatchObject({
    terminal: 'observerUnavailable',
    subsequentEventsUncounted: true,
  });
  expect(h.record.diagnosticsBudget.snapshot()).toMatchObject({
    owners: 1,
    entries: 1,
    correlations: 0,
    correlationBytes: 0,
  });
  armed = false;
  expect((await submitInput(h.record, h.command())).outcome).toBe('completed');
  await closeRecord(configuration(), h.record);
});

it('canonical Page replacement in screenshot getter refuses its captured method before entry', async () => {
  const h = tabFixture();
  await composeInput(configuration(), h.record, h.tab).readiness;
  const replacement = fakePage();
  const screenshot = vi.fn(async () => fakeJPEG());
  Object.defineProperty(h.raw, 'screenshot', {
    get: () => {
      h.tab.page = replacement.page;
      return screenshot;
    },
  });
  await expect(capture(h)).rejects.toMatchObject({ code: 'STALE_BINDING' });
  expect(screenshot).toHaveBeenCalledTimes(0);
  expect(replacement.raw.screenshot).toHaveBeenCalledTimes(0);
  expect(h.tab.captureSequence).toBe(0);
  await closeRecord(configuration(), h.record);
});

it('canonical Page replacement in viewport getter refuses its captured method before entry', async () => {
  const h = tabFixture();
  await composeInput(configuration(), h.record, h.tab).readiness;
  const replacement = fakePage();
  const viewport = vi.fn(() => ({ width: 100, height: 80 }));
  Object.defineProperty(h.raw, 'viewportSize', {
    get: () => {
      h.tab.page = replacement.page;
      return viewport;
    },
  });
  await expect(capture(h)).rejects.toMatchObject({ code: 'STALE_BINDING' });
  expect(h.raw.screenshot).toHaveBeenCalledTimes(1);
  expect(viewport).toHaveBeenCalledTimes(0);
  expect(h.tab.captureSequence).toBe(0);
  await closeRecord(configuration(), h.record);
});

it('canonical Page replacement during policy refuses screenshot on both Pages', async () => {
  const h = tabFixture(),
    c = configuration(),
    replacement = fakePage();
  await composeInput(c, h.record, h.tab).readiness;
  c.policy.authorizeAction = vi.fn(async () => {
    h.tab.page = replacement.page;
    return 'allowed' as const;
  });
  await expect(
    captureTab(c, h.record, {
      kind: 'capture',
      requestId: h.command().requestId,
      binding: { ...h.tab.binding },
    })
  ).rejects.toMatchObject({ code: 'STALE_BINDING' });
  expect(h.raw.screenshot).toHaveBeenCalledTimes(0);
  expect(replacement.raw.screenshot).toHaveBeenCalledTimes(0);
  expect(h.tab.captureSequence).toBe(0);
  await closeRecord(c, h.record);
});

it('ordinary capture invokes screenshot and viewport with the exact original Page receiver', async () => {
  const h = tabFixture();
  await composeInput(configuration(), h.record, h.tab).readiness;
  const screenshot = vi.fn(async function (this: unknown) {
    expect(this).toBe(h.page);
    return fakeJPEG();
  });
  const viewport = vi.fn(function (this: unknown) {
    expect(this).toBe(h.page);
    return { width: 100, height: 80 };
  });
  h.raw.screenshot = screenshot;
  h.raw.viewportSize = viewport;
  expect((await capture(h)).receipt.captureSequence).toBe(1);
  expect(screenshot).toHaveBeenCalledTimes(1);
  expect(viewport).toHaveBeenCalledTimes(1);
  await closeRecord(configuration(), h.record);
});

it('canonical Page replacement while screenshot awaits refuses publication', async () => {
  const h = tabFixture(),
    held = deferred<Uint8Array>(),
    replacement = fakePage();
  await composeInput(configuration(), h.record, h.tab).readiness;
  h.raw.screenshot.mockImplementation(() => held.promise);
  const pending = capture(h);
  await tick();
  expect(h.raw.screenshot).toHaveBeenCalledTimes(1);
  h.tab.page = replacement.page;
  held.resolve(fakeJPEG());
  await expect(pending).rejects.toMatchObject({ code: 'STALE_BINDING' });
  expect(h.tab.captureSequence).toBe(0);
  await closeRecord(configuration(), h.record);
});

it('queued capture retains the request-owned Page before a held predecessor tail', async () => {
  const h = tabFixture(),
    previous = deferred<void>(),
    replacement = fakePage();
  h.tab.tail = previous.promise;
  const pending = capture(h);
  const refused = expect(pending).rejects.toMatchObject({ code: 'STALE_BINDING' });
  h.tab.page = replacement.page;
  previous.resolve();
  await refused;
  expect(h.raw.screenshot).toHaveBeenCalledTimes(0);
  expect(replacement.raw.screenshot).toHaveBeenCalledTimes(0);
  expect(h.tab.captureSequence).toBe(0);
  expect(h.tab.pending).toBe(0);
});

it('queued second actual capture refuses same-binding Page replacement without replacement IO', async () => {
  const h = tabFixture(),
    held = deferred<Uint8Array>(),
    replacement = fakePage();
  h.raw.screenshot.mockImplementation(() => held.promise);
  const first = capture(h);
  const firstRefused = expect(first).rejects.toMatchObject({ code: 'STALE_BINDING' });
  await tick();
  expect(h.raw.screenshot).toHaveBeenCalledTimes(1);
  const second = capture(h);
  const secondRefused = expect(second).rejects.toMatchObject({ code: 'STALE_BINDING' });
  expect(h.tab.pending).toBe(2);
  h.tab.page = replacement.page;
  held.resolve(fakeJPEG());
  await Promise.all([firstRefused, secondRefused]);
  expect(replacement.raw.screenshot).toHaveBeenCalledTimes(0);
  expect(h.tab.captureSequence).toBe(0);
  expect(h.tab.pending).toBe(0);
});

it('outer capture continuation refuses viewport-scheduled Page replacement before sequence commit', async () => {
  const h = tabFixture(),
    replacement = fakePage();
  h.raw.viewportSize = () => {
    queueMicrotask(() => {
      h.tab.page = replacement.page;
    });
    return { width: 100, height: 80 };
  };
  await expect(capture(h)).rejects.toMatchObject({ code: 'STALE_BINDING' });
  expect(h.raw.screenshot).toHaveBeenCalledTimes(1);
  expect(replacement.raw.screenshot).toHaveBeenCalledTimes(0);
  expect(h.tab.captureSequence).toBe(0);
  expect(h.tab.pending).toBe(0);
});

it('two actual queued captures on the stable original Page preserve receiver and ordered sequences', async () => {
  const h = tabFixture(),
    held = deferred<Uint8Array>();
  h.raw.screenshot.mockImplementationOnce(() => held.promise);
  const first = capture(h);
  await tick();
  const second = capture(h);
  expect(h.tab.pending).toBe(2);
  held.resolve(fakeJPEG());
  const results = await Promise.all([first, second]);
  expect(results.map((result) => result.receipt.captureSequence)).toEqual([1, 2]);
  expect(h.raw.screenshot).toHaveBeenCalledTimes(2);
  expect(h.tab.pending).toBe(0);
});

it('queued capture with changed binding refuses before screenshot and releases its pending slot', async () => {
  const h = tabFixture(),
    previous = deferred<void>();
  h.tab.tail = previous.promise;
  const pending = capture(h);
  const refused = expect(pending).rejects.toMatchObject({ code: 'STALE_BINDING' });
  h.tab.binding = { ...h.tab.binding, epoch: h.tab.binding.epoch + 1 };
  previous.resolve();
  await refused;
  expect(h.raw.screenshot).toHaveBeenCalledTimes(0);
  expect(h.tab.captureSequence).toBe(0);
  expect(h.tab.pending).toBe(0);
});

it('failed acquisition releases queue ownership so the next stable capture commits once', async () => {
  const h = tabFixture();
  h.raw.screenshot.mockRejectedValueOnce(Error('CAPTURE_FIXTURE_FAILURE'));
  const first = capture(h);
  const refused = expect(first).rejects.toMatchObject({ code: 'CAPTURE_FAILED' });
  const second = capture(h);
  await refused;
  expect((await second).receipt.captureSequence).toBe(1);
  expect(h.raw.screenshot).toHaveBeenCalledTimes(2);
  expect(h.tab.pending).toBe(0);
});

// Actual engine/capture composition with an inert acquisition producer; no runtime/profile effects.
async function captureEngineFixture() {
  const { acquireBrowser } = await import('../lifecycle/acquisition.js');
  const { trackPage } = await import('../tabs/registry.js');
  const { createBrowserEngine } = await import('../engine.js');
  const h = fakePage(),
    config = configuration();
  let record!: import('../lifecycle/records.js').BrowserRecord;
  vi.mocked(acquireBrowser).mockImplementation(async (c, owned) => {
    record = owned;
    const tab = trackPage(owned, h.page, c.network.origin, () => 0);
    owned.status = 'running';
    await composeInput(c, owned, tab).readiness;
  });
  const engine = createBrowserEngine(config);
  const opened = await engine.open({
    kind: 'open',
    mode: 'ephemeral',
    requestId: 'request_subject_A_00000000000000',
  });
  const command = { kind: 'capture', requestId: opened.requestId, binding: opened.tab };
  return { h, engine, record, command };
}

it('engine outer-await Page replacement refuses publication after real capture has settled', async () => {
  const fixture = await captureEngineFixture();
  const module = await import('../tabs/capture.js'),
    original = module.captureTab;
  const replacement = fakePage();
  const spy = vi.spyOn(module, 'captureTab').mockImplementation(async (...args) => {
    const result = await original(...args);
    queueMicrotask(() => {
      fixture.record.tabs.get(fixture.command.binding.tabId)!.page = replacement.page;
    });
    return result;
  });
  try {
    await expect(fixture.engine.capture(fixture.command)).rejects.toMatchObject({
      code: 'STALE_BINDING',
    });
    expect(fixture.h.raw.screenshot).toHaveBeenCalledTimes(1);
    expect(replacement.raw.screenshot).toHaveBeenCalledTimes(0);
  } finally {
    spy.mockRestore();
    await fixture.engine.shutdown();
  }
});

it('engine stable outer-await retains exact Page and publishes genuine capture once', async () => {
  const fixture = await captureEngineFixture();
  const result = await fixture.engine.capture(fixture.command);
  expect(result.receipt.captureSequence).toBe(1);
  expect(fixture.h.raw.screenshot).toHaveBeenCalledTimes(1);
  expect(result.bytes).toEqual(fakeJPEG());
  await fixture.engine.shutdown();
});

it('a known ordinary fence refuses capture before screenshot observation', async () => {
  const h = tabFixture(),
    c = configuration();
  captureRetirement(h.record, performance.now() + 2000);
  await expect(
    retirementCapture(c, h.record, {
      kind: 'capture',
      requestId: h.command().requestId,
      binding: h.tab.binding,
    })
  ).rejects.toMatchObject({ code: 'STALE_BINDING' });
  expect(h.raw.screenshot).toHaveBeenCalledTimes(0);
});
