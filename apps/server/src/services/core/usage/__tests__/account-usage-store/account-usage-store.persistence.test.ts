import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_UNREADABLE, readConfigFile } from '../../account-usage-reconcile.js';
import { readLedger, writeLedger } from '../../ledger-file.js';
import {
  usage,
  useUsageStoreSandbox,
  obs,
  writeConfig,
  claudeConfig,
  makeStore,
  claudeDir,
  ageLedgers,
} from './account-usage-store.fixtures.js';

useUsageStoreSandbox();

describe('AccountUsageStore: reconcileAccounts (registry transitions)', () => {
  it('an EXTERNAL write registering ~/.claude folds default.json into the new id, then deletes it; twice is idempotent', async () => {
    await writeConfig(
      claudeConfig([{ id: 'claude3', path: path.join(usage.home, '.claude3'), label: null }])
    );
    const store = makeStore();
    await store.load();
    store.record('claude-code', { accountId: 'default' }, [obs('five_hour', 64)]);
    await store.flush();
    // flow already wrote a reading under the new id.
    await writeLedger(claudeDir(), 'main', [obs('seven_day', 22)], new Date(usage.clock));

    // `flow accounts add` edits the file directly: no ConfigManager.onChange.
    await writeConfig(
      claudeConfig([
        { id: 'claude3', path: path.join(usage.home, '.claude3'), label: null },
        { id: 'main', path: path.join(usage.home, '.claude'), label: null },
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
    store.record('claude-code', { path: path.join(usage.home, '.claude') }, [
      obs('five_hour', 70, usage.clock + 1),
    ]);
    await store.flush();
    await expect(fs.access(path.join(claudeDir(), 'default.json'))).rejects.toThrow();
  });

  it('prunes a removed account only when its file is older than 60 s', async () => {
    await writeConfig(
      claudeConfig([
        { id: 'claude3', path: path.join(usage.home, '.claude3'), label: null },
        { id: 'gone', path: path.join(usage.root, 'gone'), label: null },
      ])
    );
    const store = makeStore();
    await store.load();
    store.record('claude-code', { accountId: 'gone' }, [obs('five_hour', 1)]);
    await store.flush();
    // A file flow wrote for an account it just added, not yet in config.
    await writeLedger(claudeDir(), 'fresh', [obs('five_hour', 2)], new Date(usage.clock));
    await writeConfig(
      claudeConfig([{ id: 'claude3', path: path.join(usage.home, '.claude3'), label: null }])
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
    await writeConfig(
      claudeConfig([{ id: 'gone', path: path.join(usage.root, 'gone'), label: null }])
    );
    const store = makeStore();
    await store.load();
    store.record('claude-code', { accountId: 'gone' }, [obs('five_hour', 1)]);
    await store.flush();
    await fs.writeFile(path.join(usage.dorkHome, 'config.json'), '{ half a file');
    expect(await readConfigFile(path.join(usage.dorkHome, 'config.json'))).toBe(CONFIG_UNREADABLE);
    await ageLedgers();
    await store.reconcileAccounts();
    expect(await fs.readdir(claudeDir())).toEqual(['gone.json']);
    expect(store.list('claude-code').map((r) => r.accountId)).toEqual(['gone', 'default']);
  });
});

describe('AccountUsageStore: default.json is never lost', () => {
  const aliasConfig = () =>
    claudeConfig([{ id: 'main', path: path.join(usage.home, '.claude'), label: null }]);

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

describe('AccountUsageStore: pending readings stay bounded', () => {
  // Contract 4.0.0: the pending collapse goes through mergeLedger, so two
  // sessions that see a limit in the same millisecond keep the rejected one in
  // memory, in the pending batch and on disk, whichever records first.
  it('keeps a same-millisecond rejected reading over a later allowed one', async () => {
    await writeConfig(claudeConfig([]));
    const store = makeStore({ lockOptions: { giveUpMs: 1 } });
    await store.load();
    await fs.mkdir(claudeDir(), { recursive: true });
    await fs.writeFile(path.join(claudeDir(), 'default.json.lock'), '1:held');
    store.record('claude-code', { accountId: 'default' }, [
      { ...obs('five_hour', 10), status: 'rejected' as const },
    ]);
    store.record('claude-code', { accountId: 'default' }, [
      { ...obs('five_hour', 90), status: 'allowed' as const },
    ]);
    expect(store.peek('claude-code', ['default'])[0]!.state).toBe('limited');
    await store.flush();
    await fs.rm(path.join(claudeDir(), 'default.json.lock'));
    await store.flush();
    expect((await readLedger(claudeDir(), 'default'))!.windows.five_hour).toMatchObject({
      status: 'rejected',
      usedPct: 10,
    });
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

describe('AccountUsageStore: folding default.json into an alias', () => {
  const aliasConfig = () =>
    claudeConfig([{ id: 'main', path: path.join(usage.home, '.claude'), label: null }]);

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

  it("keeps default.json's unknown top-level fields on the row, the row's own winning", async () => {
    await fs.mkdir(claudeDir(), { recursive: true });
    await fs.writeFile(
      path.join(claudeDir(), 'default.json'),
      JSON.stringify({
        v: 1,
        runtime: 'claude-code',
        accountId: 'default',
        updatedAt: new Date(usage.clock).toISOString(),
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
        updatedAt: new Date(usage.clock).toISOString(),
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
