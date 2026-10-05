import { describe, expect, it, vi } from 'vitest';
import { type BrowserBinding } from '../../contracts.js';
import { parseBrowserId, parseTabId } from '../../ids.js';
import { createBrowserStopGate } from '../../lifecycle/stop.js';
import { type NativeInputStep } from '../index.js';
import {
  createOwnedFixtureInput as createTabInput,
  settleFixtureRetirement,
  type FixtureInputPorts as InputPorts,
} from '../../__tests__/parent-fixture.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function harness() {
  let binding: BrowserBinding = {
    browserId: parseBrowserId('browser_subject_A_000000000000000'),
    browserGeneration: 0,
    tabId: parseTabId('canonical_tab_A_00000000000000000'),
    navigationGeneration: 0,
    viewportVersion: 0,
    epoch: 0,
    inputGeneration: 0,
  };
  const calls: NativeInputStep[] = [];
  const stopGate = createBrowserStopGate(binding.browserId, binding.browserGeneration);
  const native = {
    dispatch: vi.fn(async (step: NativeInputStep) => {
      calls.push({ ...step });
    }),
    cancelComposition: vi.fn(async () => {}),
    cancelDrag: vi.fn(async () => {}),
  };
  const ports: InputPorts = {
    readBinding: () => binding,
    publishResetBinding: (next) => {
      binding = next;
    },
    authorize: vi.fn(async () => 'allowed' as const),
    native,
    stopGate,
  };
  const input = createTabInput(ports, () => binding);
  return {
    input,
    ports,
    native,
    calls,
    stopGate,
    get binding() {
      return binding;
    },
    set binding(next: BrowserBinding) {
      binding = next;
    },
    command: (
      steps: NativeInputStep[] | { kind: 'click'; x: number; y: number; button: 'left' }[] = [
        { kind: 'text', text: 'CANONICAL-A' },
      ]
    ) => ({
      kind: 'input',
      requestId: 'request_subject_A_00000000000000',
      binding: { ...binding },
      steps,
    }),
  };
}

describe('reset drain target guard (transport doubles only)', () => {
  it.each([
    'same',
    'tab',
    'browserGeneration',
    'browserId',
    'missing',
    'observerFailure',
    'stopped',
  ] as const)('reset native release %s after pending-drain await', async (kind) => {
    const h = harness();
    expect((await h.input.submit(h.command([{ kind: 'keyDown', key: 'Shift' }]))).outcome).toBe(
      'completed'
    );
    const blocked = deferred();
    h.native.dispatch.mockImplementationOnce(() => blocked.promise);
    const active = h.input.submit(h.command([{ kind: 'mouseMove', x: 1, y: 1 }]));
    await tick();
    const reset = h.input.reset();
    await tick();
    if (kind === 'tab')
      h.binding = { ...h.binding, tabId: parseTabId('canonical_tab_B_00000000000000000') };
    if (kind === 'browserGeneration') h.binding = { ...h.binding, browserGeneration: 1 };
    if (kind === 'browserId')
      h.binding = { ...h.binding, browserId: parseBrowserId('browser_subject_B_000000000000000') };
    if (kind === 'missing') h.ports.readBinding = () => null;
    if (kind === 'observerFailure')
      h.ports.readBinding = () => {
        throw new Error('PRIVATE_OBSERVER');
      };
    if (kind === 'stopped') h.stopGate.stop();
    blocked.resolve();
    await active;
    const result = await reset;
    if (kind === 'same') {
      // Strict production transport rejects the old ordinary ACK after reset
      // publishes its new seven-field binding, despite unchanged Page/session.
      expect(result.status).toBe('stopped');
      await settleFixtureRetirement(h.input);
      expect(h.stopGate.stopped).toBe(true);
      expect(h.calls).toEqual([
        { kind: 'keyDown', key: 'Shift' },
        { kind: 'keyUp', key: 'Shift' },
      ]);
      expect(h.native.cancelComposition).toHaveBeenCalledTimes(1);
    } else {
      expect(result.status).toBe('stopped');
      await settleFixtureRetirement(h.input);
      expect(h.stopGate.stopped).toBe(true);
      expect(h.calls, 'STALE_RESET_RELEASE_AFTER_DRAIN').toEqual([
        { kind: 'keyDown', key: 'Shift' },
      ]);
      expect(h.native.cancelComposition).not.toHaveBeenCalled();
      expect(h.native.cancelDrag).not.toHaveBeenCalled();
      expect((await h.input.submit(h.command())).outcome).toBe('rejected');
      await tick();
      expect(h.native.dispatch).toHaveBeenCalledTimes(2);
    }
  });
});

// Decisive strict-current positive: the held key has ALREADY acknowledged under
// its original binding before reset enters; release captures the new binding.
it('idle reset still allows acknowledged current cleanup and successor admission', async () => {
  const h = harness();
  expect((await h.input.submit(h.command([{ kind: 'keyDown', key: 'Shift' }]))).outcome).toBe(
    'completed'
  );
  expect((await h.input.reset()).status).toBe('ready');
  expect(h.calls).toEqual([
    { kind: 'keyDown', key: 'Shift' },
    { kind: 'keyUp', key: 'Shift' },
  ]);
  expect(h.stopGate.stopped).toBe(false);
  expect((await h.input.submit(h.command())).outcome).toBe('completed');
});
