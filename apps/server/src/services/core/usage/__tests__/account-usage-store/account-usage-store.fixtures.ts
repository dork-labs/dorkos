import { beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LedgerObservation } from '@dorkos/shared/account-usage';
import { resetAccountSignins } from '../../../../observability/account-signin-state.js';
import { AccountUsageStore } from '../../account-usage-store.js';
import { type AccountUsageStoreOptions } from '../../account-usage-types.js';
import { readConfigFile } from '../../account-usage-reconcile.js';
import { ledgerDir } from '../../ledger-file.js';
import { defaultAccountFolder } from '../../runtime-accounts.js';

/**
 * The current test's folders, stores and clock, reset before every test by
 * {@link useUsageStoreSandbox}.
 *
 * The store's clock follows the wall clock, because the prune guard compares it
 * with real file mtimes; tests move it forward from there.
 */
export const usage = {
  root: '',
  dorkHome: '',
  home: '',
  stores: [] as AccountUsageStore[],
  clock: Date.now(),
};

export function obs(key: string, usedPct: number, atMs = usage.clock): LedgerObservation {
  return { key, usedPct, observedAt: new Date(atMs).toISOString(), source: 'sdk_event' };
}

export async function writeConfig(config: unknown): Promise<void> {
  await fs.writeFile(path.join(usage.dorkHome, 'config.json'), JSON.stringify(config));
}

export function claudeConfig(accounts: unknown[], defaultAccount: string | null = null) {
  return { runtimes: { claudeCode: { defaultAccount, accounts } } };
}

export function makeStore(overrides: Partial<AccountUsageStoreOptions> = {}): AccountUsageStore {
  const store = new AccountUsageStore({
    dorkHome: usage.dorkHome,
    readConfig: () => readConfigFile(path.join(usage.dorkHome, 'config.json')),
    resolveDefaultRoot: (runtime, config) => defaultAccountFolder(runtime, config, usage.home),
    now: () => new Date(usage.clock),
    lockOptions: { giveUpMs: 200 },
    timings: { scanIntervalMs: 3_600_000 },
    ...overrides,
  });
  usage.stores.push(store);
  return store;
}

export const claudeDir = () => ledgerDir(usage.dorkHome, 'claude-code');

/** Make every ledger file look older than the 60 s prune guard (real mtimes). */
export async function ageLedgers(): Promise<void> {
  const old = new Date(Date.now() - 120_000);
  for (const name of await fs.readdir(claudeDir())) {
    await fs.utimes(path.join(claudeDir(), name), old, old);
  }
}

/** Fresh folders and an empty sign-in registry per test; every store stopped after. */
export function useUsageStoreSandbox(): void {
  beforeEach(async () => {
    usage.root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'usage-store-')));
    usage.dorkHome = path.join(usage.root, 'dork');
    usage.home = path.join(usage.root, 'home');
    await fs.mkdir(usage.dorkHome, { recursive: true });
    await fs.mkdir(path.join(usage.home, '.claude'), { recursive: true });
    await fs.mkdir(path.join(usage.home, '.claude3'), { recursive: true });
    usage.stores = [];
    usage.clock = Date.now();
    resetAccountSignins();
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const store of usage.stores) {
      store.stop();
      await store.flush();
    }
    vi.restoreAllMocks();
    await fs.rm(usage.root, { recursive: true, force: true });
  });
}
