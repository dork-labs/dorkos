import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import { recordAccountSignin } from '../../../observability/account-signin-state.js';
import { readLedger, writeLedger } from '../ledger-file.js';
import { DEFAULT_ACCOUNT_LABEL } from '../runtime-accounts.js';
import {
  usage,
  useUsageStoreSandbox,
  obs,
  writeConfig,
  claudeConfig,
  makeStore,
  claudeDir,
} from './account-usage-store/account-usage-store.fixtures.js';

useUsageStoreSandbox();

describe('AccountUsageStore: recording and persistence', () => {
  it('serves the observed sign-in state of each account independently', async () => {
    const first = path.join(usage.home, '.claude');
    const second = path.join(usage.home, '.claude3');
    await writeConfig(
      claudeConfig([
        { id: 'main', path: first, label: 'Main' },
        { id: 'five', path: `${second}/`, label: 'Claude5' },
      ])
    );
    const store = makeStore();
    await store.load();
    recordAccountSignin('claude-code', first, 'signed-in');
    recordAccountSignin('claude-code', second, 'signed-out');
    const states = new Map(
      store.list('claude-code').map((row) => [row.accountId, row.signInState])
    );
    expect(states.get('main')).toBe('signed-in');
    expect(states.get('five')).toBe('signed-out');
  });

  it('two sessions (two spellings of one root) on one account update one record', async () => {
    await writeConfig(
      claudeConfig([{ id: 'work', path: path.join(usage.home, '.claude3'), label: 'Work' }])
    );
    const store = makeStore();
    await store.load();
    store.record('claude-code', { path: path.join(usage.home, '.claude3') }, [
      obs('five_hour', 10),
    ]);
    store.record('claude-code', { path: `${path.join(usage.home, '.claude3')}/` }, [
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

  it('a limit notice with no number keeps the probed share, on disk and after a restart (DOR-3589)', async () => {
    await writeConfig(
      claudeConfig([{ id: 'work', path: path.join(usage.home, '.claude3'), label: null }])
    );
    const first = makeStore();
    await first.load();
    first.record('claude-code', { accountId: 'work' }, [
      { ...obs('seven_day', 10), source: 'sdk_usage' },
    ]);
    await first.flush();
    usage.clock += 60_000;
    // The SDK's rate_limit_event, with a status and no utilization.
    first.record('claude-code', { accountId: 'work' }, [
      { ...obs('seven_day', 0), usedPct: null, status: 'allowed_warning' },
    ]);
    await first.flush();
    first.stop();

    const onDisk = await readLedger(claudeDir(), 'work');
    expect(onDisk!.windows.seven_day).toMatchObject({
      usedPct: 10,
      status: 'allowed_warning',
      observedAt: new Date(usage.clock - 60_000).toISOString(),
      statusObservedAt: new Date(usage.clock).toISOString(),
    });
    const second = makeStore();
    await second.load();
    const [work] = second.peek('claude-code', ['work']);
    expect(work!.windows.map((w) => [w.key, w.usedPct, w.status])).toEqual([
      ['seven_day', 10, 'allowed_warning'],
    ]);
  });

  it('keeps a reading flow wrote between two flushes', async () => {
    await writeConfig(
      claudeConfig([{ id: 'work', path: path.join(usage.home, '.claude3'), label: null }])
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
      new Date(usage.clock)
    );
    usage.clock += 1000;
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
      claudeConfig([{ id: 'work', path: path.join(usage.home, '.claude3'), label: null }])
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
});

describe('AccountUsageStore: account_usage emissions', () => {
  it('emits once per account per 2 s, trailing, and not for a new observedAt alone', async () => {
    await writeConfig(claudeConfig([]));
    const broadcast = vi.fn<(u: AccountUsage) => void>();
    const store = makeStore({ broadcast });
    await store.load();
    vi.useFakeTimers();

    store.record('claude-code', { accountId: 'default' }, [obs('five_hour', 10)]);
    store.record('claude-code', { accountId: 'default' }, [obs('five_hour', 11, usage.clock + 1)]);
    store.record('claude-code', { accountId: 'default' }, [obs('five_hour', 12, usage.clock + 2)]);
    expect(broadcast).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0]![0].windows[0]!.usedPct).toBe(12);

    // Only observedAt moves: nothing to say.
    store.record('claude-code', { accountId: 'default' }, [
      obs('five_hour', 12, usage.clock + 5_000),
    ]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(broadcast).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    await store.flush();
  });
});

describe('AccountUsageStore: the ambient default account (contract rev 6d)', () => {
  it("the operator's setup: defaultAccount null, only claude3 registered elsewhere -> a standalone default with its own ledger", async () => {
    await writeConfig(
      claudeConfig([{ id: 'claude3', path: path.join(usage.home, '.claude3'), label: 'Claude3' }])
    );
    const store = makeStore();
    await store.load();
    const rows = store.list('claude-code');
    expect(rows.map((r) => [r.accountId, r.label, r.path])).toEqual([
      ['claude3', 'Claude3', path.join(usage.home, '.claude3')],
      ['default', DEFAULT_ACCOUNT_LABEL, path.join(usage.home, '.claude')],
    ]);
    store.record('claude-code', { path: path.join(usage.home, '.claude') }, [obs('five_hour', 64)]);
    await store.flush();
    expect((await readLedger(claudeDir(), 'default'))!.windows.five_hour?.usedPct).toBe(64);
    expect(await readLedger(claudeDir(), 'claude3')).toBeNull();
  });

  it('never resolves default from the server environment: CLAUDE_CONFIG_DIR=/x is attributed to /x, not default', async () => {
    const original = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = path.join(usage.root, 'x');
    try {
      await writeConfig(claudeConfig([]));
      const store = makeStore();
      await store.load();
      const defaults = store.list('claude-code').filter((r) => r.accountId === 'default');
      expect(defaults.map((r) => r.path)).toEqual([path.join(usage.home, '.claude')]);
      store.record('claude-code', { path: path.join(usage.root, 'x') }, [obs('five_hour', 3)]);
      await store.flush();
      expect(
        store.list('claude-code').find((r) => r.path === path.join(usage.root, 'x'))
      ).toMatchObject({
        accountId: null,
      });
      expect(await readLedger(claudeDir(), 'default')).toBeNull();
    } finally {
      if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = original;
    }
  });
});

describe('AccountUsageStore.peekByRoot (spec claude-account-fleet §6 U)', () => {
  it('answers the registered account at a folder and a memory-only folder', async () => {
    await writeConfig(
      claudeConfig([{ id: 'work', path: path.join(usage.home, '.claude3'), label: 'Work' }])
    );
    const store = makeStore();
    await store.load();
    store.record('claude-code', { accountId: 'work' }, [obs('five_hour', 30)]);

    const registered = store.peekByRoot('claude-code', `${path.join(usage.home, '.claude3')}/`);
    expect(registered).toMatchObject({ accountId: 'work', label: 'Work' });
    expect(registered.windows.map((w) => w.usedPct)).toEqual([30]);

    const stray = path.join(usage.home, '.claude9');
    // No reading yet: it still answers, with its folder, so a client can match
    // the first event for it by path.
    expect(store.peekByRoot('claude-code', stray)).toMatchObject({
      accountId: null,
      path: stray,
      windows: [],
    });
    store.record('claude-code', { path: stray }, [obs('seven_day', 5)]);
    expect(store.peekByRoot('claude-code', stray).windows.map((w) => w.usedPct)).toEqual([5]);
  });
});
