import { ChildProcess } from 'node:child_process';
import { it, expect } from 'vitest';
import { createPrivateNativeAcceptance } from '../private-native-acceptance.js';
import type { ProcessObserver } from '@dorkos/browser';

// Controlled native-observer faults test retention; these never constitute resource/native acceptance.
it('retains every returned cohort birth before a later falsy liveness failure and cannot heal it', async () => {
  const manager = { pid: 41, birth: 'unit-manager' },
    frontend = { pid: 42, birth: 'unit-frontend' };
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: frontend.pid });
  let failed = true;
  const processes: ProcessObserver = {
    descendants: async () => ({
      status: 'complete',
      identities: [manager, frontend],
    }),
    observe: async (identity) => {
      if (failed && identity.pid === frontend.pid) throw false;
      return { status: 'alive' };
    },
  };
  const bank = createPrivateNativeAcceptance({
    manager,
    processes,
    current: () => {},
    own: (original) => original,
  });
  await expect(bank.captureFrontend(child)).rejects.toBe(false);
  expect(bank.originalKnownBirths()).toEqual([manager, frontend]);
  expect(bank.originalFrontend()).toBe(child);
  failed = false;
  expect(() => bank.assertCurrent()).toThrow();
  try {
    bank.assertCurrent();
  } catch (value) {
    expect(value).toBe(false);
  }
  await expect(bank.captureFrontend(child)).rejects.toBe(false);
});
it('keeps an unknown complete-tree query failure primary over later query recovery', async () => {
  const manager = { pid: 41, birth: 'unit-manager' };
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 42 });
  let unknown = true;
  const processes: ProcessObserver = {
    descendants: async () => ({
      status: unknown ? 'unknown' : 'complete',
      identities: [manager],
    }),
    observe: async () => ({ status: 'alive' }),
  };
  const bank = createPrivateNativeAcceptance({
    manager,
    processes,
    current: () => {},
    own: (original) => original,
  });
  await expect(bank.captureFrontend(child)).rejects.toThrow(
    'PRIVATE_ACCEPTANCE_COMPLETE_ORIGINAL_TREE_REQUIRED'
  );
  expect(bank.originalKnownBirths()).toEqual([manager]);
  unknown = false;
  await expect(bank.captureFrontend(child)).rejects.toThrow(
    'PRIVATE_ACCEPTANCE_COMPLETE_ORIGINAL_TREE_REQUIRED'
  );
});
