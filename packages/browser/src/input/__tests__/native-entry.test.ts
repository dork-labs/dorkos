import { expect, it, vi } from 'vitest';
import type { BrowserBinding } from '../../contracts.js';
import { parseBrowserId, parseTabId } from '../../ids.js';
import { createBrowserStopGate } from '../../lifecycle/stop.js';
import { type ResetResult } from '../index.js';
import {
  createOwnedFixtureCohort,
  settleFixtureRetirement,
  type FixtureInputPorts as InputPorts,
} from '../../__tests__/parent-fixture.js';
function fixture() {
  let binding: BrowserBinding = {
    browserId: parseBrowserId('browser_subject_A_000000000000000'),
    browserGeneration: 0,
    tabId: parseTabId('canonical_tab_A_00000000000000000'),
    navigationGeneration: 0,
    viewportVersion: 0,
    epoch: 0,
    inputGeneration: 0,
  };
  const calls: string[] = [];
  const gate = createBrowserStopGate(binding.browserId, 0);
  const ports: InputPorts = {
    readBinding: () => binding,
    publishResetBinding: (next) => {
      binding = next;
    },
    authorize: async () => 'allowed',
    stopGate: gate,
    native: {
      dispatch: async (s) => {
        calls.push(s.kind);
      },
      cancelComposition: async () => {
        calls.push('composition');
      },
      cancelDrag: async () => {
        calls.push('drag');
      },
    },
  };
  const { input, transport } = createOwnedFixtureCohort([
    { ports, readCanonicalBinding: () => binding },
  ])[0];
  return {
    input,
    transport,
    ports,
    calls,
    gate,
    command: (kind: 'mouseDown' | 'text' = 'text') => ({
      kind: 'input',
      requestId: 'request_subject_A_00000000000000',
      binding: { ...binding },
      steps: kind === 'mouseDown' ? [{ kind, button: 'left' }] : [{ kind, text: 'FRESH' }],
    }),
  };
}
const tick = async () => {
  for (let n = 0; n < 30; n++) await Promise.resolve();
};
it('independent dispatch-entry reset cannot certify ready while started native effect remains unacknowledged', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  try {
    const h = fixture();
    let reset: Promise<ResetResult> | undefined;
    let late!: () => void;
    let originalSettled = false;
    const pending = new Promise<void>((r) => {
      late = () => {
        originalSettled = true;
        r();
      };
    });
    h.ports.native.dispatch = (s) => {
      h.calls.push(s.kind);
      if (s.kind === 'mouseDown') {
        reset = h.input.reset();
        return pending;
      }
      return Promise.resolve();
    };
    const action = h.input.submit(h.command('mouseDown'));
    await tick();
    expect(reset).toBeDefined();
    let result: ResetResult | undefined;
    void reset!.then((r) => {
      result = r;
    });
    await tick();
    expect(originalSettled).toBe(false);
    expect(result, 'STARTED_NATIVE_DRAIN_SKIPPED').toBeUndefined();
    await vi.advanceTimersByTimeAsync(2000);
    expect((await reset!).status).toBe('stopped');
    expect((await action).outcome).toBe('uncertain');
    late();
    await tick();
    await settleFixtureRetirement(h.input);
    expect(h.gate.stopped).toBe(true);
    expect((await h.input.submit(h.command())).outcome).toBe('rejected');
  } finally {
    vi.useRealTimers();
  }
});

it('method capture reset refuses the unstarted old-generation effect without charging held input', async () => {
  const h = fixture();
  let reset: Promise<ResetResult> | undefined;
  const dispatch = h.transport.dispatch;
  Object.defineProperty(h.transport, 'dispatch', {
    configurable: true,
    get() {
      Object.defineProperty(h.transport, 'dispatch', { configurable: true, value: dispatch });
      reset = h.input.reset();
      return dispatch;
    },
  });
  const result = await h.input.submit(h.command('mouseDown'));
  expect(result).toMatchObject({ outcome: 'rejected', reason: 'staleBinding' });
  expect(reset).toBeDefined();
  expect((await reset!).status).toBe('ready');
  expect(h.calls).toEqual(['composition', 'drag']);
  expect((await h.input.submit(h.command())).outcome).toBe('completed');
  expect(h.calls).toEqual(['composition', 'drag', 'text']);
});

it.each(['binding-observation', 'method-capture'] as const)(
  'refuses an unstarted effect when %s crosses its original execution deadline',
  async (boundary) => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    try {
      const h = fixture();
      if (boundary === 'binding-observation') {
        const read = h.ports.readBinding;
        h.ports.authorize = async () => {
          h.ports.readBinding = () => {
            h.ports.readBinding = read;
            vi.advanceTimersByTime(2000);
            return read();
          };
          return 'allowed';
        };
      } else {
        const dispatch = h.transport.dispatch;
        Object.defineProperty(h.transport, 'dispatch', {
          configurable: true,
          get() {
            vi.advanceTimersByTime(2000);
            return dispatch;
          },
        });
      }
      expect(await h.input.submit(h.command())).toMatchObject({
        outcome: 'rejected',
        reason: 'deadline',
      });
      expect(h.calls).toEqual([]);
      expect(h.gate.stopped).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  }
);
