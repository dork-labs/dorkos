import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOwnedInputIssuer,
  consumeOwnedInputWork,
  authorizeOwnedInputWork,
  ownedInputWorkCurrent,
  settleOwnedInputWork,
  type OwnedInputWork,
} from '../owned-work.js';
import {
  createOwnedFixtureInput,
  settleFixtureRetirement,
  type FixtureInputPorts,
} from '../../__tests__/parent-fixture.js';
import { createBrowserStopGate } from '../../lifecycle/stop.js';
import { parseBrowserCommand, type BrowserBinding } from '../../contracts.js';
import { parseBrowserId, parseTabId } from '../../ids.js';
import type { TabInput } from '../types.js';

const binding: BrowserBinding = {
  browserId: parseBrowserId('browser_subject_A_000000000000000'),
  browserGeneration: 0,
  tabId: parseTabId('canonical_tab_A_00000000000000000'),
  navigationGeneration: 0,
  viewportVersion: 0,
  epoch: 0,
  inputGeneration: 0,
};
const command = () => ({
  kind: 'input',
  requestId: 'request_subject_A_00000000000000',
  binding: { ...binding },
  steps: [{ kind: 'text', text: 'FIXTURE' }],
});
const inputs: TabInput[] = [];
afterEach(async () => {
  let failed = false,
    first: unknown;
  for (const input of inputs.splice(0)) {
    try {
      input.stop();
      await settleFixtureRetirement(input);
    } catch (error) {
      if (!failed) {
        failed = true;
        first = error;
      }
    }
  }
  if (failed) throw first;
});
function fixture() {
  const calls: string[] = [];
  const ports: FixtureInputPorts = {
    readBinding: () => binding,
    publishResetBinding: () => {},
    authorize: async () => 'allowed',
    stopGate: createBrowserStopGate(binding.browserId, 0),
    native: {
      dispatch: async (step) => {
        calls.push(step.kind);
      },
      cancelComposition: async () => {},
      cancelDrag: async () => {},
    },
  };
  const input = createOwnedFixtureInput(ports, () => binding);
  inputs.push(input);
  const issuer = createOwnedInputIssuer();
  let current = true;
  const authorize = vi.fn(async () => 'allowed' as const);
  const issue = (value = command()) => issuer.issue(value, { authorize, isCurrent: () => current });
  return {
    input,
    ports,
    calls,
    issuer,
    authorize,
    issue,
    revoke: () => {
      current = false;
    },
  };
}

describe('engine-issued private original Work identities', () => {
  it('consumes exactly once and binds authorization to the original Work object', async () => {
    const f = fixture(),
      token = f.issue(),
      original = {},
      foreign = {};
    const parsed = parseBrowserCommand(command());
    if (parsed.kind !== 'input') throw new Error('fixture command');
    expect(consumeOwnedInputWork(token, parsed, original)).toBe(true);
    expect(consumeOwnedInputWork(token, parsed, foreign)).toBe(false);
    expect(
      await authorizeOwnedInputWork(
        token,
        foreign,
        binding,
        { kind: 'text', text: 'FIXTURE' },
        new AbortController().signal
      )
    ).toBe('refused');
    expect(f.authorize).not.toHaveBeenCalled();
    expect(
      await authorizeOwnedInputWork(
        token,
        original,
        binding,
        { kind: 'text', text: 'FIXTURE' },
        new AbortController().signal
      )
    ).toBe('allowed');
    settleOwnedInputWork(token, foreign);
    expect(ownedInputWorkCurrent(token, original)).toBe(true);
    settleOwnedInputWork(token, original);
    expect(ownedInputWorkCurrent(token, original)).toBe(false);
  });
  it('accepts an original issued work through the actual queue and invalidates it after settlement', async () => {
    const f = fixture(),
      token = f.issue();
    expect((await f.input.submit(command(), undefined, token)).outcome).toBe('completed');
    expect(f.calls).toEqual(['text']);
    expect(f.authorize).toHaveBeenCalledTimes(2);
    const replay = await f.input.submit(command(), undefined, token);
    expect(replay).toMatchObject({ outcome: 'rejected', reason: 'policyRefused' });
    expect(f.calls).toEqual(['text']);
  });
  it('refuses a forged token before native effects or grant callbacks', async () => {
    const f = fixture();
    expect(await f.input.submit(command(), undefined, {} as OwnedInputWork)).toMatchObject({
      outcome: 'rejected',
      reason: 'policyRefused',
    });
    expect(f.calls).toEqual([]);
    expect(f.authorize).not.toHaveBeenCalled();
  });
  it('does not attach an issued token to a changed original command despite identical binding', async () => {
    const f = fixture(),
      token = f.issue();
    expect(
      await f.input.submit(
        { ...command(), requestId: 'other_request_A_000000000000000' },
        undefined,
        token
      )
    ).toMatchObject({ outcome: 'rejected', reason: 'policyRefused' });
    expect(f.calls).toEqual([]);
    expect((await f.input.submit(command(), undefined, token)).outcome).toBe('completed');
  });
  it('refuses reentrant revocation after ordinary policy resolution and before an unstarted native step', async () => {
    const f = fixture(),
      token = f.issue();
    f.ports.authorize = async () => {
      f.revoke();
      return 'allowed';
    };
    expect(await f.input.submit(command(), undefined, token)).toMatchObject({
      outcome: 'rejected',
      reason: 'policyRefused',
    });
    expect(f.calls).toEqual([]);
  });
  it('refuses the second composite atomic effect after revocation during the first', async () => {
    const f = fixture();
    const value = {
      ...command(),
      steps: [
        { kind: 'text', text: 'FIRST' },
        { kind: 'text', text: 'SECOND' },
      ],
    };
    const token = f.issue(value);
    f.ports.native.dispatch = async (step) => {
      f.calls.push(step.kind);
      f.revoke();
    };
    expect(await f.input.submit(value, undefined, token)).toMatchObject({
      outcome: 'aborted',
      reason: 'policyRefused',
    });
    expect(f.calls).toEqual(['text']);
  });
  it('invalidates pending issued work without granting native cancellation or cleanup authority', async () => {
    const f = fixture(),
      token = f.issue();
    f.issuer.invalidate(token);
    expect(await f.input.submit(command(), undefined, token)).toMatchObject({
      outcome: 'rejected',
      reason: 'policyRefused',
    });
    expect(f.calls).toEqual([]);
  });
});
