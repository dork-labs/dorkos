import {
  tabFixture as ownedTransportFixture,
  configuration as transportConfiguration,
  createOwnedFixtureEngineInput,
  fakePage,
  requestId,
} from '../../__tests__/parent-fixture.js';
import { composeInput as composeTransportOwner } from '../../lifecycle/input-owner.js';
import type { CleanupPermit, CleanupAttempt } from '../../lifecycle/ownership.js';
import type { OwnedPageTransport as OwnedCleanupTransport } from '../page-transport.js';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { createOwnedInputIssuer } from '../owned-work.js';
import { submitInput } from '../../lifecycle/parent-actions.js';
import { fenceOrdinary } from '../../lifecycle/ownership.js';
import type { PrivateBrowserInputDispatcher } from '../../engine.js';
import type { CDPSession, Page } from 'playwright-core';
import { createPageTransport } from '../page-transport.js';
import { createPointerLedger, type PointerLedger } from '../../tabs/pointer.js';
import { parseBrowserId, parseTabId } from '../../ids.js';
import { createBrowserStopGate } from '../../lifecycle/stop.js';
import { unavailableDiagnostics } from '../../tabs/diagnostics.js';
import type { TabRecord } from '../../lifecycle/records.js';
import { parseBrowserCommand, type BrowserBinding } from '../../contracts.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function fixture(
  observeBinding?: () => void,
  pointer?: PointerLedger,
  configure?: (context: { newCDPSession: ReturnType<typeof vi.fn> }) => void
) {
  const binding: BrowserBinding = {
    browserId: parseBrowserId('browser_subject_A_000000000000000'),
    browserGeneration: 0,
    tabId: parseTabId('canonical_tab_A_00000000000000000'),
    navigationGeneration: 0,
    viewportVersion: 0,
    epoch: 0,
    inputGeneration: 0,
  };
  let current = true;
  const effects: unknown[] = [];
  const record = (method: string) =>
    vi.fn(async (...args: unknown[]) => {
      effects.push([method, ...args]);
    });
  const session = { send: record('send'), detach: record('detach') };
  const context = { newCDPSession: vi.fn(async () => session as unknown as CDPSession) };
  configure?.(context);
  const mouse = {
    move: record('move'),
    down: record('mouseDown'),
    up: record('mouseUp'),
    wheel: record('wheel'),
  };
  const keyboard = { down: record('keyDown'), up: record('keyUp'), insertText: record('text') };
  const page = {
    context: () => context,
    mouse,
    keyboard,
    viewportSize: () => ({ width: 100, height: 80 }),
    isClosed: () => false,
    mainFrame: () => ({}),
    on: vi.fn(() => {}),
    off: vi.fn(() => {}),
  };
  const ledger = pointer ?? createPointerLedger(() => (current ? tab.binding : null));
  const tab: TabRecord = {
    pointer: ledger,
    diagnostics: unavailableDiagnostics,
    page: page as unknown as Page,
    binding,
    stopped: false,
    captureSequence: 0,
    pending: 0,
    tail: Promise.resolve(),
  };
  const gate = createBrowserStopGate(binding.browserId, binding.browserGeneration);
  const composed = createOwnedFixtureEngineInput({
    tab,
    stopGate: gate,
    policy: { authorizeAction: async () => 'allowed', verifyBrokerLease: async () => 'unknown' },
    readTab: () => {
      observeBinding?.();
      return current ? tab : null;
    },
  });
  return {
    ready: composed.input.ready,
    input: composed.input,
    record: composed.record,
    slot: composed.slot,
    close: composed.close,
    get owner() {
      const target = composed.slot.registeredTarget;
      if (!target || target.page !== (page as unknown as Page))
        throw new Error('FIXTURE_TRANSPORT_NOT_REGISTERED');
      return target.transport as OwnedCleanupTransport;
    },
    pointer: ledger,
    page,
    context,
    session,
    mouse,
    keyboard,
    effects,
    replace: () => {
      tab.binding = { ...tab.binding, epoch: tab.binding.epoch + 1 };
    },
    retire: () => {
      current = false;
      composed.record.lifetime.requestRetirement('authorityRevoked');
    },
  };
}
const retirementCancellations = [
  ['send', 'Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }],
  ['send', 'Input.cancelDragging'],
];
const signal = () => new AbortController().signal;
const tick = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());

it('uses only canonical public Page input and two fixed native reset commands', async () => {
  const h = fixture();
  await h.ready;
  for (const step of [
    { kind: 'mouseMove', x: 2, y: 3 },
    { kind: 'mouseDown', button: 'left' },
    { kind: 'mouseUp', button: 'left' },
    { kind: 'wheel', deltaX: 1, deltaY: -2 },
    { kind: 'keyDown', key: 'Shift' },
    { kind: 'keyUp', key: 'Shift' },
    { kind: 'text', text: '😀中文' },
  ] as const)
    await h.owner.native.dispatch(step, signal());
  await h.owner.native.cancelComposition(signal());
  await h.owner.native.cancelDrag(signal());
  expect(h.context.newCDPSession).toHaveBeenCalledWith(h.page);
  expect(h.effects).toEqual([
    ['move', 2, 3],
    ['mouseDown', { button: 'left' }],
    ['mouseUp', { button: 'left' }],
    ['wheel', 1, -2],
    ['keyDown', 'Shift'],
    ['keyUp', 'Shift'],
    ['text', '😀中文'],
    ['send', 'Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }],
    ['send', 'Input.cancelDragging'],
  ]);
  expect(await h.close()).toMatchObject({ detached: true, uncertain: false });
});
it('refuses points on or beyond the canonical viewport edge without a Page move', async () => {
  const h = fixture();
  await h.ready;
  await expect(
    h.owner.native.dispatch({ kind: 'mouseMove', x: 100, y: 1 }, signal())
  ).rejects.toThrow('VIEWPORT');
  expect(h.effects).toEqual([]);
  await h.close();
});
it('refuses API-getter reentrant binding replacement before the native call', async () => {
  const h = fixture();
  await h.ready;
  Object.defineProperty(h.keyboard, 'insertText', {
    get: () => {
      h.replace();
      return vi.fn(async () => {
        h.effects.push('WRONG_LIFETIME');
      });
    },
  });
  await expect(
    h.owner.native.dispatch({ kind: 'text', text: 'FIXTURE' }, signal())
  ).rejects.toThrow('TARGET_REFUSED');
  expect(h.effects).toEqual([]);
  await h.close();
});
it('preregisters native custody before getters reenter shared close', async () => {
  const h = fixture();
  await h.ready;
  let pending = -1;
  Object.defineProperty(h.page, 'keyboard', {
    get: () => {
      pending = h.owner.custody().nativePending;
      void h.close();
      return h.keyboard;
    },
  });
  await expect(
    h.owner.native.dispatch({ kind: 'text', text: 'FIXTURE' }, signal())
  ).rejects.toThrow('TARGET_REFUSED');
  expect(pending).toBe(1);
  expect(h.effects).not.toContain('text');
  await h.close();
});
it('abort refuses unstarted dispatch and is not a native cancellation claim', async () => {
  const h = fixture();
  await h.ready;
  const abort = new AbortController();
  abort.abort();
  await expect(
    h.owner.native.dispatch({ kind: 'keyDown', key: 'Alt' }, abort.signal)
  ).rejects.toThrow('TARGET_REFUSED');
  expect(h.effects).toEqual([]);
  await h.close();
});
it('terminal close does not release held keys or manufacture certain cleanup', async () => {
  const h = fixture();
  await h.ready;
  await h.owner.native.dispatch({ kind: 'keyDown', key: 'Control' }, signal());
  expect(await h.close()).toMatchObject({ detached: true, uncertain: true });
  expect(h.effects).toEqual([['keyDown', 'Control'], ...retirementCancellations, ['detach']]);
});
it.each(['Input.imeSetComposition', 'Input.cancelDragging'])(
  'unsupported %s fails and retains cleanup uncertainty',
  async (method) => {
    const h = fixture();
    await h.ready;
    h.session.send.mockRejectedValueOnce(new Error('UNSUPPORTED_NATIVE_COMMAND'));
    await expect(
      method === 'Input.cancelDragging'
        ? h.owner.native.cancelDrag(signal())
        : h.owner.native.cancelComposition(signal())
    ).rejects.toThrow('UNSUPPORTED_NATIVE_COMMAND');
    expect((await h.close()).uncertain).toBe(true);
  }
);
it('retains in-flight native uncertainty after detach and later acknowledgement', async () => {
  const h = fixture();
  await h.ready;
  const pending = deferred<void>();
  h.keyboard.insertText.mockImplementation(() => pending.promise);
  const call = h.owner.native.dispatch({ kind: 'text', text: 'FIXTURE' }, signal());
  void call.catch(() => {});
  expect(await h.close()).toMatchObject({ nativePending: 1, uncertain: true });
  pending.resolve();
  await tick();
  expect(h.owner.custody()).toMatchObject({ nativePending: 0, uncertain: true });
});
it('shares the exact child close promise after genuine parent terminal entry, including reentrant detach', async () => {
  const h = fixture();
  await h.ready;
  const transport = h.owner;
  expect(h.slot.registeredTarget!.transport).toBe(transport);
  let nested: unknown;
  h.session.detach.mockImplementation(async () => {
    nested = transport.close();
  });
  const parentWait = h.close();
  await tick();
  expect(h.record.lifetime.ordinary.retirement.terminalEntered).toBe(true);
  const childClose = transport.close();
  expect(transport.close()).toBe(childClose);
  expect(parentWait).not.toBe(childClose);
  await parentWait;
  expect(nested).toBe(childClose);
});

it('subordinates a hung detach to caller deadline and observes late rejection', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
  const h = fixture();
  await h.ready;
  const detach = deferred<void>();
  h.session.detach.mockImplementation(() => detach.promise);
  const close = h.close(performance.now() + 50);
  await vi.advanceTimersByTimeAsync(50);
  expect(await close).toMatchObject({ detachPending: true, uncertain: true });
  detach.reject(new Error('LATE_DETACH_REJECTION'));
  await tick();
  expect(h.owner.custody()).toMatchObject({ detachPending: false, uncertain: true });
});
it('late session after acquisition deadline is detached without target publication or uncertainty healing', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
  const pending = deferred<CDPSession>();
  const h = fixture(undefined, undefined, (context) =>
    context.newCDPSession.mockImplementation(() => pending.promise)
  );
  const ready = expect(h.ready).rejects.toThrow('INPUT_DEADLINE');
  await vi.advanceTimersByTimeAsync(2000);
  await ready;
  expect(h.slot.registeredTarget).toBeUndefined();
  const originalEnd = h.record.lifetime.inputEnd;
  const close = h.close(performance.now());
  await vi.advanceTimersByTimeAsync(2000);
  expect(await close).toMatchObject({ acquisitionPending: true, uncertain: true });
  pending.resolve(h.session as unknown as CDPSession);
  await tick();
  expect(h.session.detach).toHaveBeenCalledTimes(1);
  expect(h.input.custody()).toMatchObject({
    acquisitionPending: false,
    detached: true,
    uncertain: true,
  });
  expect(h.slot.registeredTarget).toBeUndefined();
  expect(h.record.lifetime.inputEnd).toBe(originalEnd);
});

it('already-expired caller budget still attempts exact-owned detach without claiming certainty', async () => {
  const h = fixture();
  await h.ready;
  expect(await h.close(performance.now() - 1)).toMatchObject({ uncertain: true });
  expect(h.session.detach).toHaveBeenCalledTimes(1);
});

it('a final cleanup Page observation crossing the original end cannot enter native cancellation', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
  const h = fixture();
  await h.ready;
  let retiringReads = 0,
    captured = false;
  const send = h.session.send;
  Object.defineProperty(h.session, 'send', {
    get: () => {
      captured = true;
      return send;
    },
  });
  h.page.isClosed = () => {
    if (captured && h.record.lifetime.ordinary.phase === 'retiring' && ++retiringReads === 2)
      vi.advanceTimersByTime(2001);
    return false;
  };
  const closing = h.close();
  await vi.advanceTimersByTimeAsync(5000);
  expect(await closing).toMatchObject({ uncertain: true });
  expect(retiringReads).toBeGreaterThanOrEqual(2);
  expect(h.record.lifetime.inputEnd).toBe(2000);
  expect(h.record.lifetime.parentEnd).toBe(5000);
  expect(h.effects.filter((effect) => Array.isArray(effect) && effect[0] === 'send')).toEqual([]);
  expect(h.session.detach).toHaveBeenCalledTimes(1);
});

it('a Proxy canonical cleanup binding refuses native cancellation rather than treating traps as data', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
  const h = fixture();
  await h.ready;
  h.slot.tab.binding = new Proxy(h.slot.tab.binding, {
    ownKeys: (target) => Reflect.ownKeys(target),
    getOwnPropertyDescriptor: (target, key) => Object.getOwnPropertyDescriptor(target, key),
  });
  const closing = h.close();
  await vi.advanceTimersByTimeAsync(5000);
  const outcome = await closing;
  expect(h.effects.filter((effect) => Array.isArray(effect) && effect[0] === 'send')).toEqual([]);
  expect(outcome).toMatchObject({ uncertain: true, detached: true });
  expect(h.session.detach).toHaveBeenCalledTimes(1);
  expect(h.record.lifetime.inputEnd).toBe(2000);
  expect(h.record.lifetime.parentEnd).toBe(5000);
});

it('a stable final cleanup Page observation retains exactly two fixed cancellations', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
  const h = fixture();
  await h.ready;
  h.page.isClosed = () => false;
  expect(await h.close()).toMatchObject({ uncertain: false, detached: true });
  expect(h.effects).toEqual([...retirementCancellations, ['detach']]);
  expect(h.record.lifetime.inputEnd).toBe(2000);
  expect(h.record.lifetime.parentEnd).toBe(5000);
});

it('expired parent observation retains a rejection consumer without renewing its end', async () => {
  const h = fixture();
  await h.ready;
  const rejected = new Set<Promise<unknown>>();
  let consumers = 0;
  const reject = Promise.reject;
  const then = Promise.prototype.then;
  Promise.reject = (reason?: unknown) => {
    const operation = Reflect.apply(reject, Promise, [reason]);
    if (reason instanceof Error && reason.message === '') {
      rejected.add(operation);
      Object.defineProperty(operation, 'then', {
        value: function (this: Promise<unknown>, ...args: Parameters<Promise<unknown>['then']>) {
          if (typeof args[1] === 'function') consumers++;
          return Reflect.apply(then, this, args);
        },
      });
    }
    return operation;
  };
  try {
    const end = performance.now() - 1;
    expect(await h.close(end)).toMatchObject({ uncertain: true });
    expect(h.record.lifetime.parentEnd).toBe(end);
    expect(h.session.detach).toHaveBeenCalledTimes(1);
    expect(rejected.size).toBeGreaterThan(0);
    expect(
      consumers,
      'OWNED_REJECTION_MUST_BE_OBSERVED_BEFORE_EXPIRED_WAIT'
    ).toBeGreaterThanOrEqual(rejected.size);
  } finally {
    Promise.reject = reject;
  }
});

it('isClosed observation reentrant close cannot admit a native effect after retirement', async () => {
  const h = fixture();
  await h.ready;
  h.page.isClosed = () => {
    void h.close();
    return false;
  };
  await expect(
    h.owner.native.dispatch({ kind: 'text', text: 'FIXTURE' }, signal())
  ).rejects.toThrow('TARGET_REFUSED');
  await h.close();
  expect(h.effects).toEqual([...retirementCancellations, ['detach']]);
});

it('final binding observation losing current authority refuses captured Page IO', async () => {
  let armed = false;
  const h = fixture(() => {
    if (armed) {
      armed = false;
      h.retire();
    }
  });
  await h.ready;
  const insert = h.keyboard.insertText;
  Object.defineProperty(h.keyboard, 'insertText', {
    get: () => {
      armed = true;
      return insert;
    },
  });
  await expect(
    h.owner.native.dispatch({ kind: 'text', text: 'REFUSED' }, signal())
  ).rejects.toThrow('TARGET_REFUSED');
  expect(armed).toBe(false);
  expect(h.effects).toEqual([]);
  expect(h.owner.custody()).toMatchObject({ nativePending: 0, uncertain: true });
  await h.close();
});
it.each(['composition', 'drag'] as const)(
  'final binding observation refuses captured %s cancellation IO',
  async (kind) => {
    let armed = false;
    const h = fixture(() => {
      if (armed) {
        armed = false;
        h.retire();
      }
    });
    await h.ready;
    const send = h.session.send;
    Object.defineProperty(h.session, 'send', {
      get: () => {
        armed = true;
        return send;
      },
    });
    const work =
      kind === 'composition'
        ? h.owner.native.cancelComposition(signal())
        : h.owner.native.cancelDrag(signal());
    await expect(work).rejects.toThrow('TARGET_REFUSED');
    expect(armed).toBe(false);
    expect(h.effects).toEqual([]);
    expect(h.owner.custody()).toMatchObject({ nativePending: 0, uncertain: true });
    await h.close();
  }
);

it('unsupported observer return is refused without observing promise species or replacing native errors', async () => {
  const observed = vi.fn();
  const unexpected = Object.defineProperty({}, 'then', { get: observed });
  const unavailable = vi.fn();
  const pointer = {
    beginMove: () => unexpected,
    accepts: () => false,
    success: () => undefined,
    invalidate: () => undefined,
    unavailable,
    read: () => ({ revision: 0, terminal: true, marker: null }),
  };
  const h = fixture(undefined, pointer);
  await h.ready;
  await h.owner.native.dispatch({ kind: 'mouseMove', x: 1, y: 2 }, signal());
  expect(unavailable).toHaveBeenCalledOnce();
  expect(observed).not.toHaveBeenCalled();
  const failure = Error('PRIMARY_NATIVE_FAILURE');
  h.mouse.move.mockRejectedValueOnce(failure);
  await expect(h.owner.native.dispatch({ kind: 'mouseMove', x: 1, y: 2 }, signal())).rejects.toBe(
    failure
  );
  expect(observed).not.toHaveBeenCalled();
});
it('missing observer refuses before session acquisition and unsupported accepts return is not truthy authority', async () => {
  const h = fixture();
  await h.ready;
  h.context.newCDPSession.mockClear();
  expect(() =>
    createPageTransport({
      page: h.page,
      current: () => true,
      readBinding: () => null,
      retire: () => {},
    } as unknown as Parameters<typeof createPageTransport>[0])
  ).toThrow('POINTER_OBSERVER_UNAVAILABLE');
  expect(h.context.newCDPSession).not.toHaveBeenCalled();
  const read = vi.fn();
  const invalid = Object.defineProperty({}, 'then', { get: read });
  const unavailable = vi.fn();
  const pointer = {
    beginMove: () => Object.freeze({}),
    accepts: () => invalid as unknown as boolean,
    success: () => undefined,
    invalidate: () => undefined,
    unavailable,
    read: () => ({ revision: 0, terminal: true, marker: null }),
  };
  const owned = fixture(undefined, pointer);
  await owned.ready;
  await owned.owner.native.dispatch({ kind: 'mouseMove', x: 1, y: 2 }, signal());
  expect(unavailable).toHaveBeenCalledOnce();
  expect(read).not.toHaveBeenCalled();
  await owned.close();
  await h.close();
});

it('candidate: forged matching cleanup shape cannot enter exact owned transport', async () => {
  const h = ownedTransportFixture();
  const owner = composeTransportOwner(transportConfiguration(), h.record, h.tab);
  await owner.readiness;
  const transport = owner.registeredTarget!.transport as Pick<OwnedCleanupTransport, 'native'>;
  const attempt: CleanupAttempt = {
    identity: {},
    kind: 'keyUp',
    step: { kind: 'keyUp', key: 'Shift' },
    operation: null,
    entered: false,
    pending: false,
    acknowledged: false,
    uncertain: false,
  };
  await expect(
    transport.native.cleanup({} as CleanupPermit, attempt, new AbortController().signal)
  ).rejects.toThrow();
  expect(h.raw.keyboard.up).toHaveBeenCalledTimes(0);
  expect(h.session.send).toHaveBeenCalledTimes(0);
  expect(attempt.entered).toBe(false);
});

it('distinguishes original known native custody from a pending observation DTO', async () => {
  const h = fixture();
  await h.ready;
  const original = h.owner;
  expect(original.isCustodyKnown()).toBe(true);
  expect(h.input.isCustodyKnown()).toBe(true);
  const pending = deferred<void>();
  h.keyboard.insertText.mockImplementation(() => pending.promise);
  const call = original.native.dispatch({ kind: 'text', text: 'FIXTURE' }, signal());
  expect(original.custody()).toMatchObject({ nativePending: 1, uncertain: true });
  expect(original.isCustodyKnown()).toBe(true);
  expect(h.input.isCustodyKnown()).toBe(true);
  pending.resolve();
  await call;
  expect(original.isCustodyKnown()).toBe(true);
  expect(h.input.isCustodyKnown()).toBe(true);
  await h.close();
  expect(original.isCustodyKnown()).toBe(false);
  expect(h.input.isCustodyKnown()).toBe(false);
});

it('refuses known custody until the original session acquisition completes', async () => {
  const acquired = deferred<CDPSession>();
  const h = fixture(undefined, undefined, (context) =>
    context.newCDPSession.mockImplementation(() => acquired.promise)
  );
  expect(h.input.isCustodyKnown()).toBe(false);
  acquired.resolve(h.session as unknown as CDPSession);
  await h.ready;
  expect(h.owner.isCustodyKnown()).toBe(true);
  expect(h.input.isCustodyKnown()).toBe(true);
  await h.close();
});

it.each(['native', 'cleanup'] as const)(
  'retains original %s failure without healing custody after a later ACK',
  async (kind) => {
    const h = fixture();
    await h.ready;
    const original = h.owner;
    const failure = new Error('ORIGINAL_FAILURE');
    const call =
      kind === 'native'
        ? (h.keyboard.insertText.mockRejectedValueOnce(failure),
          original.native.dispatch({ kind: 'text', text: 'FIXTURE' }, signal()))
        : (h.session.send.mockRejectedValueOnce(failure),
          original.native.cancelComposition(signal()));
    await expect(call).rejects.toThrow('ORIGINAL_FAILURE');
    expect(original.isCustodyKnown()).toBe(false);
    expect(h.input.isCustodyKnown()).toBe(false);
    await original.native.dispatch({ kind: 'text', text: 'LATER' }, signal());
    expect(original.custody().nativePending).toBe(0);
    const forgedObservation = vi.spyOn(original, 'custody').mockReturnValue({
      acquisitionPending: false,
      nativePending: 0,
      detachPending: false,
      detached: false,
      uncertain: false,
    });
    expect(original.isCustodyKnown()).toBe(false);
    expect(h.input.isCustodyKnown()).toBe(false);
    forgedObservation.mockRestore();
    expect(original.isCustodyKnown()).toBe(false);
    expect(h.input.isCustodyKnown()).toBe(false);
    await h.close();
  }
);

it('refuses original custody during detach and after genuine retirement', async () => {
  const h = fixture();
  await h.ready;
  const original = h.owner;
  const detached = deferred<void>();
  h.session.detach.mockImplementation(() => detached.promise);
  const close = h.close();
  await tick();
  expect(original.custody().detachPending).toBe(true);
  expect(original.isCustodyKnown()).toBe(false);
  expect(h.input.isCustodyKnown()).toBe(false);
  detached.resolve();
  await close;
  expect(original.custody().detached).toBe(true);
  expect(original.isCustodyKnown()).toBe(false);
  expect(h.input.isCustodyKnown()).toBe(false);
});

it('refuses known custody after genuine session acquisition rejection', async () => {
  const h = fixture(undefined, undefined, (context) =>
    context.newCDPSession.mockRejectedValueOnce(new Error('ACQUISITION_FAILED'))
  );
  expect(h.input.isCustodyKnown()).toBe(false);
  await expect(h.ready).rejects.toThrow('ACQUISITION_FAILED');
  expect(h.input.isCustodyKnown()).toBe(false);
  await h.close();
});

for (const replacement of ['epoch', 'page', 'ordinary', 'parentMap'] as const)
  it(`an owned dispatcher current callback cannot replace canonical ${replacement} after SDK lookup`, async () => {
    const h = fixture();
    const issuer = createOwnedInputIssuer();
    const originals: { operation?: ReturnType<PrivateBrowserInputDispatcher['input']> } = {};
    const parentRecords = h.record.lifetime.ordinary.records;
    onTestFinished(async () => {
      await Promise.allSettled([originals.operation]);
      // Restore only the test's removed Map entry so the real original owner can tear down.
      // The retired ordinary cell is never reopened and the refused result remains asserted.
      if (replacement === 'parentMap') parentRecords?.set(h.record.browserId, h.record);
      await h.close();
    });
    await h.ready;
    const tab = [...h.record.tabs.values()][0];
    if (!tab) throw new Error('FIXTURE_CANONICAL_TAB_MISSING');
    const binding = { ...tab.binding };
    let methodLookedUp = false;
    let replaced = false;
    const insert = h.keyboard.insertText;
    Object.defineProperty(h.keyboard, 'insertText', {
      configurable: true,
      get() {
        methodLookedUp = true;
        return insert;
      },
    });
    const dispatcher: PrivateBrowserInputDispatcher = {
      input(command, authorization, signal) {
        const token = issuer.issue(command, authorization);
        const parsed = parseBrowserCommand(command);
        if (parsed.kind !== 'input') throw new Error('FIXTURE_INPUT_COMMAND_REFUSED');
        const operation = submitInput(h.record, parsed, signal, token);
        return operation.finally(() => issuer.invalidate(token));
      },
    };
    const operation = dispatcher.input(
      { kind: 'input', requestId, binding, steps: [{ kind: 'text', text: 'refused' }] },
      {
        authorize: async () => 'allowed',
        isCurrent() {
          if (methodLookedUp && !replaced) {
            replaced = true;
            if (replacement === 'epoch')
              tab.binding = { ...tab.binding, epoch: tab.binding.epoch + 1 };
            else if (replacement === 'page') tab.page = fakePage().page;
            else if (replacement === 'ordinary') fenceOrdinary(h.record, 'authorityRevoked');
            else h.record.lifetime.ordinary.records?.delete(h.record.browserId);
          }
          return true;
        },
      }
    );
    originals.operation = operation;
    expect((await operation).outcome).not.toBe('completed');
    expect(replaced).toBe(true);
    expect(insert).not.toHaveBeenCalled();
  });
