import { describe, expect, it, vi } from 'vitest';
import type { BrowserBinding } from '../../contracts.js';
import { parseBrowserId, parseTabId } from '../../ids.js';
import { createBrowserStopGate } from '../../lifecycle/stop.js';
import { type NativeInputStep } from '../index.js';
import {
  createOwnedFixtureInput as createTabInput,
  settleFixtureRetirement,
  type FixtureInputPorts as InputPorts,
} from '../../__tests__/parent-fixture.js';

type Step = NativeInputStep | { kind: 'click'; x: number; y: number; button: 'left' };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function tick() {
  for (let i = 0; i < 24; i++) await Promise.resolve();
}
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
  const keys = new Set<string>();
  const buttons = new Set<string>();
  const effects: { text: string; keys: string[]; buttons: string[] }[] = [];
  const calls: NativeInputStep[] = [];
  const native = {
    dispatch: vi.fn(async (step: NativeInputStep) => {
      calls.push(step);
      if (step.kind === 'keyDown') keys.add(step.key);
      if (step.kind === 'keyUp') keys.delete(step.key);
      if (step.kind === 'mouseDown') buttons.add(step.button);
      if (step.kind === 'mouseUp') buttons.delete(step.button);
      if (step.kind === 'text')
        effects.push({ text: step.text, keys: [...keys], buttons: [...buttons] });
    }),
    cancelComposition: vi.fn(async () => {}),
    cancelDrag: vi.fn(async () => {}),
  };
  const stopGate = createBrowserStopGate(binding.browserId, binding.browserGeneration);
  const ports: InputPorts = {
    readBinding: () => binding,
    publishResetBinding: (next) => {
      binding = next;
    },
    authorize: async () => 'allowed',
    native,
    stopGate,
  };
  const input = createTabInput(ports, () => binding);
  const command = (steps: Step[]) => ({
    kind: 'input',
    requestId: 'request_subject_A_00000000000000',
    binding: { ...binding },
    steps,
  });
  return {
    input,
    native,
    ports,
    stopGate,
    calls,
    effects,
    keys,
    buttons,
    command,
    get binding() {
      return binding;
    },
    set binding(next: BrowserBinding) {
      binding = next;
    },
  };
}
async function blockedMove(h: ReturnType<typeof fixture>) {
  const blocked = deferred();
  h.native.dispatch.mockImplementationOnce(() => blocked.promise);
  const active = h.input.submit(h.command([{ kind: 'mouseMove', x: 1, y: 1 }]));
  await tick();
  return { active, blocked };
}

describe('cancelled queued releases (modeled native state, not physical input)', () => {
  it.each([
    ['keyUp', { kind: 'keyDown', key: 'Shift' }, { kind: 'keyUp', key: 'Shift' }],
    ['mouseUp', { kind: 'mouseDown', button: 'left' }, { kind: 'mouseUp', button: 'left' }],
    [
      'expanded click release',
      { kind: 'mouseDown', button: 'left' },
      { kind: 'click', x: 10, y: 20, button: 'left' },
    ],
  ] as const)(
    '%s cancellation resets prior held state before any successor effect',
    async (_name, down, release) => {
      const h = fixture();
      expect((await h.input.submit(h.command([down]))).outcome).toBe('completed');
      const { active, blocked } = await blockedMove(h);
      const cancel = new AbortController();
      const cancelled = h.input.submit(h.command([release]), cancel.signal);
      const successor = h.input.submit(h.command([{ kind: 'text', text: 'QUEUED_SUCCESSOR' }]));
      cancel.abort();
      blocked.resolve();
      await active;
      expect((await cancelled).outcome).toBe('rejected');
      const result = await successor;
      await tick();
      expect(h.effects).toEqual([]);
      expect(result.outcome).toBe('rejected');
      expect(h.keys.size).toBe(0);
      expect(h.buttons.size).toBe(0);
      expect(h.binding.epoch).toBe(1);
      expect(h.binding.inputGeneration).toBe(1);
      expect(h.native.cancelComposition).toHaveBeenCalledTimes(1);
      expect(h.native.cancelDrag).toHaveBeenCalledTimes(1);
      expect(
        (await h.input.submit(h.command([{ kind: 'text', text: 'FRESH_SUCCESSOR' }]))).outcome
      ).toBe('completed');
      expect(h.effects).toEqual([{ text: 'FRESH_SUCCESSOR', keys: [], buttons: [] }]);
      if (release.kind === 'click')
        expect(h.calls.filter((step) => step.kind === 'mouseMove')).toEqual([]);
    }
  );

  it('failed cancelled-release cleanup stops browser and refuses queued/fresh successors', async () => {
    const h = fixture();
    await h.input.submit(h.command([{ kind: 'keyDown', key: 'Shift' }]));
    const { active, blocked } = await blockedMove(h);
    const cancel = new AbortController();
    const release = h.input.submit(h.command([{ kind: 'keyUp', key: 'Shift' }]), cancel.signal);
    const successor = h.input.submit(h.command([{ kind: 'text', text: 'NEVER' }]));
    h.native.dispatch.mockRejectedValueOnce(new Error('PRIVATE_RELEASE_FAILURE'));
    cancel.abort();
    blocked.resolve();
    await active;
    expect((await release).outcome).toBe('rejected');
    const successorResult = await successor;
    expect(h.native.dispatch.mock.calls.filter(([step]) => step.kind === 'text')).toEqual([]);
    expect(successorResult.outcome).toBe('rejected');
    await tick();
    await settleFixtureRetirement(h.input);
    expect(h.stopGate.stopped).toBe(true);
    expect(h.effects).toEqual([]);
    expect(h.native.cancelComposition).toHaveBeenCalledTimes(1);
    expect(h.native.cancelDrag).toHaveBeenCalledTimes(1);
    expect(await h.input.submit(h.command([{ kind: 'text', text: 'FRESH_NEVER' }]))).toMatchObject({
      outcome: 'rejected',
      reason: 'stopped',
    });
    expect(h.keys.has('Shift')).toBe(true); // Uncertain release is retained, never called reset-ready.
  });

  it('normal cancelled nonrelease work does not clear an intentionally held chord', async () => {
    const h = fixture();
    await h.input.submit(h.command([{ kind: 'keyDown', key: 'Shift' }]));
    const { active, blocked } = await blockedMove(h);
    const cancel = new AbortController();
    const cancelled = h.input.submit(
      h.command([{ kind: 'text', text: 'CANCELLED' }]),
      cancel.signal
    );
    const successor = h.input.submit(h.command([{ kind: 'text', text: 'INTENDED_SHIFT' }]));
    cancel.abort();
    blocked.resolve();
    await active;
    expect((await cancelled).outcome).toBe('rejected');
    expect((await successor).outcome).toBe('completed');
    expect(h.effects).toEqual([{ text: 'INTENDED_SHIFT', keys: ['Shift'], buttons: [] }]);
    expect(h.native.cancelComposition).not.toHaveBeenCalled();
    expect(h.native.cancelDrag).not.toHaveBeenCalled();
    expect(h.binding.epoch).toBe(0);
    await h.input.reset();
  });

  it('cancelled release with no held state does not impose a needless barrier', async () => {
    const h = fixture();
    const { active, blocked } = await blockedMove(h);
    const cancel = new AbortController();
    const release = h.input.submit(h.command([{ kind: 'keyUp', key: 'Shift' }]), cancel.signal);
    const successor = h.input.submit(h.command([{ kind: 'text', text: 'UNMODIFIED' }]));
    cancel.abort();
    blocked.resolve();
    await active;
    expect((await release).outcome).toBe('rejected');
    expect((await successor).outcome).toBe('completed');
    expect(h.binding.epoch).toBe(0);
    expect(h.native.cancelComposition).not.toHaveBeenCalled();
    expect(h.effects).toEqual([{ text: 'UNMODIFIED', keys: [], buttons: [] }]);
  });

  it('replacement tab during blocked work refuses stale release effects on the new lifetime', async () => {
    const h = fixture();
    await h.input.submit(h.command([{ kind: 'keyDown', key: 'Shift' }]));
    const { active, blocked } = await blockedMove(h);
    const cancel = new AbortController();
    const release = h.input.submit(h.command([{ kind: 'keyUp', key: 'Shift' }]), cancel.signal);
    h.binding = { ...h.binding, tabId: parseTabId('canonical_tab_B_00000000000000000') };
    cancel.abort();
    blocked.resolve();
    await active;
    expect((await release).outcome).toBe('rejected');
    await tick();
    await settleFixtureRetirement(h.input);
    expect(h.stopGate.stopped).toBe(true);
    expect(h.calls).toEqual([{ kind: 'keyDown', key: 'Shift' }]);
    expect(h.native.cancelDrag).not.toHaveBeenCalled();
    expect(h.native.cancelComposition).not.toHaveBeenCalled();
  });
});
