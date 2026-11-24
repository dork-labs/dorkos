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
