import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AccountUsage, LedgerObservation } from '@dorkos/shared/account-usage';
import { AccountUsageStore } from '../account-usage-store.js';
import { flushRetryDelayMs, type AccountUsageStoreOptions } from '../account-usage-types.js';
import { CONFIG_UNREADABLE, readConfigFile } from '../account-usage-reconcile.js';
import { ledgerDir, readLedger, writeLedger } from '../ledger-file.js';
import { DEFAULT_ACCOUNT_LABEL, defaultAccountFolder } from '../runtime-accounts.js';
import { logger } from '../../../../lib/logger.js';

let root: string;
let dorkHome: string;
let home: string;
let stores: AccountUsageStore[];

// The store's clock follows the wall clock, because the prune guard compares it
// with real file mtimes; tests move it forward from there.
let clock = Date.now();

function obs(key: string, usedPct: number, atMs = clock): LedgerObservation {
  return { key, usedPct, observedAt: new Date(atMs).toISOString(), source: 'sdk_event' };
}

async function writeConfig(config: unknown): Promise<void> {
  await fs.writeFile(path.join(dorkHome, 'config.json'), JSON.stringify(config));
}

function claudeConfig(accounts: unknown[], defaultAccount: string | null = null) {
  return { runtimes: { claudeCode: { defaultAccount, accounts } } };
}

function makeStore(overrides: Partial<AccountUsageStoreOptions> = {}): AccountUsageStore {
  const store = new AccountUsageStore({
    dorkHome,
    readConfig: () => readConfigFile(path.join(dorkHome, 'config.json')),
    resolveDefaultRoot: (runtime, config) => defaultAccountFolder(runtime, config, home),
    now: () => new Date(clock),
    lockOptions: { giveUpMs: 200 },
    timings: { scanIntervalMs: 3_600_000 },
    ...overrides,
  });
  stores.push(store);
  return store;
}

const claudeDir = () => ledgerDir(dorkHome, 'claude-code');

/** Make every ledger file look older than the 60 s prune guard (real mtimes). */
async function ageLedgers(): Promise<void> {
  const old = new Date(Date.now() - 120_000);
  for (const name of await fs.readdir(claudeDir())) {
    await fs.utimes(path.join(claudeDir(), name), old, old);
  }
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'usage-store-')));
  dorkHome = path.join(root, 'dork');
  home = path.join(root, 'home');
  await fs.mkdir(dorkHome, { recursive: true });
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.mkdir(path.join(home, '.claude3'), { recursive: true });
  stores = [];
  clock = Date.now();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const store of stores) {
    store.stop();
    await store.flush();
  }
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('AccountUsageStore: recording and persistence', () => {
  it('two sessions (two spellings of one root) on one account update one record', async () => {
    await writeConfig(
      claudeConfig([{ id: 'work', path: path.join(home, '.claude3'), label: 'Work' }])
    );
    const store = makeStore();
    await store.load();
    store.record('claude-code', { path: path.join(home, '.claude3') }, [obs('five_hour', 10)]);
    store.record('claude-code', { path: `${path.join(home, '.claude3')}/` }, [
      obs('seven_day', 40),
    ]);
    const work = store.list('claude-code').filter((u) => u.accountId === 'work');
    expect(work).toHaveLength(1);
    expect(work[0]!.windows.map((w) => [w.key, w.usedPct])).toEqual([
      ['five_hour', 10],
      ['seven_day', 40],
    ]);
    await store.flush();
    const onDisk = await readLedger(claudeDir(), 'work');
    expect(Object.keys(onDisk!.windows).sort()).toEqual(['five_hour', 'seven_day']);
  });

  it('survives a restart: a new store over the same folder shows the same windows', async () => {
    await writeConfig(
      claudeConfig([{ id: 'work', path: path.join(home, '.claude3'), label: null }])
    );
    const first = makeStore();
    await first.load();
    first.record('claude-code', { accountId: 'work' }, [obs('five_hour', 55)], {
      subscriptionType: 'max',
    });
    await first.flush();
    first.stop();

    const second = makeStore();
    await second.load();
    const [work] = second.peek('claude-code', ['work']);
    expect(work!.windows.map((w) => [w.key, w.usedPct])).toEqual([['five_hour', 55]]);
    // subscriptionType is memory-only.
    expect(work!.subscriptionType).toBeNull();
  });

  it('keeps a reading flow wrote between two flushes', async () => {
    await writeConfig(
      claudeConfig([{ id: 'work', path: path.join(home, '.claude3'), label: null }])
    );
    const store = makeStore();
    await store.load();
    store.record('claude-code', { accountId: 'work' }, [obs('five_hour', 10)]);
    await store.flush();
    // flow's status line writes the weekly window.
    await writeLedger(
      claudeDir(),
      'work',
      [{ ...obs('seven_day', 70), source: 'statusline' }],
      new Date(clock)
    );
    clock += 1000;
    store.record('claude-code', { accountId: 'work' }, [obs('five_hour', 12)]);
    await store.flush();
    const onDisk = await readLedger(claudeDir(), 'work');
    expect(onDisk!.windows.seven_day?.usedPct).toBe(70);
    expect(onDisk!.windows.five_hour?.usedPct).toBe(12);
    // Memory picked it up too (the write returns the merged file).
    expect(store.peek('claude-code', ['work'])[0]!.windows.map((w) => w.key)).toEqual([
      'five_hour',
      'seven_day',
    ]);
  });

  it('an unregistered root has no file and a null accountId', async () => {
    await writeConfig(
      claudeConfig([{ id: 'work', path: path.join(home, '.claude3'), label: null }])
    );
    const store = makeStore();
    await store.load();
    store.record('claude-code', { path: '/somewhere/else' }, [obs('five_hour', 33)]);
    await store.flush();
    const other = store.list('claude-code').find((u) => u.path === '/somewhere/else');
    expect(other).toMatchObject({ accountId: null, label: null });
    expect(other!.windows[0]!.usedPct).toBe(33);
    await expect(fs.readdir(claudeDir())).rejects.toThrow();
  });

  it('a registered row whose legacy id fails the pattern is memory-only', async () => {
    await writeConfig(
      claudeConfig([{ id: 'Old_Acct', path: path.join(home, '.claude3'), label: null }])
    );
    const store = makeStore();
    await store.load();
    store.record('claude-code', { path: path.join(home, '.claude3') }, [obs('five_hour', 5)]);
    await store.flush();
    const row = store.list('claude-code').find((u) => u.path === path.join(home, '.claude3'));
    expect(row).toMatchObject({ accountId: null });
    expect(row!.windows[0]!.usedPct).toBe(5);
    await expect(fs.readdir(claudeDir())).rejects.toThrow();
  });

  it('peek answers from memory and never touches disk', async () => {
    await writeConfig(claudeConfig([]));
    const store = makeStore();
    await store.load();
    store.record('claude-code', { accountId: 'default' }, [obs('five_hour', 20)]);
    const readFile = vi.spyOn(fs, 'readFile');
    const readdir = vi.spyOn(fs, 'readdir');
    const stat = vi.spyOn(fs, 'stat');
    expect(store.peek('claude-code', ['default'])[0]!.windows[0]!.usedPct).toBe(20);
    store.list();
    expect(readFile).not.toHaveBeenCalled();
    expect(readdir).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });

  it('keeps readings in memory when the lock stays held, and writes them next time', async () => {
    await writeConfig(claudeConfig([]));
    const store = makeStore({ lockOptions: { giveUpMs: 20 } });
    await store.load();
    await fs.mkdir(claudeDir(), { recursive: true });
    await fs.writeFile(path.join(claudeDir(), 'default.json.lock'), '1:held');
    store.record('claude-code', { accountId: 'default' }, [obs('five_hour', 20)]);
    await store.flush();
    expect(await readLedger(claudeDir(), 'default')).toBeNull();
    expect(store.peek('claude-code', ['default'])[0]!.windows[0]!.usedPct).toBe(20);
    await fs.rm(path.join(claudeDir(), 'default.json.lock'));
    await store.flush();
    expect((await readLedger(claudeDir(), 'default'))!.windows.five_hour?.usedPct).toBe(20);
  });
});

describe('AccountUsageStore: account_usage emissions', () => {
  it('emits once per account per 2 s, trailing, and not for a new observedAt alone', async () => {
    await writeConfig(claudeConfig([]));
    const broadcast = vi.fn<(u: AccountUsage) => void>();
    const store = makeStore({ broadcast });
    await store.load();
    vi.useFakeTimers();

    store.record('claude-code', { accountId: 'default' }, [obs('five_hour', 10)]);
    store.record('claude-code', { accountId: 'default' }, [obs('five_hour', 11, clock + 1)]);
    store.record('claude-code', { accountId: 'default' }, [obs('five_hour', 12, clock + 2)]);
    expect(broadcast).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0]![0]).toMatchObject({
      accountId: 'default',
      runtime: 'claude-code',
    });
    expect(broadcast.mock.calls[0]![0].windows[0]!.usedPct).toBe(12);

    // Only observedAt moves: nothing to say.
    store.record('claude-code', { accountId: 'default' }, [obs('five_hour', 12, clock + 5_000)]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(broadcast).toHaveBeenCalledTimes(1);

    store.record('claude-code', { accountId: 'default' }, [obs('five_hour', 13, clock + 9_000)]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(broadcast).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
    await store.flush();
  });
});

describe('AccountUsageStore: the ambient default account (contract rev 6d)', () => {
  it("the operator's setup: defaultAccount null, only claude3 registered elsewhere -> a standalone default with its own ledger", async () => {
    await writeConfig(
      claudeConfig([{ id: 'claude3', path: path.join(home, '.claude3'), label: 'Claude3' }])
    );
    const store = makeStore();
    await store.load();
    const rows = store.list('claude-code');
    expect(rows.map((r) => [r.accountId, r.label, r.path])).toEqual([
      ['claude3', 'Claude3', path.join(home, '.claude3')],
      ['default', DEFAULT_ACCOUNT_LABEL, path.join(home, '.claude')],
    ]);
    store.record('claude-code', { path: path.join(home, '.claude') }, [obs('five_hour', 64)]);
    await store.flush();
    expect((await readLedger(claudeDir(), 'default'))!.windows.five_hour?.usedPct).toBe(64);
    expect(await readLedger(claudeDir(), 'claude3')).toBeNull();
  });

  it('an alias: an account registered at ~/.claude is one row, and default resolves to it', async () => {
    await writeConfig(
      claudeConfig([
        { id: 'main', path: path.join(home, '.claude'), label: 'Main' },
        { id: 'claude3', path: path.join(home, '.claude3'), label: null },
      ])
    );
    const store = makeStore();
    await store.load();
    expect(store.list('claude-code').map((r) => r.accountId)).toEqual(['main', 'claude3']);
    store.record('claude-code', { path: path.join(home, '.claude') }, [obs('five_hour', 9)]);
    store.record('claude-code', { accountId: 'default' }, [obs('seven_day', 19)]);
    await store.flush();
    expect(store.peek('claude-code', ['default'])[0]!.accountId).toBe('main');
    const onDisk = await readLedger(claudeDir(), 'main');
    expect(Object.keys(onDisk!.windows).sort()).toEqual(['five_hour', 'seven_day']);
    expect(await readLedger(claudeDir(), 'default')).toBeNull();
  });

  it('never resolves default from the server environment: CLAUDE_CONFIG_DIR=/x is attributed to /x, not default', async () => {
    const original = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = path.join(root, 'x');
    try {
      await writeConfig(claudeConfig([]));
      const store = makeStore();
      await store.load();
      const defaults = store.list('claude-code').filter((r) => r.accountId === 'default');
      expect(defaults.map((r) => r.path)).toEqual([path.join(home, '.claude')]);
      store.record('claude-code', { path: path.join(root, 'x') }, [obs('five_hour', 3)]);
      await store.flush();
      expect(store.list('claude-code').find((r) => r.path === path.join(root, 'x'))).toMatchObject({
        accountId: null,
      });
      expect(await readLedger(claudeDir(), 'default')).toBeNull();
    } finally {
      if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = original;
    }
  });

  it('lists every runtime: codex default at ~/.codex, opencode ambient default with no folder', async () => {
    await writeConfig(null);
    const store = makeStore();
    await store.load();
    expect(store.list('codex').map((r) => [r.accountId, r.path])).toEqual([
      ['default', path.join(home, '.codex')],
    ]);
    expect(store.list('opencode').map((r) => [r.accountId, r.state])).toEqual([['default', 'ok']]);
  });
});

describe('AccountUsageStore: reconcileAccounts (registry transitions)', () => {
  it('an EXTERNAL write registering ~/.claude folds default.json into the new id, then deletes it; twice is idempotent', async () => {
    await writeConfig(
      claudeConfig([{ id: 'claude3', path: path.join(home, '.claude3'), label: null }])
    );
    const store = makeStore();
    await store.load();
    store.record('claude-code', { accountId: 'default' }, [obs('five_hour', 64)]);
    await store.flush();
    // flow already wrote a reading under the new id.
    await writeLedger(claudeDir(), 'main', [obs('seven_day', 22)], new Date(clock));

    // `flow accounts add` edits the file directly: no ConfigManager.onChange.
    await writeConfig(
      claudeConfig([
        { id: 'claude3', path: path.join(home, '.claude3'), label: null },
        { id: 'main', path: path.join(home, '.claude'), label: null },
      ])
    );
    await store.reconcileAccounts();
    const merged = await readLedger(claudeDir(), 'main');
    expect(merged!.windows.five_hour?.usedPct).toBe(64);
    expect(merged!.windows.seven_day?.usedPct).toBe(22);
    await expect(fs.access(path.join(claudeDir(), 'default.json'))).rejects.toThrow();
    expect(store.list('claude-code').map((r) => r.accountId)).toEqual(['claude3', 'main']);

    const before = await fs.readFile(path.join(claudeDir(), 'main.json'), 'utf8');
    await store.reconcileAccounts();
    expect(await fs.readFile(path.join(claudeDir(), 'main.json'), 'utf8')).toBe(before);
    expect((await fs.readdir(claudeDir())).sort()).toEqual(['main.json']);

    // While aliased, a reading for ~/.claude never recreates default.json.
    store.record('claude-code', { path: path.join(home, '.claude') }, [
      obs('five_hour', 70, clock + 1),
    ]);
    await store.flush();
    await expect(fs.access(path.join(claudeDir(), 'default.json'))).rejects.toThrow();
  });

  it('prunes a removed account only when its file is older than 60 s', async () => {
    await writeConfig(
      claudeConfig([
        { id: 'claude3', path: path.join(home, '.claude3'), label: null },
        { id: 'gone', path: path.join(root, 'gone'), label: null },
      ])
    );
    const store = makeStore();
    await store.load();
    store.record('claude-code', { accountId: 'gone' }, [obs('five_hour', 1)]);
    await store.flush();
    // A file flow wrote for an account it just added, not yet in config.
    await writeLedger(claudeDir(), 'fresh', [obs('five_hour', 2)], new Date(clock));
    await writeConfig(
      claudeConfig([{ id: 'claude3', path: path.join(home, '.claude3'), label: null }])
    );

    await store.reconcileAccounts();
    // Both files are younger than 60 s: nothing is deleted yet.
    expect((await fs.readdir(claudeDir())).sort()).toEqual(['fresh.json', 'gone.json']);
    expect(store.list('claude-code').map((r) => r.accountId)).toEqual(['claude3', 'default']);

    await ageLedgers();
    await store.reconcileAccounts();
    expect(await fs.readdir(claudeDir())).toEqual([]);
  });

  it('deletes nothing when config.json cannot be read in full', async () => {
    await writeConfig(claudeConfig([{ id: 'gone', path: path.join(root, 'gone'), label: null }]));
    const store = makeStore();
    await store.load();
    store.record('claude-code', { accountId: 'gone' }, [obs('five_hour', 1)]);
    await store.flush();
    await fs.writeFile(path.join(dorkHome, 'config.json'), '{ half a file');
    expect(await readConfigFile(path.join(dorkHome, 'config.json'))).toBe(CONFIG_UNREADABLE);
    await ageLedgers();
    await store.reconcileAccounts();
    expect(await fs.readdir(claudeDir())).toEqual(['gone.json']);
    expect(store.list('claude-code').map((r) => r.accountId)).toEqual(['gone', 'default']);
  });

  it('the aliased account removed: default stands alone again and starts a fresh default.json', async () => {
    await writeConfig(
      claudeConfig([{ id: 'main', path: path.join(home, '.claude'), label: null }])
    );
    const store = makeStore();
    await store.load();
    store.record('claude-code', { accountId: 'default' }, [obs('five_hour', 40)]);
    await store.flush();
    await writeConfig(claudeConfig([]));
    await ageLedgers();
    await store.reconcileAccounts();
    expect(store.list('claude-code').map((r) => [r.accountId, r.windows.length])).toEqual([
      ['default', 0],
    ]);
    store.record('claude-code', { path: path.join(home, '.claude') }, [obs('five_hour', 1)]);
    await store.flush();
    expect((await readLedger(claudeDir(), 'default'))!.windows.five_hour?.usedPct).toBe(1);
    expect(await fs.readdir(claudeDir())).toEqual(['default.json']);
  });
});

describe('AccountUsageStore: default.json is never lost', () => {
  const aliasConfig = () =>
    claudeConfig([{ id: 'main', path: path.join(home, '.claude'), label: null }]);

  it('keeps default.json when the fold gives up (the row is locked), and folds it next time', async () => {
    await writeConfig(claudeConfig([]));
    const store = makeStore({ lockOptions: { giveUpMs: 20 } });
    await store.load();
    store.record('claude-code', { accountId: 'default' }, [obs('five_hour', 64)]);
    await store.flush();
    await ageLedgers();
    await fs.writeFile(path.join(claudeDir(), 'main.json.lock'), '1:held');
    await writeConfig(aliasConfig());

    await store.reconcileAccounts();
    expect((await readLedger(claudeDir(), 'default'))!.windows.five_hour?.usedPct).toBe(64);

    await fs.rm(path.join(claudeDir(), 'main.json.lock'));
    await store.reconcileAccounts();
    await expect(fs.access(path.join(claudeDir(), 'default.json'))).rejects.toThrow();
    expect((await readLedger(claudeDir(), 'main'))!.windows.five_hour?.usedPct).toBe(64);
  });

  it("keeps default.json when the row's own ledger is of another version", async () => {
    await writeConfig(claudeConfig([]));
    const store = makeStore();
    await store.load();
    store.record('claude-code', { accountId: 'default' }, [obs('five_hour', 64)]);
    await store.flush();
    await ageLedgers();
    const future = JSON.stringify({ v: 2, accountId: 'main', windows: {} });
    await fs.writeFile(path.join(claudeDir(), 'main.json'), future);
    await writeConfig(aliasConfig());

    await store.reconcileAccounts();
    expect((await readLedger(claudeDir(), 'default'))!.windows.five_hour?.usedPct).toBe(64);
    expect(await fs.readFile(path.join(claudeDir(), 'main.json'), 'utf8')).toBe(future);
  });

  it('leaves a default.json of another version alone, and folds nothing', async () => {
    await fs.mkdir(claudeDir(), { recursive: true });
    const future = JSON.stringify({ v: 2, accountId: 'default', windows: {} });
    await fs.writeFile(path.join(claudeDir(), 'default.json'), future);
    await writeConfig(aliasConfig());
    const store = makeStore();
    await store.load();
    expect((await fs.readdir(claudeDir())).sort()).toEqual(['default.json']);
    expect(await fs.readFile(path.join(claudeDir(), 'default.json'), 'utf8')).toBe(future);
  });

  it('touches nothing when default.json cannot be read this pass', async () => {
    await writeConfig(claudeConfig([]));
    const store = makeStore();
    await store.load();
    store.record('claude-code', { accountId: 'default' }, [obs('five_hour', 64)]);
    await store.flush();
    await writeConfig(aliasConfig());
    const defaultFile = path.join(claudeDir(), 'default.json');
    const realReadFile = fs.readFile.bind(fs);
    const readFile = vi.spyOn(fs, 'readFile').mockImplementation((async (
      file: string,
      ...rest: unknown[]
    ) => {
      if (file === defaultFile) throw Object.assign(new Error('EMFILE'), { code: 'EMFILE' });
      return (realReadFile as (...a: unknown[]) => Promise<unknown>)(file, ...rest);
    }) as typeof fs.readFile);

    await store.reconcileAccounts();
    readFile.mockRestore();
    expect((await readLedger(claudeDir(), 'default'))!.windows.five_hour?.usedPct).toBe(64);
    expect((await fs.readdir(claudeDir())).filter((n) => n.includes('corrupt'))).toEqual([]);
  });

  it('sets an unreadable default.json aside instead of deleting it when folding', async () => {
    await fs.mkdir(claudeDir(), { recursive: true });
    await fs.writeFile(path.join(claudeDir(), 'default.json'), '{"not":"a ledger"}');
    await writeConfig(aliasConfig());
    const store = makeStore();
    await store.load();
    const names = await fs.readdir(claudeDir());
    expect(names).not.toContain('default.json');
    const corrupt = names.find((n) => /^default\.json\.corrupt-\d+$/.test(n));
    expect(await fs.readFile(path.join(claudeDir(), corrupt!), 'utf8')).toBe('{"not":"a ledger"}');
  });
});

describe('AccountUsageStore: failed writes back off and stay bounded', () => {
  it('waits 1 s doubling to a 60 s cap', () => {
    expect([1, 2, 3, 4, 7, 8, 20].map((n) => flushRetryDelayMs(n, 1_000, 60_000))).toEqual([
      1_000, 2_000, 4_000, 8_000, 60_000, 60_000, 60_000,
    ]);
  });

  it('retries a locked ledger with growing waits, then writes at the normal pace again', async () => {
    await writeConfig(claudeConfig([]));
    // giveUpMs 0: each flush tries the lock exactly once, so opens count flushes.
    const store = makeStore({
      lockOptions: { giveUpMs: 0 },
      timings: {
        flushDebounceMs: 10,
        retryBaseMs: 100,
        retryMaxMs: 10_000,
        scanIntervalMs: 3_600_000,
      },
    });
    await store.load();
    await fs.mkdir(claudeDir(), { recursive: true });
    const lock = path.join(claudeDir(), 'default.json.lock');
    await fs.writeFile(lock, '1:held');
    const open = vi.spyOn(fs, 'open');
    const attempts = () =>
      open.mock.calls.filter(([p, flag]) => p === lock && flag === 'wx').length;

    store.record('claude-code', { accountId: 'default' }, [obs('five_hour', 20)]);
    await new Promise((r) => setTimeout(r, 1_600));
    // With no backoff this is ~160 attempts; 10, 110, 310, 710, 1510 ms is five.
    expect(attempts()).toBeGreaterThanOrEqual(2);
    expect(attempts()).toBeLessThanOrEqual(6);

    await fs.rm(lock);
    await vi.waitFor(
      async () =>
        expect((await readLedger(claudeDir(), 'default'))?.windows.five_hour?.usedPct).toBe(20),
      { timeout: 5_000 }
    );
    // A success resets the backoff: the next reading lands at the normal pace.
    store.record('claude-code', { accountId: 'default' }, [obs('seven_day', 30, clock + 1)]);
    await vi.waitFor(
      async () =>
        expect((await readLedger(claudeDir(), 'default'))?.windows.seven_day?.usedPct).toBe(30),
      // The next backoff wait would be 1.6 s; the normal pace is 10 ms.
      { timeout: 800, interval: 10 }
    );
  });

  it('holds only the newest pending reading per window while the ledger stays locked', async () => {
    await writeConfig(claudeConfig([]));
    const store = makeStore({ lockOptions: { giveUpMs: 1 } });
    await store.load();
    for (let i = 0; i < 200; i++) {
      store.record('claude-code', { accountId: 'default' }, [obs('five_hour', i % 100, clock + i)]);
    }
    const records = (store as unknown as { records: Map<string, { pending: unknown[] }> }).records;
    expect(records.get('claude-code:default')!.pending).toEqual([
      expect.objectContaining({ key: 'five_hour', usedPct: 99 }),
    ]);
  });

  // Contract 4.0.0: the pending collapse goes through mergeLedger, so two
  // sessions that see a limit in the same millisecond keep the rejected one in
  // memory, in the pending batch and on disk, whichever records first.
  it('keeps a same-millisecond rejected reading, whichever session records first', async () => {
    await writeConfig(claudeConfig([]));
    for (const rejectedFirst of [true, false]) {
      await fs.rm(claudeDir(), { recursive: true, force: true });
      const store = makeStore({ lockOptions: { giveUpMs: 1 } });
      await store.load();
      await fs.mkdir(claudeDir(), { recursive: true });
      await fs.writeFile(path.join(claudeDir(), 'default.json.lock'), '1:held');
      const rejected = { ...obs('five_hour', 10), status: 'rejected' as const };
      const allowed = { ...obs('five_hour', 90), status: 'allowed' as const };
      for (const reading of rejectedFirst ? [rejected, allowed] : [allowed, rejected]) {
        store.record('claude-code', { accountId: 'default' }, [reading]);
      }
      const records = (store as unknown as { records: Map<string, { pending: unknown[] }> })
        .records;
      expect(records.get('claude-code:default')!.pending).toEqual([
        expect.objectContaining({ key: 'five_hour', status: 'rejected', usedPct: 10 }),
      ]);
      expect(store.peek('claude-code', ['default'])[0]!.state).toBe('limited');
      await store.flush();
      await fs.rm(path.join(claudeDir(), 'default.json.lock'));
      await store.flush();
      expect((await readLedger(claudeDir(), 'default'))!.windows.five_hour).toMatchObject({
        status: 'rejected',
        usedPct: 10,
      });
      store.stop();
    }
  });
});

describe('AccountUsageStore: readings put back after a failed write', () => {
  it('reach disk without waiting for another reading', async () => {
    await writeConfig(claudeConfig([]));
    const store = makeStore({
      lockOptions: { giveUpMs: 20 },
      timings: { flushDebounceMs: 20, scanIntervalMs: 3_600_000 },
    });
    await store.load();
    await fs.mkdir(claudeDir(), { recursive: true });
    const lock = path.join(claudeDir(), 'default.json.lock');
    await fs.writeFile(lock, '1:held');
    store.record('claude-code', { accountId: 'default' }, [obs('five_hour', 20)]);
    await vi.waitFor(async () =>
      expect(await fs.readdir(claudeDir())).toContain('default.json.lock')
    );
    // Let at least one attempt give up, then free the lock and record nothing more.
    await new Promise((r) => setTimeout(r, 100));
    expect(await readLedger(claudeDir(), 'default')).toBeNull();
    await fs.rm(lock);
    await vi.waitFor(
      async () =>
        expect((await readLedger(claudeDir(), 'default'))?.windows.five_hour?.usedPct).toBe(20),
      { timeout: 3_000 }
    );
  });
});

describe('AccountUsageStore: review round 3', () => {
  const aliasConfig = () =>
    claudeConfig([{ id: 'main', path: path.join(home, '.claude'), label: null }]);

  it('a fold that throws on load still starts the scan, and a later scan folds', async () => {
    await writeConfig(claudeConfig([]));
    const first = makeStore();
    await first.load();
    first.record('claude-code', { accountId: 'default' }, [obs('five_hour', 64)]);
    await first.flush();
    first.stop();
    await writeConfig(aliasConfig());
    await writeLedger(claudeDir(), 'main', [obs('seven_day', 5)], new Date(clock));

    const mainFile = path.join(claudeDir(), 'main.json');
    const realReadFile = fs.readFile.bind(fs);
    const readFile = vi.spyOn(fs, 'readFile').mockImplementation((async (
      file: string,
      ...rest: unknown[]
    ) => {
      if (file === mainFile) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return (realReadFile as (...a: unknown[]) => Promise<unknown>)(file, ...rest);
    }) as typeof fs.readFile);
    const store = makeStore();
    await expect(store.load()).resolves.toBeUndefined();
    expect((store as unknown as { scanTimer?: unknown }).scanTimer).toBeDefined();
    expect((await readLedger(claudeDir(), 'default'))!.windows.five_hour?.usedPct).toBe(64);

    readFile.mockRestore();
    await store.scan();
    await expect(fs.access(path.join(claudeDir(), 'default.json'))).rejects.toThrow();
    expect((await readLedger(claudeDir(), 'main'))!.windows.five_hour?.usedPct).toBe(64);
  });

  it('a default write that fails while it is folded never recreates default.json', async () => {
    await writeConfig(claudeConfig([]));
    const store = makeStore({
      lockOptions: { giveUpMs: 150 },
      timings: { flushDebounceMs: 10, retryBaseMs: 20, scanIntervalMs: 3_600_000 },
    });
    await store.load();
    await fs.mkdir(claudeDir(), { recursive: true });
    const lock = path.join(claudeDir(), 'default.json.lock');
    await fs.writeFile(lock, '1:held');
    store.record('claude-code', { accountId: 'default' }, [obs('five_hour', 64)]);
    const inFlight = store.flush();
    await writeConfig(aliasConfig());
    await store.reconcileAccounts();
    await inFlight;
    await fs.rm(lock);
    await new Promise((r) => setTimeout(r, 300));
    await store.flush();
    await expect(fs.access(path.join(claudeDir(), 'default.json'))).rejects.toThrow();
    expect((await readLedger(claudeDir(), 'main'))!.windows.five_hour?.usedPct).toBe(64);
  });

  it('logs a pending reading it sets aside, once', async () => {
    await writeConfig(claudeConfig([]));
    const store = makeStore();
    await store.load();
    const warn = vi.spyOn(logger, 'warn');
    const future = clock + 60 * 60 * 1000;
    store.record('claude-code', { accountId: 'default' }, [obs('five_hour', 1, future)]);
    store.record('claude-code', { accountId: 'default' }, [obs('five_hour', 2, future + 1)]);
    const setAside = warn.mock.calls.filter(([m]) => String(m).includes('set aside'));
    expect(setAside).toHaveLength(1);
  });

  it("keeps default.json's unknown top-level fields on the row, the row's own winning", async () => {
    await fs.mkdir(claudeDir(), { recursive: true });
    await fs.writeFile(
      path.join(claudeDir(), 'default.json'),
      JSON.stringify({
        v: 1,
        runtime: 'claude-code',
        accountId: 'default',
        updatedAt: new Date(clock).toISOString(),
        windows: { five_hour: obs('five_hour', 64) },
        note: 'from default',
        extra: 1,
      })
    );
    await fs.writeFile(
      path.join(claudeDir(), 'main.json'),
      JSON.stringify({
        v: 1,
        runtime: 'claude-code',
        accountId: 'main',
        updatedAt: new Date(clock).toISOString(),
        windows: {},
        note: 'the row',
      })
    );
    await writeConfig(aliasConfig());
    const store = makeStore();
    await store.load();
    const main = JSON.parse(await fs.readFile(path.join(claudeDir(), 'main.json'), 'utf8'));
    expect(main).toMatchObject({ note: 'the row', extra: 1 });
    expect(main.windows.five_hour.usedPct).toBe(64);
    await expect(fs.access(path.join(claudeDir(), 'default.json'))).rejects.toThrow();
  });
});

describe('AccountUsageStore: the folder watch', () => {
  it('picks up a reading flow writes and emits it', async () => {
    await writeConfig(
      claudeConfig([{ id: 'work', path: path.join(home, '.claude3'), label: null }])
    );
    await writeLedger(claudeDir(), 'work', [obs('five_hour', 1)], new Date(clock));
    const broadcast = vi.fn();
    const store = makeStore({
      broadcast,
      timings: { watchDebounceMs: 20, broadcastThrottleMs: 20, scanIntervalMs: 3_600_000 },
    });
    await store.load();
    expect(broadcast).not.toHaveBeenCalled();
    await writeLedger(claudeDir(), 'work', [obs('seven_day', 81, clock + 1)], new Date(clock));
    await vi.waitFor(
      () =>
        expect(store.peek('claude-code', ['work'])[0]!.windows.map((w) => w.key)).toContain(
          'seven_day'
        ),
      { timeout: 3_000 }
    );
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalled(), { timeout: 3_000 });
  });
});
