import {
  createOwnedFixtureCohort,
  settleFixtureRetirement,
  type FixtureInputPorts,
} from '../../__tests__/parent-fixture.js';
import { describe, expect, it, vi } from 'vitest';
import { parseBrowserResult, type BrowserBinding } from '../../contracts.js';
import { parseBrowserId, parseTabId } from '../../ids.js';
import { createBrowserStopGate } from '../../lifecycle/stop.js';
import type { NativeInputStep } from '../index.js';

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
function harness(withSibling = false) {
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
  const ports: FixtureInputPorts = {
    readBinding: () => binding,
    publishResetBinding: (next) => {
      binding = next;
    },
    authorize: vi.fn(async () => 'allowed' as const),
    native,
    stopGate,
  };
  let siblingBinding = { ...binding, tabId: parseTabId('canonical_tab_B_00000000000000000') };
  const siblingPorts: FixtureInputPorts = {
    ...ports,
    native: {
      dispatch: vi.fn(async () => {}),
      cancelComposition: vi.fn(async () => {}),
      cancelDrag: vi.fn(async () => {}),
    },
    readBinding: () => siblingBinding,
    publishResetBinding: (next) => {
      siblingBinding = next;
    },
  };
  const members = [{ ports, readCanonicalBinding: () => binding }];
  if (withSibling)
    members.push({ ports: siblingPorts, readCanonicalBinding: () => siblingBinding });
  const cohort = createOwnedFixtureCohort(members);
  const input = cohort[0].input;
  return {
    input,
    sibling: withSibling ? cohort[1].input : undefined,
    get siblingBinding() {
      return siblingBinding;
    },
    owned: cohort[0],
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

describe('trusted native input leaf (transport doubles, not native IME observations)', () => {
  it('expands click and dispatches exact canonical ordered native actions without setters', async () => {
    const h = harness();
    const result = await h.input.submit(
      h.command([{ kind: 'click', x: 20, y: 30, button: 'left' }])
    );
    expect(result.outcome).toBe('completed');
    expect(parseBrowserResult(result)).toEqual(result);
    expect(h.calls).toEqual([
      { kind: 'mouseMove', x: 20, y: 30 },
      { kind: 'mouseDown', button: 'left' },
      { kind: 'mouseUp', button: 'left' },
    ]);
    expect(h.ports.authorize).toHaveBeenCalledTimes(6);
  });

  it.each([
    'browserId',
    'browserGeneration',
    'tabId',
    'navigationGeneration',
    'viewportVersion',
    'epoch',
    'inputGeneration',
  ] as const)('refuses exact wrong %s before any authority/native call', async (field) => {
    const h = harness();
    const command = h.command();
    if (field === 'browserId')
      command.binding.browserId = parseBrowserId('browser_subject_B_000000000000000');
    else if (field === 'tabId')
      command.binding.tabId = parseTabId('canonical_tab_B_00000000000000000');
    else command.binding[field]++;
    const result = await h.input.submit(command);
    expect(result.outcome).toBe('rejected');
    expect(h.calls).toEqual([]);
    expect(h.ports.authorize).not.toHaveBeenCalled();
  });

  it('rechecks binding after authority wait and does not dispatch onto replacement navigation', async () => {
    const h = harness();
    const authority = deferred<'allowed'>();
    h.ports.authorize = () => authority.promise;
    const result = h.input.submit(h.command());
    h.binding = { ...h.binding, navigationGeneration: 1 };
    authority.resolve('allowed');
    expect(await result).toMatchObject({ outcome: 'rejected', reason: 'staleBinding' });
    expect(h.calls).toEqual([]);
  });

  it('checks per-step authority, refuses revoked text after first successful step', async () => {
    const h = harness();
    let count = 0;
    h.ports.authorize = async () => (++count === 1 ? 'allowed' : 'refused');
    const result = await h.input.submit(
      h.command([
        { kind: 'keyDown', key: 'Shift' },
        { kind: 'text', text: 'SECRET_NOT_SENT' },
      ])
    );
    expect(result).toMatchObject({ outcome: 'aborted', reason: 'policyRefused' });
    expect(h.calls[0]).toEqual({ kind: 'keyDown', key: 'Shift' });
    await tick();
    expect(h.calls).toEqual([
      { kind: 'keyDown', key: 'Shift' },
      { kind: 'keyUp', key: 'Shift' },
    ]);
  });

  it.each(['refused', 'unknown'] as const)('never dispatches %s authority', async (answer) => {
    const h = harness();
    h.ports.authorize = async () => answer;
    expect(await h.input.submit(h.command())).toMatchObject({
      outcome: 'rejected',
      reason: 'policyRefused',
    });
    expect(h.calls).toEqual([]);
  });

  it('refuses 17 expanded native steps and 2049 UTF8 bytes while exact bounds dispatch', async () => {
    const h = harness();
    expect(
      await h.input.submit(
        h.command(
          Array.from({ length: 17 }, () => ({ kind: 'keyUp' as const, key: 'Shift' as const }))
        )
      )
    ).toMatchObject({ outcome: 'rejected' });
    expect(
      await h.input.submit(h.command([{ kind: 'text', text: '🙂'.repeat(512) + 'x' }]))
    ).toMatchObject({ outcome: 'rejected' });
    expect(h.calls).toEqual([]);
    expect(
      (
        await h.input.submit(
          h.command(
            Array.from({ length: 16 }, () => ({ kind: 'keyUp' as const, key: 'Shift' as const }))
          )
        )
      ).outcome
    ).toBe('completed');
    expect(
      (await h.input.submit(h.command([{ kind: 'text', text: '🙂'.repeat(512) }]))).outcome
    ).toBe('completed');
    expect(h.calls).toHaveLength(17);
  });

  it('invalidates queued release and refuses old native ACK authority after reset generation advance', async () => {
    const h = harness();
    await h.input.submit(
      h.command([
        { kind: 'keyDown', key: 'Shift' },
        { kind: 'mouseDown', button: 'left' },
      ])
    );
    const held = deferred();
    h.native.dispatch.mockImplementationOnce(() => held.promise);
    const active = h.input.submit(h.command());
    await tick();
    const queued = h.input.submit(
      h.command([
        { kind: 'keyUp', key: 'Shift' },
        { kind: 'mouseUp', button: 'left' },
      ])
    );
    const old = { ...h.binding };
    const reset = h.input.reset();
    expect(h.binding.epoch).toBe(old.epoch + 1);
    expect(h.binding.inputGeneration).toBe(old.inputGeneration + 1);
    expect(await queued).toMatchObject({ outcome: 'rejected', reason: 'staleBinding' });
    expect((await h.input.submit(h.command())).outcome).toBe('rejected');
    held.resolve();
    expect((await active).outcome).toBe('uncertain');
    expect(await reset).toMatchObject({ status: 'stopped' });
    expect(h.calls.slice(-2)).toEqual([
      { kind: 'mouseUp', button: 'left' },
      { kind: 'keyUp', key: 'Shift' },
    ]);
    expect(h.native.cancelComposition).toHaveBeenCalledTimes(1);
    expect(h.native.cancelDrag).toHaveBeenCalledTimes(1);
    expect((await h.input.submit(h.command([{ kind: 'text', text: 'SUCCESSOR' }]))).outcome).toBe(
      'rejected'
    );
    expect((await h.input.submit({ ...h.command(), binding: old })).outcome).toBe('rejected');
    await settleFixtureRetirement(h.input);
    expect(h.stopGate.stopped).toBe(true);
    expect(h.owned.slot.uncertain).toBe(true);
  });

  it('attempts every held release and both cancellation ports despite one failure, stops all sibling tabs', async () => {
    const h = harness(true);
    await h.input.submit(
      h.command([
        { kind: 'keyDown', key: 'Shift' },
        { kind: 'keyDown', key: 'Control' },
        { kind: 'mouseDown', button: 'left' },
      ])
    );
    const siblingBinding = h.siblingBinding;
    const sibling = h.sibling!;
    h.native.dispatch.mockRejectedValueOnce(new Error('private release failure'));
    expect(await h.input.reset()).toMatchObject({ status: 'stopped' });
    expect(h.native.dispatch).toHaveBeenCalledTimes(6);
    expect(h.native.cancelComposition).toHaveBeenCalledTimes(1);
    expect(h.native.cancelDrag).toHaveBeenCalledTimes(1);
    expect(await sibling.submit({ ...h.command(), binding: siblingBinding })).toMatchObject({
      outcome: 'rejected',
      reason: 'stopped',
    });
    expect(h.owned.record.lifetime.ordinary.phase).not.toBe('ordinary');
    await settleFixtureRetirement(h.input);
    expect(h.stopGate.accepts(siblingBinding)).toBe(false);
  });

  it('cancelled queued work has zero native effects and no replay', async () => {
    const h = harness();
    const held = deferred();
    h.native.dispatch.mockImplementationOnce(() => held.promise);
    const first = h.input.submit(h.command());
    await tick();
    const cancel = new AbortController();
    const queued = h.input.submit(h.command(), cancel.signal);
    cancel.abort();
    held.resolve();
    await first;
    expect((await queued).outcome).toBe('rejected');
    expect(h.native.dispatch).toHaveBeenCalledTimes(1);
  });

  it('revocation after the final native acknowledgement refuses completed receipt authority', async () => {
    const h = harness();
    let checks = 0;
    h.ports.authorize = async () => (++checks === 1 ? 'allowed' : 'refused');
    expect(await h.input.submit(h.command())).toMatchObject({
      outcome: 'aborted',
      reason: 'policyRefused',
    });
    expect(h.calls).toEqual([{ kind: 'text', text: 'CANONICAL-A' }]);
    await tick();
    expect(h.binding.epoch).toBe(1);
  });

  it('counter exhaustion fails closed without wrapping or dispatch', async () => {
    const h = harness();
    h.binding = { ...h.binding, epoch: Number.MAX_SAFE_INTEGER };
    expect((await h.input.reset()).status).toBe('stopped');
    expect(h.binding.epoch).toBe(Number.MAX_SAFE_INTEGER);
    expect(h.native.dispatch).not.toHaveBeenCalled();
    expect(h.owned.record.lifetime.ordinary.phase).not.toBe('ordinary');
    expect((await h.input.submit(h.command())).outcome).toBe('rejected');
    await settleFixtureRetirement(h.input);
    expect(h.stopGate.stopped).toBe(true);
  });

  it('browser stop rejects unseen late Page registration and tombstones all known tabs despite callback throw', () => {
    const h = harness();
    const healthy = vi.fn();
    h.stopGate.register(h.binding, () => {
      throw new Error('consumer failure');
    });
    h.stopGate.register(h.binding, healthy);
    h.stopGate.stop();
    h.stopGate.stop();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(
      h.stopGate.register(
        { ...h.binding, tabId: parseTabId('late_page_00000000000000000000000') },
        vi.fn()
      )
    ).toBeNull();
    expect(h.stopGate.accepts(h.binding)).toBe(false);
  });

  it('registry observation failure after dispatch stops browser and never hangs the result', async () => {
    const h = harness();
    h.native.dispatch.mockImplementationOnce(async () => {
      h.ports.readBinding = () => {
        throw new Error('SECRET_OBSERVER');
      };
    });
    const result = await h.input.submit(h.command());
    expect(result).toMatchObject({ outcome: 'uncertain', reason: 'dispatchFailed' });
    expect(h.owned.slot.uncertain).toBe(true);
    expect(h.native.dispatch).toHaveBeenCalledTimes(1);
    expect((await h.input.submit(h.command())).outcome).toBe('rejected');
    expect(h.native.dispatch).toHaveBeenCalledTimes(1);
    await settleFixtureRetirement(h.input);
    expect(h.stopGate.stopped).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('explicit stop uses the browser gate and stops a sibling plus unseen tab admission', async () => {
    const h = harness(true);
    const siblingBinding = h.siblingBinding;
    const sibling = h.sibling!;
    const cancellation = deferred<void>();
    h.native.cancelComposition.mockImplementation(() => cancellation.promise);
    h.input.stop();
    expect(h.owned.record.lifetime.ordinary.phase).toBe('retiring');
    expect((await h.input.submit(h.command())).outcome).toBe('rejected');
    expect((await sibling.submit({ ...h.command(), binding: siblingBinding })).outcome).toBe(
      'rejected'
    );
    expect(h.native.cancelComposition).toHaveBeenCalledTimes(1);
    expect(h.stopGate.stopped).toBe(false);
    cancellation.resolve();
    await settleFixtureRetirement(h.input);
    expect(h.stopGate.stopped).toBe(true);
    expect(h.stopGate.register(siblingBinding, () => {})).toBeNull();
  });
});
