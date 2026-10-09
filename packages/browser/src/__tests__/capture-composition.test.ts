import { retirementFixture as captureRetirement } from './parent-fixture.js';
import { captureTab as retirementCapture } from '../tabs/capture.js';
import { it, expect, vi, onTestFinished } from 'vitest';
import { composeInput } from '../lifecycle/input-owner.js';
import { submitInput, resetInput } from '../lifecycle/parent-actions.js';
import { captureTab, joinTabCaptureOriginals } from '../tabs/capture.js';
import {
  createOwnedCaptureIssuer,
  isOwnedCaptureCancellation,
} from '../tabs/owned-capture-work.js';
import { BrowserLifecycleError } from '../lifecycle/errors.js';
import { closeRecord } from '../lifecycle/close.js';
import { configuration, tabFixture, deferred, tick, fakeJPEG, fakePage } from './parent-fixture.js';
vi.mock('../profiles/owned-directory.js', () => ({ assertDirectory: vi.fn() }));
vi.mock('../runtime/host-identity.js', () => ({
  hostIdentity: () => ({ pid: 41, birth: 'MOCK_ROOT' }),
}));
vi.mock('../lifecycle/acquisition.js', () => ({ acquireBrowser: vi.fn() }));

function viewportPopup() {
  const popup = fakePage();
  let size: { width: number; height: number } | null = null;
  Object.assign(popup.raw, {
    viewportSize: () => size,
    setViewportSize: vi.fn(async (next: { width: number; height: number }) => {
      size = next;
    }),
  });
  return popup;
}

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

it('delayed same-origin popup first commit preserves its exact opener and original capture target', async () => {
  const { trackPage } = await import('../tabs/registry.js');
  const h = tabFixture();
  const popup = viewportPopup();
  let url = 'about:blank';
  const frame = { url: () => url };
  h.record.context = h.page.context();
  Object.assign(h.raw, { url: () => h.page.mainFrame().url() });
  Object.assign(popup.raw, {
    context: () => h.record.context,
    opener: async () => h.page,
    url: () => url,
    mainFrame: () => frame,
  });
  const original = { ...h.tab.binding };
  const second = trackPage(
    h.record,
    popup.page,
    configuration().network.origin,
    () => 0,
    h.record.context
  );
  await composeInput(configuration(), h.record, second).readiness;
  await tick();
  expect(second.binding.tabId).not.toBe(original.tabId);
  const blank = { ...second.binding };
  await expect(
    captureTab(configuration(), h.record, {
      kind: 'capture',
      requestId: h.command().requestId,
      binding: blank,
    })
  ).rejects.toMatchObject({ code: 'STALE_BINDING' });
  expect(popup.raw.screenshot).not.toHaveBeenCalled();
  url = configuration().network.origin + '/popup';
  popup.event('framenavigated', frame);
  await tick();
  expect(h.record.lifetime.ordinary.phase).toBe('ordinary');
  expect(second.stopped).toBe(false);
  expect(second.binding.navigationGeneration).toBe(1);
  expect(h.tab.binding).toEqual(original);
  expect((await capture(h)).receipt.binding).toEqual(original);
  expect(popup.raw.screenshot).not.toHaveBeenCalled();
  expect(
    (
      await submitInput(h.record, {
        ...h.command(blank),
        steps: [{ kind: 'mouseMove', x: 1, y: 2 }],
      })
    ).outcome
  ).toBe('rejected');
  expect(
    (
      await submitInput(h.record, {
        ...h.command(second.binding),
        steps: [{ kind: 'mouseMove', x: 1, y: 2 }],
      })
    ).outcome
  ).toBe('completed');
  url = configuration().network.origin + '/second';
  popup.event('framenavigated', frame);
  await tick();
  expect(h.record.lifetime.ordinary.phase).not.toBe('ordinary');
  await closeRecord(configuration(), h.record);
});

it.each([
  'missing-opener',
  'foreign-context',
  'enumerated-page',
  'foreign-origin',
  'competing-commit',
] as const)('refuses ambiguous first popup navigation: %s', async (refusal) => {
  const { trackPage } = await import('../tabs/registry.js');
  const h = tabFixture(),
    popup = viewportPopup();
  let url = 'about:blank';
  const frame = { url: () => url };
  h.record.context = h.page.context();
  Object.assign(h.raw, { url: () => h.page.mainFrame().url() });
  Object.assign(popup.raw, {
    context: () => (refusal === 'foreign-context' ? popup.context : h.record.context),
    opener: async () => (refusal === 'missing-opener' ? null : h.page),
    url: () => url,
    mainFrame: () => frame,
  });
  const second = trackPage(
    h.record,
    popup.page,
    configuration().network.origin,
    () => 0,
    refusal === 'enumerated-page' ? undefined : h.record.context
  );
  if (h.record.lifetime.ordinary.phase === 'ordinary') {
    const ready = composeInput(configuration(), h.record, second).readiness;
    if (refusal === 'missing-opener')
      await expect(ready).rejects.toMatchObject({ code: 'BROWSER_STOPPED' });
    else await ready;
  }
  url =
    refusal === 'foreign-origin'
      ? 'https://foreign.invalid/popup'
      : configuration().network.origin + '/popup';
  popup.event('framenavigated', frame);
  if (refusal === 'competing-commit') popup.event('framenavigated', frame);
  await tick();
  expect(h.record.lifetime.ordinary.phase).not.toBe('ordinary');
  expect(popup.raw.screenshot).not.toHaveBeenCalled();
  await closeRecord(configuration(), h.record);
});

it('first popup commit waits for its original held opener and native input readiness', async () => {
  const { trackPage } = await import('../tabs/registry.js');
  const h = tabFixture(),
    popup = viewportPopup();
  const opener = deferred<import('playwright-core').Page | null>();
  const session = deferred<import('playwright-core').CDPSession>();
  let url = 'about:blank';
  const frame = { url: () => url };
  h.record.context = h.page.context();
  Object.assign(h.raw, { url: () => h.page.mainFrame().url() });
  h.context.newCDPSession.mockImplementation(() => session.promise);
  Object.assign(popup.raw, {
    context: () => h.record.context,
    opener: () => opener.promise,
    url: () => url,
    mainFrame: () => frame,
  });
  const tab = trackPage(
    h.record,
    popup.page,
    configuration().network.origin,
    () => 0,
    h.record.context
  );
  const ready = composeInput(configuration(), h.record, tab).readiness;
  const before = { ...tab.binding };
  url = configuration().network.origin + '/popup';
  popup.event('framenavigated', frame);
  await tick();
  expect(tab.binding).toEqual(before);
  expect((await submitInput(h.record, h.command(before))).outcome).toBe('rejected');
  expect(popup.effects).toEqual([]);
  opener.resolve(h.page);
  await tick();
  expect(tab.binding).toEqual(before);
  session.resolve(popup.session as unknown as import('playwright-core').CDPSession);
  await ready;
  await tick();
  expect(h.record.lifetime.ordinary.phase).toBe('ordinary');
  expect(tab.binding.navigationGeneration).toBe(1);
  expect((await submitInput(h.record, h.command(tab.binding))).outcome).toBe('completed');
  await closeRecord(configuration(), h.record);
});

it('popup generation handoff fences actions while preserving original input custody', async () => {
  const { trackPage } = await import('../tabs/registry.js');
  const { currentAuthorityCustody } = await import('../lifecycle/live-custody.js');
  const h = tabFixture(),
    popup = viewportPopup();
  let url = 'about:blank';
  const frame = { url: () => url };
  h.record.context = h.page.context();
  Object.assign(h.raw, { url: () => h.page.mainFrame().url() });
  // Controlled acquisition metadata exercises the real custody predicate, not native qualification.
  h.record.proxy = { url: configuration().network.origin, close: async () => {} };
  h.record.directory = h.record.dataRoot = { path: 'CONTROLLED_DIRECTORY', dev: 1, ino: 1 };
  await composeInput(configuration(), h.record, h.tab).readiness;
  Object.assign(popup.raw, {
    context: () => h.record.context,
    opener: async () => h.page,
    url: () => url,
    mainFrame: () => frame,
  });
  const tab = trackPage(
    h.record,
    popup.page,
    configuration().network.origin,
    () => 0,
    h.record.context
  );
  const slot = composeInput(configuration(), h.record, tab);
  await slot.readiness;
  const old = { ...tab.binding };
  const observe = () => currentAuthorityCustody(h.record, () => true);
  expect(observe()).toBe(true);
  const gap = deferred<{
    captureCode: string;
    input: string;
    known: boolean;
    ordinary: boolean;
    nativeEffects: number;
  }>();
  const replaceEpoch = tab.diagnostics.replaceEpoch.bind(tab.diagnostics);
  tab.diagnostics = {
    ...tab.diagnostics,
    replaceEpoch: () => {
      replaceEpoch();
      // This runs after the registry changes generation, before the input-owner adoption continuation.
      queueMicrotask(() => {
        const known = observe();
        const ordinary = h.record.lifetime.ordinary.phase === 'ordinary';
        const captureAttempt = captureTab(configuration(), h.record, {
          kind: 'capture',
          requestId: h.command().requestId,
          binding: { ...tab.binding },
        }).then(
          () => 'PUBLISHED',
          (error: { code: string }) => error.code
        );
        const inputAttempt = submitInput(h.record, h.command(tab.binding));
        void Promise.all([captureAttempt, inputAttempt]).then(([captureCode, input]) => {
          gap.resolve({
            captureCode,
            input: input.outcome,
            known,
            ordinary,
            nativeEffects: popup.effects.length,
          });
        }, gap.reject);
      });
    },
  };
  url = configuration().network.origin + '/popup';
  popup.event('framenavigated', frame);
  expect(await gap.promise).toEqual({
    captureCode: 'STALE_BINDING',
    input: 'rejected',
    known: true,
    ordinary: true,
    nativeEffects: 0,
  });
  await tick();
  expect(observe()).toBe(true);
  expect(tab.binding.navigationGeneration).toBe(old.navigationGeneration + 1);
  expect((await submitInput(h.record, h.command(old))).outcome).toBe('rejected');
  expect((await submitInput(h.record, h.command(tab.binding))).outcome).toBe('completed');
  expect(
    (
      await captureTab(configuration(), h.record, {
        kind: 'capture',
        requestId: h.command().requestId,
        binding: tab.binding,
      })
    ).receipt.binding
  ).toEqual(tab.binding);
  await closeRecord(configuration(), h.record);
});

it('original pending popup acquisition preserves authority before session and queue publication', async () => {
  const { trackPage } = await import('../tabs/registry.js');
  const { currentAuthorityCustody } = await import('../lifecycle/live-custody.js');
  const h = tabFixture(),
    popup = viewportPopup();
  h.record.context = h.page.context();
  Object.assign(h.raw, { url: () => h.page.mainFrame().url() });
  h.record.proxy = { url: configuration().network.origin, close: async () => {} };
  h.record.directory = h.record.dataRoot = { path: 'CONTROLLED_DIRECTORY', dev: 1, ino: 1 };
  await composeInput(configuration(), h.record, h.tab).readiness;
  const session = deferred<import('playwright-core').CDPSession>();
  h.context.newCDPSession.mockImplementation(() => session.promise);
  Object.assign(popup.raw, {
    context: () => h.record.context,
    opener: async () => h.page,
    url: () => 'about:blank',
  });
  const tab = trackPage(
    h.record,
    popup.page,
    configuration().network.origin,
    () => 0,
    h.record.context
  );
  const slot = composeInput(configuration(), h.record, tab);
  const observe = () => currentAuthorityCustody(h.record, () => true);
  const pending = observe();
  for (let index = 0; index < 3; index++) {
    expect(observe()).toBe(true);
    await tick();
  }
  expect((await submitInput(h.record, h.command(tab.binding))).outcome).toBe('rejected');
  await expect(
    captureTab(configuration(), h.record, {
      kind: 'capture',
      requestId: h.command().requestId,
      binding: tab.binding,
    })
  ).rejects.toMatchObject({ code: 'STALE_BINDING' });
  let target: typeof slot.registeredTarget;
  const continuation = deferred<{ known: boolean; ready: boolean; target: boolean }>();
  Object.defineProperty(slot, 'registeredTarget', {
    configurable: true,
    get: () => target,
    set(value: typeof target) {
      target = value;
      queueMicrotask(() =>
        continuation.resolve({
          known: observe(),
          ready: slot.ready,
          target: !!slot.registeredTarget,
        })
      );
    },
  });
  session.resolve(popup.session as unknown as import('playwright-core').CDPSession);
  const beforeQueue = await continuation.promise;
  await slot.readiness;
  expect(pending).toBe(true);
  expect(beforeQueue).toEqual({ known: true, ready: false, target: true });
  expect(observe()).toBe(true);
  expect(popup.effects).toEqual([]);
  await closeRecord(configuration(), h.record);
});

it.each([
  'missing-acquisition',
  'copied-handle',
  'unregistered-popup',
  'failed-acquisition',
  'wrong-context',
  'expired',
] as const)(
  'pending popup custody refuses %s without adopting unknown originals',
  async (refusal) => {
    const { trackPage } = await import('../tabs/registry.js');
    const { currentAuthorityCustody } = await import('../lifecycle/live-custody.js');
    const h = tabFixture(),
      popup = viewportPopup();
    h.record.context = h.page.context();
    Object.assign(h.raw, { url: () => h.page.mainFrame().url() });
    h.record.proxy = { url: configuration().network.origin, close: async () => {} };
    h.record.directory = h.record.dataRoot = { path: 'CONTROLLED_DIRECTORY', dev: 1, ino: 1 };
    await composeInput(configuration(), h.record, h.tab).readiness;
    const native = deferred<import('playwright-core').CDPSession>();
    h.context.newCDPSession.mockImplementation(() => {
      if (refusal === 'missing-acquisition') throw Error('ORIGINAL_ACQUISITION_ABSENT');
      return native.promise;
    });
    Object.assign(popup.raw, {
      context: () => h.record.context,
      opener: async () => h.page,
      url: () => 'about:blank',
    });
    const tab = trackPage(
      h.record,
      popup.page,
      configuration().network.origin,
      () => 0,
      refusal === 'unregistered-popup' ? undefined : h.record.context
    );
    const slot = composeInput(configuration(), h.record, tab);
    const handle = slot.handle!;
    const observe = () => currentAuthorityCustody(h.record, () => true);
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      if (refusal === 'copied-handle') slot.handle = Object.freeze({ ...handle });
      if (refusal === 'wrong-context') popup.raw.context = () => popup.context;
      if (refusal === 'failed-acquisition') {
        native.reject(Error('ORIGINAL_ACQUISITION_FAILED'));
        await tick();
      }
      if (refusal === 'expired')
        clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 1600);
      expect(observe()).toBe(false);
      expect(popup.effects).toEqual([]);
    } finally {
      clock?.mockRestore();
      slot.handle = handle;
      popup.raw.context = () => h.context;
      native.resolve(popup.session as unknown as import('playwright-core').CDPSession);
      await Promise.allSettled([slot.readiness!]);
      await tick();
      if (
        ['missing-acquisition', 'failed-acquisition', 'wrong-context', 'expired'].includes(refusal)
      ) {
        expect(observe()).toBe(false); // Late original return/lowered clock cannot revive the cohort.
        expect(h.record.lifetime.ordinary.phase).not.toBe('ordinary');
      }
      await closeRecord(configuration(), h.record);
    }
  }
);

it.each([
  'accepted',
  'foreign-popup',
  'changed-url',
  'changed-binding',
  'missing-url',
  'inconsistent-frame',
  'foreign-context',
  'removed-parent',
] as const)('owned aboutblank popup pins the committed original opener: %s', async (variant) => {
  const { trackPage } = await import('../tabs/registry.js');
  const h = tabFixture(),
    popup = viewportPopup(),
    c = configuration();
  c.network = { kind: 'owned', origin: 'about:blank', policyRevision: 1 };
  let parentURL = 'http://127.0.0.1:9001/',
    popupURL = 'about:blank';
  const parentFrame = {
    url: () => (variant === 'inconsistent-frame' ? 'http://different.invalid/' : parentURL),
  };
  const popupFrame = { url: () => popupURL };
  h.record.context = h.page.context();
  Object.assign(h.raw, {
    url: () => (variant === 'missing-url' ? 'about:blank' : parentURL),
    mainFrame: () => parentFrame,
  });
  Object.assign(popup.raw, {
    context: () => h.record.context,
    opener: async () => h.page,
    url: () => popupURL,
    mainFrame: () => popupFrame,
  });
  const native = deferred<import('playwright-core').CDPSession>();
  h.context.newCDPSession.mockImplementation(() => native.promise);
  const tab = trackPage(h.record, popup.page, c.network.origin, () => 0, h.record.context);
  const readiness = composeInput(c, h.record, tab).readiness;
  void readiness?.catch(() => {});
  await tick();
  if (variant === 'changed-url') parentURL = 'http://127.0.0.1:9002/';
  if (variant === 'changed-binding')
    h.tab.binding = {
      ...h.tab.binding,
      navigationGeneration: h.tab.binding.navigationGeneration + 1,
    };
  if (variant === 'foreign-context') Object.assign(h.raw, { context: () => popup.context });
  if (variant === 'removed-parent') h.record.tabs.delete(h.tab.binding.tabId);
  popupURL =
    variant === 'foreign-popup' ? 'http://different.invalid/popup' : 'http://127.0.0.1:9001/popup';
  popup.event('framenavigated', popupFrame);
  await tick();
  expect(tab.binding.navigationGeneration).toBe(0);
  native.resolve(popup.session as unknown as import('playwright-core').CDPSession);
  await tick();
  if (variant === 'accepted') {
    await readiness;
    expect(tab.binding.navigationGeneration).toBe(1);
    expect(h.record.lifetime.ordinary.phase).toBe('ordinary');
    popupURL += '/second';
    popup.event('framenavigated', popupFrame);
    await tick();
    expect(h.record.lifetime.ordinary.phase).not.toBe('ordinary');
  } else {
    expect(tab.binding.navigationGeneration).toBe(0);
    expect(h.record.lifetime.ordinary.phase).not.toBe('ordinary');
  }
  await closeRecord(c, h.record);
});

it.each([
  'returned',
  'rejected',
  'late',
  'mutated',
  'changed-page',
  'changed-context',
  'changed-binding',
  'retired-while-held',
] as const)(
  'original null popup viewport must return exactly before first commit: %s',
  async (variant) => {
    const { trackPage } = await import('../tabs/registry.js');
    const h = tabFixture(),
      popup = viewportPopup(),
      c = configuration();
    c.network = { kind: 'owned', origin: 'about:blank', policyRevision: 1 };
    h.record.context = h.page.context();
    Object.assign(h.raw, { url: () => h.page.mainFrame().url() });
    let url = 'about:blank',
      size: { width: number; height: number } | null = null;
    const frame = { url: () => url },
      held = deferred<void>();
    let entered = 0;
    Object.assign(popup.raw, {
      context: () => h.context,
      opener: async () => h.page,
      url: () => url,
      mainFrame: () => frame,
      viewportSize: () => size,
      setViewportSize: async function (this: unknown, next: { width: number; height: number }) {
        expect(this).toBe(popup.page);
        entered++;
        await held.promise;
        size = variant === 'mutated' ? { width: 1, height: 1 } : next;
      },
    });
    const tab = trackPage(h.record, popup.page, c.network.origin, () => 0, h.record.context);
    const ready = composeInput(c, h.record, tab).readiness;
    void ready?.catch(() => {});
    await tick();
    expect(entered).toBe(1);
    expect(h.record.lifetime.pending.size).toBeGreaterThan(0);
    expect(popup.page.viewportSize()).toBeNull();
    url = 'http://127.0.0.1:9001/popup';
    popup.event('framenavigated', frame);
    await tick();
    expect(tab.binding.navigationGeneration).toBe(0);
    expect((await submitInput(h.record, h.command(tab.binding))).outcome).toBe('rejected');
    expect(popup.effects).toEqual([]);
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      if (variant === 'late')
        clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 1600);
      if (variant === 'retired-while-held') {
        h.record.lifetime.requestRetirement('engineFault');
        await tick();
        expect(h.record.lifetime.pending.size).toBeGreaterThan(0);
        expect(size).toBeNull();
      }
      if (variant === 'changed-page') tab.page = fakePage().page;
      if (variant === 'changed-context') Object.assign(popup.raw, { context: () => popup.context });
      if (variant === 'changed-binding')
        tab.binding = { ...tab.binding, epoch: tab.binding.epoch + 1 };
      if (variant === 'rejected') held.reject(Error('ORIGINAL_VIEWPORT_FAILURE'));
      else held.resolve();
      await tick();
      if (variant === 'returned') {
        expect(tab.binding.navigationGeneration).toBe(1);
        expect(popup.page.viewportSize()).toEqual({ width: 1280, height: 720 });
        expect(
          (
            await submitInput(h.record, {
              ...h.command(tab.binding),
              steps: [{ kind: 'mouseMove', x: 50, y: 50 }],
            })
          ).outcome
        ).toBe('completed');
      } else {
        expect(tab.binding.navigationGeneration).toBe(0);
        expect(h.record.lifetime.ordinary.phase).not.toBe('ordinary');
        expect(popup.effects).toEqual([]);
      }
      expect(entered).toBe(1);
    } finally {
      clock?.mockRestore();
      await closeRecord(c, h.record);
    }
  }
);

it.each(['return', 'reject'] as const)(
  'keeps original permission revocation separate from a screenshot %s',
  async (settlement) => {
    const h = tabFixture();
    let current = true;
    const held = deferred<Uint8Array>();
    h.raw.screenshot.mockImplementation(() => held.promise);
    const command = {
      kind: 'capture' as const,
      requestId: h.command().requestId,
      binding: { ...h.tab.binding },
    };
    const issuer = createOwnedCaptureIssuer();
    const work = issuer.issue(command, {
      isCurrent: () => current,
      authorize: async () => 'allowed',
    });
    const originals: { operation?: ReturnType<typeof captureTab> } = {};
    const nativeFailure = new Error('Original native screenshot failed');
    // Install release, exact native/operation joins and issuer cleanup before screenshot entry.
    onTestFinished(async () => {
      if (settlement === 'return') held.resolve(fakeJPEG());
      else held.reject(nativeFailure);
      await Promise.allSettled([
        originals.operation ?? Promise.resolve(),
        joinTabCaptureOriginals(h.tab),
      ]);
      issuer.invalidate(work);
    });
    const operation = captureTab(configuration(), h.record, command, work);
    originals.operation = operation;
    const observed = operation.then(
      () => ({ failed: false as const }),
      (error: unknown) => ({ failed: true as const, error })
    );
    await vi.waitFor(() => expect(h.raw.screenshot).toHaveBeenCalledTimes(1));
    current = false;
    let joined = false;
    const joining = joinTabCaptureOriginals(h.tab).then(() => {
      joined = true;
    });
    await tick();
    expect(joined).toBe(false);
    if (settlement === 'return') held.resolve(fakeJPEG());
    else held.reject(nativeFailure);
    const result = await observed;
    expect(result.failed).toBe(true);
    if (result.failed) {
      expect(result.error).toMatchObject({
        code: settlement === 'return' ? 'STALE_BINDING' : 'CAPTURE_FAILED',
      });
      expect(isOwnedCaptureCancellation(result.error)).toBe(settlement === 'return');
    }
    await joining;
    expect(joined).toBe(true);
    expect(h.tab.pending).toBe(0);
    issuer.invalidate(work);
  }
);

it('cannot classify a caller-created stale error as original capture cancellation', () => {
  expect(isOwnedCaptureCancellation(new BrowserLifecycleError('STALE_BINDING'))).toBe(false);
  expect(isOwnedCaptureCancellation({ code: 'STALE_BINDING' })).toBe(false);
  expect(isOwnedCaptureCancellation(undefined)).toBe(false);
});

it('a throwing original permission check remains an unclassified refusal', async () => {
  const h = tabFixture();
  const command = {
    kind: 'capture' as const,
    requestId: h.command().requestId,
    binding: { ...h.tab.binding },
  };
  const issuer = createOwnedCaptureIssuer();
  const work = issuer.issue(command, {
    isCurrent: () => {
      throw undefined;
    },
    authorize: async () => 'allowed',
  });
  const error = await captureTab(configuration(), h.record, command, work).catch(
    (error: unknown) => error
  );
  expect(error).toMatchObject({ code: 'STALE_BINDING' });
  expect(isOwnedCaptureCancellation(error)).toBe(false);
  expect(h.raw.screenshot).not.toHaveBeenCalled();
});

it('retirement joins the original capture wrapper and screenshot without inventing acquisition gaps', async () => {
  const fixture = await captureEngineFixture();
  const entered = deferred<void>();
  const pixels = deferred<Uint8Array>();
  const screenshot = vi.spyOn(fixture.h.raw, 'screenshot').mockImplementation(() => {
    entered.resolve();
    return pixels.promise;
  });
  const operation = fixture.engine.capture(fixture.command);
  const refusal = operation.catch((value: unknown) => value);
  const retained: { closing?: ReturnType<typeof fixture.engine.shutdown> } = {};
  onTestFinished(async () => {
    pixels.resolve(fakeJPEG());
    await Promise.allSettled([operation, retained.closing ?? fixture.engine.shutdown()]);
    screenshot.mockRestore();
  });
  await entered.promise;
  expect(fixture.record.lifetime.pending.size).toBe(2);
  const closing = fixture.engine.shutdown();
  retained.closing = closing;
  let settled = false;
  void closing.then(() => {
    settled = true;
  });
  await tick();
  expect(settled).toBe(false);
  expect(fixture.record.lifetime.ordinary.retirement.pendingCoverage.size).toBe(2);
  pixels.resolve(fakeJPEG());
  expect(await refusal).toMatchObject({ code: 'STALE_BINDING' });
  expect((await closing).every((result) => result.cleanup === 'observed')).toBe(true);
  expect(fixture.record.lifetime.ordinary.retirement.pendingCoverage.size).toBe(0);
  expect(fixture.record.lifetime.ordinary.retirement.coverageUnavailable).toBe(false);
});
