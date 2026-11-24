import { createOwnedFixtureEngineInput } from '../../__tests__/parent-fixture.js';
import { createPointerLedger } from '../../tabs/pointer.js';
import { unavailableDiagnostics } from '../../tabs/diagnostics.js';
import { afterEach, expect, it, vi } from 'vitest';
import type { CDPSession, Page } from 'playwright-core';
import type { BrowserBinding } from '../../contracts.js';
import type { TabRecord } from '../../lifecycle/records.js';
import { createBrowserStopGate } from '../../lifecycle/stop.js';
import { parseBrowserId, parseTabId } from '../../ids.js';

const tick = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

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
  const composed = createOwnedFixtureEngineInput({
    tab,
    stopGate: gate,
    policy: { ...policy, verifyBrokerLease: async () => 'unknown' },
    readTab: () => registry.readTab(),
  });
  return {
    input: composed.input,
    close: composed.close,
    record: composed.record,
    slot: composed.slot,
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
  await h.close();
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
  await h.close();
});
it('rejects raw protocol/Page/selector extras before any native effect', async () => {
  const h = fixture();
  await h.input.ready;
  await expect(h.input.submit({ ...h.command(), page: h.page })).rejects.toThrow('INVALID_COMMAND');
  expect(h.effects).toEqual([]);
  await h.close();
});
it('refuses requests during acquisition rather than binding them to future readiness', async () => {
  const session = deferred<CDPSession>();
  const h = fixture((context) => context.newCDPSession.mockImplementation(() => session.promise));
  expect((await h.input.submit(h.command())).outcome).toBe('rejected');
  session.resolve(h.session as unknown as CDPSession);
  await h.input.ready;
  expect((await h.input.submit(h.command())).outcome).toBe('completed');
  await h.close();
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
    await h.close();
  }
);
it('wrong actual TabRecord replacement cannot reuse the original Page queue', async () => {
  const h = fixture();
  await h.input.ready;
  h.registry.readTab.mockImplementation(() => ({ ...h.tab }));
  expect((await h.input.submit(h.command())).outcome).toBe('rejected');
  expect(h.effects).toEqual([]);
  await h.close();
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
  await h.close();
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
  await h.close();
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
  await h.close();
});

it('terminal close during acquisition detaches the late exact session inside the same deadline', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
  const pending = deferred<CDPSession>();
  const h = fixture((context) => context.newCDPSession.mockImplementation(() => pending.promise));
  const originalReady = expect(h.input.ready).rejects.toMatchObject({ code: 'BROWSER_STOPPED' });
  const close = h.close(performance.now() + 100);
  await vi.advanceTimersByTimeAsync(50);
  pending.resolve(h.session as unknown as CDPSession);
  await tick();
  await originalReady;
  expect(await close).toMatchObject({ detached: true, acquisitionPending: false });
  expect((await h.input.submit(h.command())).outcome).toBe('rejected');
  expect(h.session.detach).toHaveBeenCalledTimes(1);
});
