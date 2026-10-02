import { expect, it, vi } from 'vitest';
import type { BrowserBinding } from '../../contracts.js';
import { parseBrowserId, parseTabId } from '../../ids.js';
import { createBrowserStopGate } from '../../lifecycle/stop.js';
import { createTabInput, type InputPorts, type ResetResult } from '../index.js';
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
  const input = createTabInput(ports);
  return {
    input,
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
    expect(h.gate.stopped).toBe(true);
    expect((await h.input.submit(h.command())).outcome).toBe('rejected');
  } finally {
    vi.useRealTimers();
  }
});
it('independent stopped observer on ordinary dispatch path never adds native IO', async () => {
  const h = fixture();
  let reads = 0;
  const read = h.ports.readBinding;
  h.ports.readBinding = () => {
    reads++;
    if (reads === 3) h.gate.stop();
    return read();
  };
  const r = await h.input.submit(h.command());
  expect(r.outcome).toBe('rejected');
  expect(h.calls).toEqual([]);
  expect(h.gate.stopped).toBe(true);
});
it('independent unknown authority with held modifier forces exact release and no successor effect', async () => {
  const h = fixture();
  let checks = 0;
  h.ports.authorize = async () => (++checks === 1 ? 'allowed' : 'unknown');
  const r = await h.input.submit(h.command('mouseDown'));
  expect(r).toMatchObject({ outcome: 'aborted', reason: 'policyRefused' });
  await tick();
  expect(h.calls).toEqual(['mouseDown', 'mouseUp', 'composition', 'drag']);
  h.ports.authorize = async () => 'allowed';
  expect((await h.input.submit(h.command())).outcome).toBe('completed');
});

it('independent reentrant started effect remains live after ready and successor admission', async () => {
  const h = fixture();
  let reset: Promise<ResetResult> | undefined;
  let late!: () => void;
  let held = false;
  const pending = new Promise<void>((r) => {
    late = () => {
      held = true;
      r();
    };
  });
  h.ports.native.dispatch = (s) => {
    h.calls.push(s.kind);
    if (s.kind === 'mouseDown') {
      reset = h.input.reset();
      return pending;
    }
    if (s.kind === 'mouseUp') held = false;
    return Promise.resolve();
  };
  const result = await h.input.submit(h.command('mouseDown'));
  const resetResult = await reset!;
  const successor = await h.input.submit(h.command());
  late();
  await tick();
  console.log(
    JSON.stringify({
      cause: 'REENTRANT_NATIVE_RESTORED_AFTER_READY',
      action: result.outcome,
      reset: resetResult.status,
      successor: successor.outcome,
      heldAfterLateEffect: held,
      browserStopped: h.gate.stopped,
      calls: h.calls,
    })
  );
  expect(resetResult.status, 'REENTRANT_NATIVE_RESTORED_AFTER_READY').toBe('stopped');
  expect(successor.outcome).toBe('rejected');
  expect(h.gate.stopped).toBe(true);
  expect(held).toBe(true); // A late effect is uncertain, never proof that reset restored readiness.
  expect((await h.input.submit(h.command())).outcome).toBe('rejected');
  h.gate.stop();
});
it('actual dispatch settlement during reentrant reset permits exact cleanup and fresh input', async () => {
  const h = fixture();
  let reset: Promise<ResetResult> | undefined;
  h.ports.native.dispatch = (s) => {
    h.calls.push(s.kind);
    if (s.kind === 'mouseDown') reset = h.input.reset();
    return Promise.resolve();
  };
  const action = await h.input.submit(h.command('mouseDown'));
  expect(action.outcome).toBe('uncertain');
  expect((await reset!).status).toBe('ready');
  expect(h.calls).toEqual(['mouseDown', 'mouseUp', 'composition', 'drag']);
  expect((await h.input.submit(h.command())).outcome).toBe('completed');
  expect(h.gate.stopped).toBe(false);
});
it.each(['reject', 'throw', 'thenableThrow'] as const)(
  'reentrant native %s never acknowledges drain or admits a successor',
  async (mode) => {
    const h = fixture();
    let reset: Promise<ResetResult> | undefined;
    h.ports.native.dispatch = (s) => {
      h.calls.push(s.kind);
      if (s.kind !== 'mouseDown') return Promise.resolve();
      reset = h.input.reset();
      if (mode === 'throw') throw Error('INTENDED_NATIVE_THROW');
      if (mode === 'thenableThrow')
        return Object.defineProperty({}, 'then', {
          get() {
            throw Error('INTENDED_NATIVE_THENABLE_THROW');
          },
        }) as Promise<void>;
      return Promise.reject(Error('INTENDED_NATIVE_REJECTION'));
    };
    const action = await h.input.submit(h.command('mouseDown'));
    expect(action.outcome).toBe('uncertain');
    expect((await reset!).status, 'FAILED_NATIVE_DRAIN_CERTIFIED').toBe('stopped');
    expect(h.calls).toEqual(['mouseDown', 'mouseUp', 'composition', 'drag']);
    expect(h.gate.stopped).toBe(true);
    expect((await h.input.submit(h.command())).outcome).toBe('rejected');
    expect((await h.input.reset()).status).toBe('stopped');
  }
);
it('pending started operation blocks successor and only its actual acknowledgement permits reset ready', async () => {
  const h = fixture();
  let reset: Promise<ResetResult> | undefined;
  let acknowledge!: () => void;
  let settled = false;
  const pending = new Promise<void>((r) => {
    acknowledge = r;
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
  void reset!.then(() => {
    settled = true;
  });
  await tick();
  expect(settled, 'PENDING_NATIVE_ACK_SKIPPED').toBe(false);
  expect(h.calls).toEqual(['mouseDown']);
  expect((await h.input.submit(h.command())).outcome).toBe('rejected');
  acknowledge();
  expect((await reset!).status).toBe('ready');
  expect((await action).outcome).toBe('uncertain');
  expect(h.calls).toEqual(['mouseDown', 'mouseUp', 'composition', 'drag']);
  expect(h.gate.stopped).toBe(false);
  expect((await h.input.submit(h.command())).outcome).toBe('completed');
});
