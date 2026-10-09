import { expect, it, onTestFinished, vi } from 'vitest';
import {
  createSemanticInputIssuer,
  consumeSemanticInputWork,
  semanticInputCurrent,
  settleSemanticInputWork,
} from '../semantic-work.js';
import {
  createOwnedFixtureInput,
  settleFixtureRetirement,
  type FixtureInputPorts,
} from '../../__tests__/parent-fixture.js';
import { createBrowserStopGate } from '../../lifecycle/stop.js';
import { parseBrowserBinding } from '../../contracts.js';

const binding = parseBrowserBinding({
  browserId: 'browser_subject_A_000000000000000',
  browserGeneration: 0,
  tabId: 'canonical_tab_A_00000000000000000',
  navigationGeneration: 0,
  viewportVersion: 0,
  epoch: 0,
  inputGeneration: 0,
});
const request = () => ({
  requestId: 'semantic_request_fixture_001',
  identity: {
    version: 1,
    ...binding,
    treeId: 'semantic_tree_fixture_0001',
    treeRevision: 1,
    grantRevision: 1,
    semanticLeaseId: 'semantic_lease_fixture_001',
  },
  frameId: 'semantic_frame_fixture_001',
  frameNavigationGeneration: 0,
  nodeRef: 'semantic_node_fixture_0001',
  focusRevision: 1,
  action: { kind: 'focus' },
});

it('retains exact original callback failure and rejects replay of a consumed semantic Work', () => {
  const issuer = createSemanticInputIssuer(),
    owner = {},
    token = issuer.issue(binding, request(), {
      current: () => {
        throw undefined;
      },
      execute: async () => {},
    });
  onTestFinished(() => issuer.invalidate(token));
  consumeSemanticInputWork(token, owner);
  let rejection: { value: unknown } | undefined;
  try {
    semanticInputCurrent(token, owner);
  } catch (value) {
    rejection = { value };
  }
  expect(rejection).toEqual({ value: undefined });
  expect(() => consumeSemanticInputWork(token, {})).toThrow();
  settleSemanticInputWork(token, owner);
  expect(semanticInputCurrent(token, owner)).toBe(false);
});

it('joins held semantic native work in the original tab queue before the next ordinary input enters', async () => {
  const bank: {
    input?: ReturnType<typeof createOwnedFixtureInput>;
    original?: Promise<unknown>;
    following?: Promise<unknown>;
    release?: () => void;
  } = {};
  const issuer = createSemanticInputIssuer();
  onTestFinished(async () => {
    bank.release?.();
    if (bank.original) await bank.original;
    if (bank.following) await bank.following;
    if (bank.input) {
      bank.input.stop();
      await settleFixtureRetirement(bank.input);
    }
  });
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
  const input = (bank.input = createOwnedFixtureInput(ports, () => binding));
  const held = new Promise<void>((resolve) => {
    bank.release = resolve;
  });
  const entered = vi.fn();
  const token = issuer.issue(binding, request(), {
    current: () => true,
    execute: async (_signal, check, dispatch) => {
      entered();
      await held;
      check();
      await dispatch({ kind: 'text', text: 'semantic' });
    },
  });
  const original = (bank.original = input.submitSemantic(token));
  const following = (bank.following = input.submit({
    kind: 'input',
    requestId: 'following_input_fixture_0001',
    binding,
    steps: [{ kind: 'text', text: 'following' }],
  }));
  for (let index = 0; index < 16; index++) await Promise.resolve();
  expect(entered).toHaveBeenCalledTimes(1);
  expect(calls).toEqual([]);
  bank.release!();
  expect(await original).toMatchObject({ outcome: 'completed' });
  expect(await following).toMatchObject({ outcome: 'completed' });
  expect(calls).toEqual(['text', 'text']);
});

it('refuses a different original generation before entering the semantic operation', async () => {
  const bank: { input?: ReturnType<typeof createOwnedFixtureInput> } = {};
  onTestFinished(async () => {
    if (bank.input) {
      bank.input.stop();
      await settleFixtureRetirement(bank.input);
    }
  });
  const successor = { ...binding, inputGeneration: 1 };
  const native = vi.fn();
  const ports: FixtureInputPorts = {
    readBinding: () => successor,
    publishResetBinding: () => {},
    authorize: async () => 'allowed',
    stopGate: createBrowserStopGate(binding.browserId, 0),
    native: {
      dispatch: async () => {},
      cancelComposition: async () => {},
      cancelDrag: async () => {},
    },
  };
  const input = (bank.input = createOwnedFixtureInput(ports, () => successor));
  const issuer = createSemanticInputIssuer(),
    token = issuer.issue(binding, request(), {
      current: () => true,
      execute: async () => {
        native();
      },
    });
  onTestFinished(() => issuer.invalidate(token));
  expect(await input.submitSemantic(token)).toMatchObject({
    outcome: 'rejected',
  });
  expect(native).not.toHaveBeenCalled();
});
