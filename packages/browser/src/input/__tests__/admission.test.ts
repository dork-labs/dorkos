import { expect, it, vi } from 'vitest';
import { createTabInput, type InputPorts, type InputResult } from '../index.js';
import { createBrowserStopGate } from '../../lifecycle/stop.js';
import { parseBrowserId, parseTabId } from '../../ids.js';
import type { BrowserBinding } from '../../contracts.js';
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
    publishResetBinding: (b) => {
      binding = b;
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
    get binding() {
      return binding;
    },
    command: () => ({
      kind: 'input',
      requestId: 'request_subject_A_00000000000000',
      binding: { ...binding },
      steps: [{ kind: 'text', text: 'FIXTURE' }],
    }),
  };
}
const tick = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
it('ordinary valid admission has one observable completed effect', async () => {
  const h = fixture();
  expect((await h.input.submit(h.command())).outcome).toBe('completed');
  expect(h.calls).toEqual(['text']);
});
it('already stopped admission is rejected and settled', async () => {
  const h = fixture();
  h.gate.stop();
  expect((await h.input.submit(h.command())).outcome).toBe('rejected');
  expect(h.calls).toEqual([]);
});
it('stop from the initial submit observation must settle this unstarted request', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
  try {
    const h = fixture();
    h.ports.readBinding = () => {
      h.gate.stop();
      return h.binding;
    };
    let result: InputResult | undefined;
    void h.input.submit(h.command()).then((r) => {
      result = r;
    });
    await tick();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.gate.stopped).toBe(true);
    expect(h.calls).toEqual([]);
    expect(result, 'REENTRANT_STOP_ADMISSION_HANG').toMatchObject({
      outcome: 'rejected',
      reason: 'stopped',
    });
  } finally {
    vi.useRealTimers();
  }
});
it('reset actual drain and coalescing block successor until acknowledged', async () => {
  const h = fixture();
  let ack!: () => void;
  const waiting = new Promise<void>((r) => {
    ack = r;
  });
  let reset: ReturnType<typeof h.input.reset> | undefined;
  h.ports.native.dispatch = (s) => {
    h.calls.push(s.kind);
    if (s.kind === 'text') {
      reset = h.input.reset();
      return waiting;
    }
    return Promise.resolve();
  };
  void h.input.submit(h.command());
  await tick();
  expect(reset).toBeDefined();
  let result: unknown;
  void reset!.then((r) => {
    result = r;
  });
  await tick();
  expect(result, 'ACK_REQUIRED').toBeUndefined();
  expect(h.input.reset()).toBe(reset);
  expect((await h.input.submit(h.command())).outcome).toBe('rejected');
  ack();
  expect((await reset!).status).toBe('ready');
  expect(h.calls).toEqual(['text', 'composition', 'drag']);
});
it('cleanup callback cannot release the remaining held key onto replacement navigation', async () => {
  const h = fixture();
  await h.input.submit({
    ...h.command(),
    steps: [
      { kind: 'mouseDown', button: 'left' },
      { kind: 'keyDown', key: 'Shift' },
    ],
  });
  h.calls.length = 0;
  h.ports.native.dispatch = async (s) => {
    h.calls.push(s.kind);
    if (s.kind === 'mouseUp')
      h.ports.readBinding = () => ({ ...h.binding, navigationGeneration: 1 });
  };
  expect((await h.input.reset()).status).toBe('stopped');
  expect(h.calls, 'CLEANUP_AFTER_TARGET_CHANGE').toEqual(['mouseUp']);
  expect(h.gate.stopped).toBe(true);
});
it('primary native failure remains closed dispatchFailed even when the cleanup observer fails', async () => {
  const h = fixture();
  h.ports.native.dispatch = () => {
    h.ports.readBinding = () => {
      throw Error('PRIVATE_SECRET_OBSERVER');
    };
    throw Error('PRIVATE_SECRET_DISPATCH');
  };
  const result = await h.input.submit({
    ...h.command(),
    steps: [{ kind: 'keyDown', key: 'Shift' }],
  });
  expect(result).toMatchObject({ outcome: 'uncertain', reason: 'dispatchFailed' });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_SECRET');
  expect(h.gate.stopped).toBe(true);
  expect((await h.input.reset()).status).toBe('stopped');
  expect(h.calls).toEqual([]);
});
it.each(['epoch', 'inputGeneration'] as const)(
  'reset %s exhaustion stops without wrapping or cleanup',
  async (field) => {
    const h = fixture();
    h.ports.readBinding = () => ({ ...h.binding, [field]: Number.MAX_SAFE_INTEGER });
    expect((await h.input.reset()).status).toBe('stopped');
    expect(h.gate.stopped).toBe(true);
    expect(h.calls).toEqual([]);
  }
);

it('reset from admission observation rejects before enqueueing behind its barrier', async () => {
  const h = fixture();
  const before = h.binding;
  let acknowledge!: () => void;
  const pending = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  h.ports.native.cancelComposition = () => {
    h.calls.push('composition');
    return pending;
  };
  let reset: ReturnType<typeof h.input.reset> | undefined;
  h.ports.readBinding = () => {
    h.ports.readBinding = () => h.binding;
    reset = h.input.reset();
    return before;
  };
  let result: InputResult | undefined;
  void h.input.submit(h.command()).then((value) => {
    result = value;
  });
  await tick();
  try {
    expect(result, 'RESET_ADMISSION_MUST_SETTLE_BEFORE_ACK').toMatchObject({
      outcome: 'rejected',
      reason: 'staleBinding',
    });
  } finally {
    acknowledge();
  }
  expect((await reset!).status).toBe('ready');
  expect(h.calls).toEqual(['composition', 'drag']);
  expect((await h.input.submit(h.command())).outcome).toBe('completed');
});
it('throwing admission observation settles stopped without dispatch or secret echo', async () => {
  const h = fixture();
  h.ports.readBinding = () => {
    throw Error('PRIVATE_ADMISSION_SECRET');
  };
  const result = await h.input.submit(h.command());
  expect(result).toMatchObject({ outcome: 'rejected', reason: 'stopped' });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_ADMISSION_SECRET');
  expect(h.calls).toEqual([]);
  expect(h.gate.stopped).toBe(true);
});
