import { createPointerLedger } from '../../tabs/pointer.js';
import { unavailableDiagnostics } from '../../tabs/diagnostics.js';
import { afterEach, expect, it, vi } from 'vitest';
import type { CDPSession, Page } from 'playwright-core';
import { createEngineInput } from '../engine-input.js';
import type { BrowserBinding } from '../../contracts.js';
import type { TabRecord } from '../../lifecycle/records.js';
import { createBrowserStopGate } from '../../lifecycle/stop.js';
import { parseBrowserId, parseTabId } from '../../ids.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function fixture(configure?: (context: { newCDPSession: ReturnType<typeof vi.fn> }) => void) {
  const binding: BrowserBinding = {
    browserId: parseBrowserId('browser_subject_A_000000000000000'),
    browserGeneration: 0,
    tabId: parseTabId('canonical_tab_A_00000000000000000'),
    navigationGeneration: 0,
    viewportVersion: 0,
    epoch: 0,
    inputGeneration: 0,
  };
  const effects: unknown[] = [];
  const record = (method: string) =>
    vi.fn(async (...args: unknown[]) => {
      effects.push([method, ...args]);
    });
  const session = { send: record('send'), detach: record('detach') };
  const context = { newCDPSession: vi.fn(async () => session as unknown as CDPSession) };
  configure?.(context);
  const callbacks = new Map<string, Set<(...args: unknown[]) => void>>();
  const mainFrame = {};
  const page = {
    context: () => context,
    isClosed: () => false,
    mainFrame: () => mainFrame,
    viewportSize: () => ({ width: 100, height: 80 }),
    mouse: {
      move: record('move'),
      down: record('mouseDown'),
      up: record('mouseUp'),
      wheel: record('wheel'),
    },
    keyboard: { down: record('keyDown'), up: record('keyUp'), insertText: record('text') },
    on: (event: string, callback: (...args: unknown[]) => void) => {
      const set = callbacks.get(event) ?? new Set();
      set.add(callback);
      callbacks.set(event, set);
    },
    off: (event: string, callback: (...args: unknown[]) => void) => {
      callbacks.get(event)?.delete(callback);
    },
  };
  const tab: TabRecord = {
    pointer: createPointerLedger(() => (tab.stopped ? null : tab.binding)),
    diagnostics: unavailableDiagnostics,
    page: page as unknown as Page,
    binding,
    stopped: false,
    captureSequence: 0,
    pending: 0,
    tail: Promise.resolve(),
  };
  const gate = createBrowserStopGate(binding.browserId, 0);
  const policy = {
    authorizeAction: vi.fn(async () => 'allowed' as 'allowed' | 'refused' | 'unknown'),
  };
  const registry = { readTab: vi.fn((): TabRecord | null => tab) };
  const input = createEngineInput({
    tab,
    stopGate: gate,
    policy: { ...policy, verifyBrokerLease: async () => 'unknown' },
    readTab: () => registry.readTab(),
  });
  return {
    input,
    gate,
    tab,
    page,
    context,
    session,
    policy,
    registry,
    effects,
    event: (event: string) => {
      for (const callback of callbacks.get(event) ?? []) callback(mainFrame);
    },
    command: (steps: unknown[] = [{ kind: 'text', text: 'FIXTURE' }]) => ({
      kind: 'input',
      requestId: 'request_subject_A_00000000000000',
      binding: { ...tab.binding },
      steps,
    }),
  };
}
const tick = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());
it('routes a strict command to the original canonical Page and revalidates trusted policy', async () => {
  const h = fixture();
  await h.input.ready;
  expect(
    (await h.input.submit(h.command([{ kind: 'click', x: 4, y: 5, button: 'left' }]))).outcome
  ).toBe('completed');
  expect(h.effects).toEqual([
    ['move', 4, 5],
    ['mouseDown', { button: 'left' }],
    ['mouseUp', { button: 'left' }],
  ]);
  expect(h.policy.authorizeAction).toHaveBeenCalledTimes(6);
  await h.input.close();
});
it.each([
  'browserId',
  'browserGeneration',
  'tabId',
  'navigationGeneration',
  'viewportVersion',
  'epoch',
  'inputGeneration',
] as const)('refuses stale %s without any native effect', async (field) => {
  const h = fixture();
  await h.input.ready;
  const command = h.command();
  Object.assign(command.binding, {
    [field]: typeof command.binding[field] === 'number' ? 1 : 'other_subject_000000000000000000',
  });
  expect((await h.input.submit(command)).outcome).toBe('rejected');
  expect(h.effects).toEqual([]);
  await h.input.close();
});
it('rejects raw protocol/Page/selector extras before any native effect', async () => {
  const h = fixture();
  await h.input.ready;
  await expect(h.input.submit({ ...h.command(), page: h.page })).rejects.toThrow('INVALID_COMMAND');
  expect(h.effects).toEqual([]);
  await h.input.close();
});
it('refuses requests during acquisition rather than binding them to future readiness', async () => {
  const session = deferred<CDPSession>();
  const h = fixture((context) => context.newCDPSession.mockImplementation(() => session.promise));
  expect((await h.input.submit(h.command())).outcome).toBe('rejected');
  session.resolve(h.session as unknown as CDPSession);
  await h.input.ready;
  expect((await h.input.submit(h.command())).outcome).toBe('completed');
  await h.input.close();
});
it.each(['unknown', 'refused'] as const)(
  'trusted %s authority refuses with no native effect',
  async (authority) => {
    const h = fixture();
    await h.input.ready;
    h.policy.authorizeAction.mockResolvedValue(authority);
    expect(await h.input.submit(h.command())).toMatchObject({
      outcome: 'rejected',
      reason: 'policyRefused',
    });
    expect(h.effects).toEqual([]);
    await h.input.close();
  }
);
it('wrong actual TabRecord replacement cannot reuse the original Page queue', async () => {
  const h = fixture();
  await h.input.ready;
  h.registry.readTab.mockImplementation(() => ({ ...h.tab }));
  expect((await h.input.submit(h.command())).outcome).toBe('rejected');
  expect(h.effects).toEqual([]);
  await h.input.close();
});
it('registry observation reentrant terminal stop rejects without a native call', async () => {
  const h = fixture();
  await h.input.ready;
  h.registry.readTab.mockImplementation(() => {
    h.gate.stop();
    return h.tab;
  });
  expect((await h.input.submit(h.command())).outcome).toBe('rejected');
  await h.input.close();
  expect(h.effects).toEqual([['detach']]);
});
it.each(['close', 'framenavigated'])(
  'Page %s invalidates admission synchronously and prevents successor readiness',
  async (event) => {
    const h = fixture();
    await h.input.ready;
    h.event(event);
    expect(h.gate.stopped).toBe(true);
    expect((await h.input.submit(h.command())).outcome).toBe('rejected');
    expect((await h.input.reset()).status).toBe('stopped');
    await h.input.close();
    expect(h.effects).toEqual([['detach']]);
  }
);
it('live reset advances counters and cancels composition/drag with one shared barrier', async () => {
  const h = fixture();
  await h.input.ready;
  await h.input.submit(
    h.command([
      { kind: 'keyDown', key: 'Shift' },
      { kind: 'mouseDown', button: 'left' },
    ])
  );
  const reset = h.input.reset();
  expect(h.input.reset()).toBe(reset);
  expect((await h.input.submit(h.command())).outcome).toBe('rejected');
  expect(await reset).toMatchObject({ status: 'ready', binding: { epoch: 1, inputGeneration: 1 } });
  expect(h.effects.slice(2)).toEqual([
    ['mouseUp', { button: 'left' }],
    ['keyUp', 'Shift'],
    ['send', 'Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }],
    ['send', 'Input.cancelDragging'],
  ]);
  expect((await h.input.submit(h.command())).outcome).toBe('completed');
  await h.input.close();
});
it('terminal stop retains held uncertainty and does not perform live reset cleanup', async () => {
  const h = fixture();
  await h.input.ready;
  await h.input.submit(h.command([{ kind: 'keyDown', key: 'Alt' }]));
  h.gate.stop();
  expect((await h.input.reset()).status).toBe('stopped');
  expect(await h.input.close()).toMatchObject({ uncertain: true, detached: true });
  expect(h.effects).toEqual([['keyDown', 'Alt'], ['detach']]);
});
it('counter exhaustion stops without native reset operations', async () => {
  const h = fixture();
  await h.input.ready;
  h.tab.binding = { ...h.tab.binding, epoch: Number.MAX_SAFE_INTEGER };
  expect((await h.input.reset()).status).toBe('stopped');
  expect(h.gate.stopped).toBe(true);
  await h.input.close();
  expect(h.effects).toEqual([['detach']]);
});
it('acquisition rejection retains original cause and refuses all input', async () => {
  const original = new Error('OWNED_SESSION_ACQUISITION_FAILED');
  const h = fixture((context) => context.newCDPSession.mockRejectedValue(original));
  await expect(h.input.ready).rejects.toBe(original);
  expect(h.gate.stopped).toBe(true);
  expect((await h.input.submit(h.command())).outcome).toBe('rejected');
  await h.input.close();
});
it('close during started operation retains nativePending and does not heal after acknowledgement', async () => {
  const h = fixture();
  await h.input.ready;
  const native = deferred<void>();
  h.page.keyboard.insertText.mockImplementation(() => native.promise);
  const operation = h.input.submit(h.command());
  await tick();
  expect(h.input.custody().nativePending).toBe(1);
  const close = h.input.close();
  expect(h.input.close()).toBe(close);
  expect(await close).toMatchObject({ nativePending: 1, uncertain: true });
  expect((await operation).outcome).toBe('uncertain');
  native.resolve();
  await tick();
  expect(h.input.custody()).toMatchObject({ nativePending: 0, uncertain: true });
  expect((await h.input.reset()).status).toBe('stopped');
});
it('hung native drain does not publish reset readiness or a successor native effect', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
  const h = fixture();
  await h.input.ready;
  const native = deferred<void>();
  h.page.keyboard.insertText.mockImplementation(() => native.promise);
  const work = h.input.submit(h.command());
  await tick();
  const reset = h.input.reset();
  await vi.advanceTimersByTimeAsync(2000);
  expect((await reset).status).toBe('stopped');
  expect((await work).outcome).toBe('uncertain');
  expect((await h.input.submit(h.command())).outcome).toBe('rejected');
  native.reject(new Error('LATE_NATIVE'));
  await tick();
  await h.input.close();
  expect(h.input.custody().uncertain).toBe(true);
});

it('reentrant Page API getter live reset cannot dispatch the old-binding text', async () => {
  const h = fixture();
  await h.input.ready;
  let reset: ReturnType<typeof h.input.reset> | undefined;
  const insert = h.page.keyboard.insertText;
  Object.defineProperty(h.page.keyboard, 'insertText', {
    get: () => {
      reset ??= h.input.reset();
      return insert;
    },
  });
  expect((await h.input.submit(h.command())).outcome).toBe('uncertain');
  expect((await reset!).status).toBe('stopped');
  expect(h.effects.some((effect) => Array.isArray(effect) && effect[0] === 'text')).toBe(false);
  await h.input.close();
});
it('unknown cancellation capability stops the shared live reset instead of synthetic success', async () => {
  const h = fixture();
  await h.input.ready;
  h.session.send.mockRejectedValue(new Error('COMMAND_NOT_SUPPORTED'));
  expect((await h.input.reset()).status).toBe('stopped');
  expect(h.gate.stopped).toBe(true);
  expect((await h.input.submit(h.command())).outcome).toBe('rejected');
  expect((await h.input.close()).uncertain).toBe(true);
});
it('never-settled session acquisition has a bounded original failure and quarantined custody', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
  const pending = deferred<CDPSession>();
  const h = fixture((context) => context.newCDPSession.mockImplementation(() => pending.promise));
  const ready = expect(h.input.ready).rejects.toThrow('INPUT_DEADLINE');
  await vi.advanceTimersByTimeAsync(2000);
  await ready;
  expect(h.gate.stopped).toBe(true);
  expect(h.input.custody().acquisitionPending).toBe(true);
  const close = h.input.close();
  await vi.advanceTimersByTimeAsync(2000);
  expect(await close).toMatchObject({ acquisitionPending: true, uncertain: true });
  pending.resolve(h.session as unknown as CDPSession);
  await tick();
  expect(h.input.custody()).toMatchObject({ detached: true, uncertain: true });
  expect((await h.input.submit(h.command())).outcome).toBe('rejected');
});
it('terminal close during acquisition detaches the late exact session inside the same deadline', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
  const pending = deferred<CDPSession>();
  const h = fixture((context) => context.newCDPSession.mockImplementation(() => pending.promise));
  const originalReady = expect(h.input.ready).rejects.toThrow('INPUT_SESSION_REFUSED');
  const close = h.input.close(performance.now() + 100);
  await vi.advanceTimersByTimeAsync(50);
  pending.resolve(h.session as unknown as CDPSession);
  await tick();
  await originalReady;
  expect(await close).toMatchObject({ detached: true, acquisitionPending: false });
  expect((await h.input.submit(h.command())).outcome).toBe('rejected');
  expect(h.session.detach).toHaveBeenCalledTimes(1);
});
it('policy callback replacement after await refuses before native entry', async () => {
  const h = fixture();
  await h.input.ready;
  h.policy.authorizeAction.mockImplementation(async () => {
    h.tab.binding = { ...h.tab.binding, viewportVersion: 1 };
    return 'allowed';
  });
  expect((await h.input.submit(h.command())).outcome).toBe('rejected');
  expect(h.effects).toEqual([]);
  await h.input.close();
});

it('throwing Page listener removal still attempts session detach and retains uncertainty', async () => {
  const h = fixture();
  await h.input.ready;
  h.page.off = () => {
    throw new Error('LISTENER_REMOVAL_FAILED');
  };
  expect(await h.input.close()).toMatchObject({ detached: true, uncertain: true });
  expect(h.effects).toEqual([['detach']]);
});

it('terminal teardown during an active reset cannot renew its already-running deadline', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
  const h = fixture();
  await h.input.ready;
  const cancellation = deferred<void>();
  h.session.send.mockImplementation(() => cancellation.promise);
  const detach = deferred<void>();
  h.session.detach.mockImplementation(() => detach.promise);
  const reset = h.input.reset();
  await tick();
  await vi.advanceTimersByTimeAsync(1500);
  const close = h.input.close();
  let closed: Awaited<typeof close> | undefined;
  void close.then((result) => {
    closed = result;
  });
  try {
    await vi.advanceTimersByTimeAsync(500);
    expect(closed, 'shared reset deadline must settle terminal teardown').toMatchObject({
      detachPending: true,
      uncertain: true,
    });
    expect((await reset).status).toBe('stopped');
  } finally {
    cancellation.reject(new Error('LATE_CANCEL'));
    detach.resolve();
    await tick();
  }
  expect(h.input.custody().uncertain).toBe(true);
});

it('parent gate stop cannot start a fresh teardown budget before explicit deadline-bound close', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
  const h = fixture();
  await h.input.ready;
  const detach = deferred<void>();
  h.session.detach.mockImplementation(() => detach.promise);
  h.gate.stop();
  expect(h.session.detach).not.toHaveBeenCalled();
  const close = h.input.close(performance.now() + 100);
  await vi.advanceTimersByTimeAsync(100);
  expect(await close).toMatchObject({ detachPending: true, uncertain: true });
  detach.resolve();
  await tick();
  expect(h.input.custody().uncertain).toBe(true);
});

it('registry-observation reentrant reset joins the same prepublished composition barrier', async () => {
  const h = fixture();
  await h.input.ready;
  let entered = false;
  let nested: ReturnType<typeof h.input.reset> | undefined;
  h.registry.readTab.mockImplementation(() => {
    if (!entered) {
      entered = true;
      nested = h.input.reset();
    }
    return h.tab;
  });
  const reset = h.input.reset();
  expect(nested).toBe(reset);
  expect((await reset).status).toBe('ready');
  expect(h.tab.binding.epoch).toBe(1);
  await h.input.close();
});

it('requests issued inside a reset registry callback refuse at the composition barrier', async () => {
  const h = fixture();
  await h.input.ready;
  let entered = false;
  let during: ReturnType<typeof h.input.submit> | undefined;
  h.registry.readTab.mockImplementation(() => {
    if (!entered) {
      entered = true;
      during = h.input.submit(h.command());
    }
    return h.tab;
  });
  const reset = h.input.reset();
  expect(await during!).toMatchObject({ outcome: 'rejected', reason: 'staleBinding' });
  expect((await reset).status).toBe('ready');
  expect(h.policy.authorizeAction).not.toHaveBeenCalled();
  expect(h.effects).toEqual([
    ['send', 'Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }],
    ['send', 'Input.cancelDragging'],
  ]);
  await h.input.close();
});

it('final binding observation replacing canonical record refuses original Page IO', async () => {
  const h = fixture();
  await h.input.ready;
  const command = h.command();
  const binding = h.tab.binding;
  const insert = h.page.keyboard.insertText;
  let reads = 0;
  let replaced = false;
  Object.defineProperty(h.page.keyboard, 'insertText', {
    get: () => {
      Object.defineProperty(h.tab, 'binding', {
        configurable: true,
        get: () => {
          // Five current-authority field observations precede the final complete binding read.
          if (++reads === 6) {
            replaced = true;
            h.registry.readTab.mockImplementation(() => ({ ...h.tab, binding }));
          }
          return binding;
        },
      });
      return insert;
    },
  });
  expect((await h.input.submit(command)).outcome).not.toBe('completed');
  expect(replaced).toBe(true);
  expect(h.effects).toEqual([]);
  expect(h.input.custody()).toMatchObject({ nativePending: 0, uncertain: true });
  await h.input.close();
});
