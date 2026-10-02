import { describe, expect, it, vi } from 'vitest';
import type { BrowserBinding } from '../../contracts.js';
import { parseBrowserId, parseTabId } from '../../ids.js';
import { createBrowserStopGate } from '../../lifecycle/stop.js';
import { createTabInput, type InputPorts, type NativeInputStep } from '../index.js';

const RELEASES = [
  'mouseUp:left',
  'mouseUp:right',
  'keyUp:Shift',
  'keyUp:Control',
  'composition',
  'drag',
];
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
  let transition: (call: string) => Promise<void> = async () => {};
  const dispatch = vi.fn(async (step: NativeInputStep) => {
    if (step.kind === 'mouseUp' || step.kind === 'keyUp') {
      const call =
        step.kind === 'mouseUp' ? `${step.kind}:${step.button}` : `${step.kind}:${step.key}`;
      calls.push(call);
      await transition(call);
    } else if (step.kind === 'text') calls.push('SUCCESSOR');
  });
  const stopGate = createBrowserStopGate(binding.browserId, binding.browserGeneration);
  const ports: InputPorts = {
    readBinding: () => binding,
    publishResetBinding: (next) => {
      binding = next;
    },
    authorize: async () => 'allowed',
    stopGate,
    native: {
      dispatch,
      cancelComposition: async () => {
        calls.push('composition');
        await transition('composition');
      },
      cancelDrag: async () => {
        calls.push('drag');
        await transition('drag');
      },
    },
  };
  const input = createTabInput(ports);
  const command = (steps: NativeInputStep[]) => ({
    kind: 'input',
    requestId: 'request_subject_A_00000000000000',
    binding: { ...binding },
    steps,
  });
  return {
    input,
    ports,
    stopGate,
    calls,
    command,
    set transition(fn: (call: string) => Promise<void>) {
      transition = fn;
    },
    get binding() {
      return binding;
    },
    set binding(next: BrowserBinding) {
      binding = next;
    },
  };
}
async function held(h: ReturnType<typeof fixture>) {
  const result = await h.input.submit(
    h.command([
      { kind: 'mouseDown', button: 'left' },
      { kind: 'mouseDown', button: 'right' },
      { kind: 'keyDown', key: 'Shift' },
      { kind: 'keyDown', key: 'Control' },
    ])
  );
  expect(result.outcome).toBe('completed');
}
const changes: (keyof BrowserBinding | 'missing' | 'throw' | 'stop')[] = [
  'browserId',
  'browserGeneration',
  'tabId',
  'navigationGeneration',
  'viewportVersion',
  'epoch',
  'inputGeneration',
  'missing',
  'throw',
  'stop',
];
function change(h: ReturnType<typeof fixture>, field: (typeof changes)[number]) {
  if (field === 'missing') h.ports.readBinding = () => null;
  else if (field === 'throw')
    h.ports.readBinding = () => {
      throw Error('REGISTRY_UNAVAILABLE');
    };
  else if (field === 'stop') h.stopGate.stop();
  else if (field === 'browserId')
    h.binding = { ...h.binding, browserId: parseBrowserId('browser_subject_B_000000000000000') };
  else if (field === 'tabId')
    h.binding = { ...h.binding, tabId: parseTabId('canonical_tab_B_00000000000000000') };
  else h.binding = { ...h.binding, [field]: h.binding[field] + 1 };
}

describe('each cleanup IO target fence (trusted transport doubles only)', () => {
  it.each(
    changes.flatMap((field) => RELEASES.map((call, position) => ({ field, call, position })))
  )('stops remaining cleanup after $call changes $field', async ({ field, call, position }) => {
    const h = fixture();
    await held(h);
    h.transition = async (current) => {
      if (current === call) change(h, field);
    };
    expect((await h.input.reset()).status).toBe('stopped');
    expect(h.calls, 'STALE_CLEANUP_TAIL').toEqual(RELEASES.slice(0, position + 1));
    const before = [...h.calls];
    expect((await h.input.submit(h.command([{ kind: 'text', text: 'SUCCESSOR' }]))).outcome).toBe(
      'rejected'
    );
    expect((await h.input.reset()).status).toBe('stopped');
    expect(h.calls).toEqual(before);
  });
  it('observer-triggered stop refuses the next cleanup before native IO even with an unchanged returned snapshot', async () => {
    const h = fixture();
    await held(h);
    h.transition = async (call) => {
      if (call === RELEASES[0])
        h.ports.readBinding = () => {
          h.stopGate.stop();
          return h.binding;
        };
    };
    expect((await h.input.reset()).status).toBe('stopped');
    expect(h.calls, 'STOPPED_OBSERVER_CLEANUP_TAIL').toEqual([RELEASES[0]]);
    expect((await h.input.submit(h.command([{ kind: 'text', text: 'SUCCESSOR' }]))).outcome).toBe(
      'rejected'
    );
  });

  it('unchanged target starts every release/cancel and restores ready only after all settle', async () => {
    const h = fixture();
    await held(h);
    expect((await h.input.reset()).status).toBe('ready');
    expect(h.calls).toEqual(RELEASES);
    expect((await h.input.submit(h.command([{ kind: 'text', text: 'SUCCESSOR' }]))).outcome).toBe(
      'completed'
    );
    expect(h.calls.at(-1)).toBe('SUCCESSOR');
  });
  it.each(RELEASES)(
    'rejected %s still attempts every other valid-target cleanup then stops',
    async (rejected) => {
      const h = fixture();
      await held(h);
      h.transition = async (call) => {
        if (call === rejected) throw Error('INTENDED_RELEASE_REJECTION');
      };
      expect((await h.input.reset()).status).toBe('stopped');
      expect(h.calls).toEqual(RELEASES);
      expect((await h.input.submit(h.command([{ kind: 'text', text: 'SUCCESSOR' }]))).outcome).toBe(
        'rejected'
      );
    }
  );
  it('hung first valid-target release does not serialize remaining cleanup or restore readiness on late settlement', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const h = fixture();
      await held(h);
      let release!: () => void;
      const hang = new Promise<void>((resolve) => {
        release = resolve;
      });
      h.transition = (call) => (call === RELEASES[0] ? hang : Promise.resolve());
      const resetting = h.input.reset();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(h.calls).toEqual(RELEASES);
      await vi.advanceTimersByTimeAsync(2000);
      expect((await resetting).status).toBe('stopped');
      release();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect((await h.input.reset()).status).toBe('stopped');
      expect((await h.input.submit(h.command([{ kind: 'text', text: 'SUCCESSOR' }]))).outcome).toBe(
        'rejected'
      );
      expect(h.calls).toEqual(RELEASES);
    } finally {
      vi.useRealTimers();
    }
  });
});
