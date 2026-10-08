import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { DEFAULT_ACCOUNT_COLORS, type AccountUsage } from '@dorkos/shared/account-usage';
import { createDataProviderContext } from '../extension-server-api-factory.js';
import { setStartWorkService, type StartWorkService } from '../start-work.js';
import { setAgentSendService, type AgentSendService } from '../agent-send/agent-send.js';
import { projectRegistry } from '../../projects/project-registry.js';
import {
  __resetAccountAdvisorForTests,
  accountAdvisorOwner,
  hasAccountAdvisor,
} from '../../core/usage/account-advisor.js';
import { setAccountUsageStore } from '../../core/usage/current-usage-store.js';
import { AccountUsageStore } from '../../core/usage/account-usage-store.js';
import { readConfigFile } from '../../core/usage/account-usage-reconcile.js';
import { DEFAULT_ACCOUNT_LABEL, defaultAccountFolder } from '../../core/usage/runtime-accounts.js';
import {
  CONTINUATION_UNAVAILABLE_MESSAGE,
  setContinuationRecorder,
} from '../../core/usage/session-continuation.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../core/event-fan-out.js', () => ({
  eventFanOut: {
    broadcast: vi.fn(),
  },
}));

let mockBroadcast: ReturnType<typeof vi.fn>;
let mockLoggerError: ReturnType<typeof vi.fn>;

describe('createDataProviderContext', () => {
  let tmpDir: string;
  const extensionId = 'test-extension';
  const extensionDir = '/fake/ext/dir';

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-api-factory-'));

    const { eventFanOut } = await import('../../core/event-fan-out.js');
    mockBroadcast = vi.mocked(eventFanOut.broadcast);

    const { logger } = await import('../../../lib/logger.js');
    mockLoggerError = vi.mocked(logger.error);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function buildCtx(overrides?: { extensionId?: string; dorkHome?: string }) {
    return createDataProviderContext({
      extensionId: overrides?.extensionId ?? extensionId,
      extensionDir,
      dorkHome: overrides?.dorkHome ?? tmpDir,
    });
  }

  describe('metadata fields', () => {
    it('exposes extensionId and extensionDir', () => {
      const { ctx } = buildCtx();
      expect(ctx.extensionId).toBe(extensionId);
      expect(ctx.extensionDir).toBe(extensionDir);
    });
  });

  describe('filesDir', () => {
    // Purpose: one writable folder per extension at the documented place,
    // existing before register() could use it (DOR-2686 task 4.2).
    it('is {dorkHome}/extension-data/<id>/files and exists once the ctx is built', async () => {
      const { ctx } = buildCtx();
      expect(ctx.filesDir).toBe(path.join(tmpDir, 'extension-data', extensionId, 'files'));
      const stat = await fs.stat(ctx.filesDir);
      expect(stat.isDirectory()).toBe(true);
    });

    // Purpose: no drift from the folder an isolated child is granted write
    // access to; both read the same helper.
    it('is the folder the isolated runtime grants', async () => {
      const { isolatedFilesDir } = await import('../isolation/grants.js');
      const { ctx } = buildCtx();
      expect(ctx.filesDir).toBe(isolatedFilesDir(tmpDir, extensionId));
    });
  });

  describe('secrets', () => {
    it('provides an ExtensionSecretStore with the correct extensionId', async () => {
      const { ctx } = buildCtx();
      // Verify secrets interface is present and functional
      expect(ctx.secrets).toBeDefined();
      expect(typeof ctx.secrets.get).toBe('function');
      expect(typeof ctx.secrets.set).toBe('function');
      expect(typeof ctx.secrets.delete).toBe('function');
      expect(typeof ctx.secrets.has).toBe('function');

      // A missing key returns null
      const result = await ctx.secrets.get('nonexistent');
      expect(result).toBeNull();
    });

    it('can round-trip a secret value', async () => {
      const { ctx } = buildCtx();
      await ctx.secrets.set('api-key', 'sk-12345');
      const value = await ctx.secrets.get('api-key');
      expect(value).toBe('sk-12345');
    });
  });

  describe('storage.loadData', () => {
    it('returns null when no data file exists', async () => {
      const { ctx } = buildCtx();
      const data = await ctx.storage.loadData();
      expect(data).toBeNull();
    });

    it('returns parsed JSON when file exists', async () => {
      const dataDir = path.join(tmpDir, 'extension-data', extensionId);
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(path.join(dataDir, 'data.json'), JSON.stringify({ count: 42 }), 'utf-8');

      const { ctx } = buildCtx();
      const data = await ctx.storage.loadData<{ count: number }>();
      expect(data).toEqual({ count: 42 });
    });
  });

  describe('storage.saveData', () => {
    it('writes JSON to the correct path with atomic rename', async () => {
      const { ctx } = buildCtx();
      await ctx.storage.saveData({ status: 'active', items: [1, 2, 3] });

      const dataPath = path.join(tmpDir, 'extension-data', extensionId, 'data.json');
      const raw = await fs.readFile(dataPath, 'utf-8');
      expect(JSON.parse(raw)).toEqual({ status: 'active', items: [1, 2, 3] });
    });

    it('creates parent directories if they do not exist', async () => {
      const { ctx } = buildCtx();
      await ctx.storage.saveData({ hello: 'world' });

      const dataPath = path.join(tmpDir, 'extension-data', extensionId, 'data.json');
      const stat = await fs.stat(dataPath);
      expect(stat.isFile()).toBe(true);
    });

    it('round-trips data through saveData and loadData', async () => {
      const { ctx } = buildCtx();
      const payload = { nested: { value: true }, list: ['a', 'b'] };
      await ctx.storage.saveData(payload);
      const loaded = await ctx.storage.loadData();
      expect(loaded).toEqual(payload);
    });
  });

  describe('schedule', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('calls the function at the specified interval', async () => {
      const { ctx } = buildCtx();
      const fn = vi.fn().mockResolvedValue(undefined);

      ctx.schedule(10, fn);

      // Not called immediately
      expect(fn).not.toHaveBeenCalled();

      // Advance 10 seconds
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fn).toHaveBeenCalledTimes(1);

      // Advance another 10 seconds
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('returns a cancel function that stops the interval', async () => {
      const { ctx } = buildCtx();
      const fn = vi.fn().mockResolvedValue(undefined);

      const cancel = ctx.schedule(10, fn);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(fn).toHaveBeenCalledTimes(1);

      cancel();

      await vi.advanceTimersByTimeAsync(20_000);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('clamps intervals below 5 seconds to the minimum floor', async () => {
      const { ctx } = buildCtx();
      const fn = vi.fn().mockResolvedValue(undefined);

      ctx.schedule(2, fn);

      // At 2 seconds, should NOT have fired (clamped to 5s)
      await vi.advanceTimersByTimeAsync(2_000);
      expect(fn).not.toHaveBeenCalled();

      // At 5 seconds, should fire
      await vi.advanceTimersByTimeAsync(3_000);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('catches and logs errors from scheduled functions', async () => {
      const { ctx } = buildCtx();
      const fn = vi.fn().mockRejectedValue(new Error('boom'));

      ctx.schedule(5, fn);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(mockLoggerError).toHaveBeenCalledWith(
        `[ext:${extensionId}] Scheduled task error:`,
        expect.any(Error)
      );
    });
  });

  describe('emit', () => {
    it('broadcasts via eventFanOut with namespaced event', () => {
      const { ctx } = buildCtx();
      ctx.emit('status-changed', { issueId: 'ISS-1', status: 'done' });

      expect(mockBroadcast).toHaveBeenCalledWith(`ext:${extensionId}:status-changed`, {
        issueId: 'ISS-1',
        status: 'done',
      });
    });

    it('uses the correct extension ID in the event namespace', () => {
      const { ctx } = buildCtx({ extensionId: 'my-plugin' });
      ctx.emit('refresh', null);

      expect(mockBroadcast).toHaveBeenCalledWith('ext:my-plugin:refresh', null);
    });
  });

  describe('getScheduledCleanups', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns all registered cancel functions', () => {
      const { ctx, getScheduledCleanups } = buildCtx();

      ctx.schedule(10, vi.fn().mockResolvedValue(undefined));
      ctx.schedule(20, vi.fn().mockResolvedValue(undefined));

      const cleanups = getScheduledCleanups();
      expect(cleanups).toHaveLength(2);
      expect(cleanups.every((fn) => typeof fn === 'function')).toBe(true);
    });

    it('returns a defensive copy (not the internal array)', () => {
      const { ctx, getScheduledCleanups } = buildCtx();

      ctx.schedule(10, vi.fn().mockResolvedValue(undefined));

      const copy1 = getScheduledCleanups();
      const copy2 = getScheduledCleanups();
      expect(copy1).not.toBe(copy2);
      expect(copy1).toEqual(copy2);
    });

    it('cancelling all cleanups stops all intervals', async () => {
      const { ctx, getScheduledCleanups } = buildCtx();
      const fn1 = vi.fn().mockResolvedValue(undefined);
      const fn2 = vi.fn().mockResolvedValue(undefined);

      ctx.schedule(5, fn1);
      ctx.schedule(10, fn2);

      // Cancel all
      for (const cancel of getScheduledCleanups()) {
        cancel();
      }

      await vi.advanceTimersByTimeAsync(20_000);
      expect(fn1).not.toHaveBeenCalled();
      expect(fn2).not.toHaveBeenCalled();
    });
  });

  describe('dorkHome and accounts (claude-account-fleet X1-X3)', () => {
    const work = {
      runtime: 'claude-code',
      id: 'work',
      path: '/a/work',
      canonicalPath: '/a/work',
      label: 'Work',
      color: '#111111',
      storedColor: '#111111',
      routable: true,
      implicit: false,
      isDefault: false,
      ledgerId: 'work',
    };
    const codexDefault = {
      ...work,
      runtime: 'codex',
      id: 'default',
      label: null,
      color: '#222222',
      storedColor: null,
      implicit: true,
      isDefault: true,
      ledgerId: 'default',
    };
    const usageRow = {
      runtime: 'claude-code',
      accountId: 'work',
      path: '/Users/kai/.claude-work',
    } as AccountUsage;
    const { path: _hidden, ...extensionUsageRow } = usageRow;
    let listeners: Set<(u: AccountUsage) => void>;
    let storeList: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      __resetAccountAdvisorForTests();
      listeners = new Set();
      storeList = vi.fn().mockReturnValue([usageRow]);
      const store = {
        listAccounts: () => [work, codexDefault],
        list: storeList,
        onChange: (listener: (u: AccountUsage) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      setAccountUsageStore(store as unknown as AccountUsageStore);
    });

    afterEach(() => {
      setAccountUsageStore(undefined);
      setContinuationRecorder(undefined);
    });

    it('exposes the resolved DorkOS data directory', () => {
      expect(buildCtx().ctx.dorkHome).toBe(tmpDir);
    });

    it("lists every runtime's accounts, implicit defaults included", async () => {
      expect(await buildCtx().ctx.accounts.list()).toEqual([
        { runtime: 'claude-code', id: 'work', label: 'Work', color: '#111111', implicit: false },
        { runtime: 'codex', id: 'default', label: null, color: '#222222', implicit: true },
      ]);
    });

    it('reads usage for every runtime or one, and nothing for an unknown runtime', async () => {
      const { ctx } = buildCtx();
      expect(await ctx.accounts.usage()).toEqual([extensionUsageRow]);
      expect(storeList).toHaveBeenLastCalledWith();
      await ctx.accounts.usage('codex');
      expect(storeList).toHaveBeenLastCalledWith('codex');
      expect(await ctx.accounts.usage('not-a-runtime')).toEqual([]);
    });

    it('answers empty before the usage store exists', async () => {
      setAccountUsageStore(undefined);
      const { ctx } = buildCtx();
      expect(await ctx.accounts.list()).toEqual([]);
      expect(await ctx.accounts.usage()).toEqual([]);
    });

    it('delivers usage changes until the listener is removed, by hand or on release', () => {
      const { ctx, releaseListeners } = buildCtx();
      const kept = vi.fn();
      const removed = vi.fn();
      ctx.accounts.onUsage(kept);
      const stop = ctx.accounts.onUsage(removed);
      stop();
      for (const l of listeners) l(usageRow);
      expect(kept).toHaveBeenCalledWith(extensionUsageRow);
      expect(removed).not.toHaveBeenCalled();

      releaseListeners();
      expect(listeners.size).toBe(0);
    });

    it.each([false, undefined])(
      'attempts every listener release and retains exact failure %s',
      (cause) => {
        const removers = [
          vi.fn(() => {
            throw cause;
          }),
          vi.fn(),
        ];
        let entered = 0;
        const store = {
          listAccounts: () => [],
          list: () => [],
          onChange: () => removers[entered++],
        };
        setAccountUsageStore(store as unknown as AccountUsageStore);
        const built = buildCtx();
        built.ctx.accounts.onUsage(vi.fn());
        built.ctx.accounts.onUsage(vi.fn());
        const capture = (cleanup: () => void): { value: unknown } => {
          try {
            cleanup();
          } catch (value) {
            return { value };
          }
          throw new Error('original failure was lost');
        };
        expect(capture(built.releaseListeners).value).toBe(cause);
        expect(removers[0]).toHaveBeenCalledTimes(1);
        expect(removers[1]).toHaveBeenCalledTimes(1);
        expect(capture(built.releaseListeners).value).toBe(cause);
        expect(capture(built.dispose).value).toBe(cause);
        expect(removers[0]).toHaveBeenCalledTimes(1);
        expect(removers[1]).toHaveBeenCalledTimes(1);
      }
    );

    it.each([false, undefined])(
      'manual unsubscribe failure %s remains owned by disposal',
      (cause) => {
        const removers = [
          vi.fn(() => {
            throw cause;
          }),
          vi.fn(),
        ];
        let entered = 0;
        const store = {
          listAccounts: () => [],
          list: () => [],
          onChange: () => removers[entered++],
        };
        setAccountUsageStore(store as unknown as AccountUsageStore);
        const built = buildCtx();
        const unsubscribe = built.ctx.accounts.onUsage(vi.fn());
        built.ctx.accounts.onUsage(vi.fn());
        const capture = (cleanup: () => void): { value: unknown } => {
          try {
            cleanup();
          } catch (value) {
            return { value };
          }
          throw new Error('original failure was lost');
        };
        expect(capture(unsubscribe).value).toBe(cause);
        expect(removers[0]).toHaveBeenCalledTimes(1);
        expect(removers[1]).not.toHaveBeenCalled();
        expect(capture(built.dispose).value).toBe(cause);
        expect(removers[0]).toHaveBeenCalledTimes(1);
        expect(removers[1]).toHaveBeenCalledTimes(1);
        expect(capture(built.dispose).value).toBe(cause);
        expect(removers[0]).toHaveBeenCalledTimes(1);
      }
    );

    it('retires an exact account receipt returned after synchronous disposal', () => {
      const remove = vi.fn();
      const store = {
        listAccounts: () => [],
        list: () => [],
        onChange: () => {
          built.dispose();
          return remove;
        },
      };
      setAccountUsageStore(store as unknown as AccountUsageStore);
      const built = buildCtx();
      const unsubscribe = built.ctx.accounts.onUsage(vi.fn());
      expect(remove).toHaveBeenCalledTimes(1);
      unsubscribe();
      built.dispose();
      expect(remove).toHaveBeenCalledTimes(1);
    });

    it('never hands an extension an account folder path', async () => {
      const { ctx } = buildCtx();
      const seen = vi.fn();
      ctx.accounts.onUsage(seen);
      for (const l of listeners) l(usageRow);
      const rows = [...(await ctx.accounts.usage()), ...(await ctx.accounts.usage('claude-code'))];
      for (const row of [...rows, seen.mock.calls[0]?.[0]]) {
        expect(row).toBeDefined();
        expect(row).not.toHaveProperty('path');
      }
    });

    it('closes after release: a late registerAdvisor or onUsage registers nothing', async () => {
      const old = buildCtx({ extensionId: 'reloaded-ext' });
      old.releaseListeners();

      expect(() =>
        old.ctx.accounts.registerAdvisor({ rank: () => ({ accounts: [], recommendedId: null }) })
      ).toThrow(/shut down or reloaded/);
      expect(() => old.ctx.accounts.onUsage(vi.fn())).toThrow(/shut down or reloaded/);
      await expect(
        old.ctx.accounts.markContinued('old', { sessionId: 'n', runtime: 'x', accountId: 'y' })
      ).rejects.toThrow(/shut down or reloaded/);
      expect(hasAccountAdvisor()).toBe(false);
      expect(listeners.size).toBe(0);

      // The instance that replaced it keeps its advisor when the old one calls late.
      const current = buildCtx({ extensionId: 'reloaded-ext' });
      current.ctx.accounts.registerAdvisor({ rank: () => ({ accounts: [], recommendedId: null }) });
      expect(() =>
        old.ctx.accounts.registerAdvisor({ rank: () => ({ accounts: [], recommendedId: null }) })
      ).toThrow();
      old.releaseListeners();
      expect(accountAdvisorOwner()).toBe('reloaded-ext');
      expect(hasAccountAdvisor()).toBe(true);
      // Reads still answer.
      expect(await old.ctx.accounts.list()).toHaveLength(2);
    });

    it('registers the advisor under the extension id and removes it on release', () => {
      const { ctx, releaseListeners } = buildCtx();
      ctx.accounts.registerAdvisor({ rank: () => ({ accounts: [], recommendedId: null }) });
      expect(accountAdvisorOwner()).toBe(extensionId);
      releaseListeners();
      expect(hasAccountAdvisor()).toBe(false);
    });

    it("a replaced extension's release leaves the new advisor in place", () => {
      const first = buildCtx({ extensionId: 'first-ext' });
      const second = buildCtx({ extensionId: 'second-ext' });
      const advisor = { rank: () => ({ accounts: [], recommendedId: null }) };
      first.ctx.accounts.registerAdvisor(advisor);
      second.ctx.accounts.registerAdvisor(advisor);
      first.releaseListeners();
      expect(accountAdvisorOwner()).toBe('second-ext');
    });

    it('markContinued hands the move to the recorder, naming the extension', async () => {
      const recorder = vi.fn().mockResolvedValue(undefined);
      setContinuationRecorder(recorder);
      const to = { sessionId: 'new', runtime: 'claude-code', accountId: 'client' };
      await buildCtx().ctx.accounts.markContinued('old', to);
      expect(recorder).toHaveBeenCalledWith(extensionId, 'old', to);
    });

    it('markContinued refuses a malformed call, and refuses while nothing records moves', async () => {
      const { ctx } = buildCtx();
      await expect(
        ctx.accounts.markContinued('old', { sessionId: '', runtime: 'x', accountId: 'y' })
      ).rejects.toThrow(TypeError);
      await expect(
        ctx.accounts.markContinued('old', { sessionId: 'n', runtime: 'x', accountId: 'y' })
      ).rejects.toThrow(CONTINUATION_UNAVAILABLE_MESSAGE);
    });
  });

  describe("the default account's chosen color reaches ctx.accounts.list (DOR-2492)", () => {
    const stores: AccountUsageStore[] = [];

    afterEach(async () => {
      setAccountUsageStore(undefined);
      for (const store of stores.splice(0)) {
        store.stop();
        await store.flush();
      }
    });

    /** A real usage store over a real config file, as the server builds it. */
    async function loadStore(claudeCode: Record<string, unknown>): Promise<AccountUsageStore> {
      const home = path.join(tmpDir, 'home');
      await fs.mkdir(path.join(home, '.claude'), { recursive: true });
      const configPath = path.join(tmpDir, 'config.json');
      await fs.writeFile(configPath, JSON.stringify({ runtimes: { claudeCode } }));
      const store = new AccountUsageStore({
        dorkHome: tmpDir,
        readConfig: () => readConfigFile(configPath),
        resolveDefaultRoot: (runtime, config) => defaultAccountFolder(runtime, config, home),
        timings: { scanIntervalMs: 3_600_000 },
      });
      stores.push(store);
      await store.load();
      setAccountUsageStore(store);
      return store;
    }

    const claudeDefault = async () =>
      (await buildCtx().ctx.accounts.list()).find(
        (a) => a.runtime === 'claude-code' && a.id === 'default'
      );

    it('lists the standalone default in the color the operator chose', async () => {
      await loadStore({ defaultAccount: null, accounts: [], defaultAccountColor: '#0d9488' });
      expect(await claudeDefault()).toEqual({
        runtime: 'claude-code',
        id: 'default',
        label: DEFAULT_ACCOUNT_LABEL,
        color: '#0d9488',
        implicit: true,
      });
    });

    it('lists it in its positional color when none is chosen', async () => {
      await loadStore({ defaultAccount: null, accounts: [], defaultAccountColor: null });
      expect((await claudeDefault())?.color).toBe(DEFAULT_ACCOUNT_COLORS[0]);
    });
  });

  describe('projects', () => {
    it('scopes list, resolve and report to the calling extension', async () => {
      const list = vi.spyOn(projectRegistry, 'listForExtension').mockResolvedValue([]);
      const report = vi.spyOn(projectRegistry, 'report').mockResolvedValue(null);
      const resolve = vi.spyOn(projectRegistry, 'resolveWithin').mockResolvedValue('outside');
      const { ctx } = buildCtx();
      await ctx.projects.list();
      await ctx.projects.report('/some/repo');
      await ctx.projects.resolve('/some/repo/src');
      expect(list).toHaveBeenCalledWith(extensionId);
      expect(report).toHaveBeenCalledWith('/some/repo', extensionId);
      // Resolving goes through the boundary-checked extension path, never the
      // core `resolve` that would mark a folder as seen.
      expect(resolve).toHaveBeenCalledWith('/some/repo/src', extensionId);
      // Refused by the boundary reads as no project to the extension.
      await expect(ctx.projects.resolve('/some/repo/src')).resolves.toBeNull();
      await expect(ctx.projects.report('')).resolves.toBeNull();
      list.mockRestore();
      report.mockRestore();
      resolve.mockRestore();
    });

    it('answers null, never a raw storage error, when recording a project fails', async () => {
      const report = vi
        .spyOn(projectRegistry, 'report')
        .mockRejectedValue(new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed'));
      const resolve = vi
        .spyOn(projectRegistry, 'resolveWithin')
        .mockRejectedValue(new Error('SQLITE_FULL'));
      const { ctx } = buildCtx();
      await expect(ctx.projects.report('/some/repo')).resolves.toBeNull();
      await expect(ctx.projects.resolve('/some/repo')).resolves.toBeNull();
      report.mockRestore();
      resolve.mockRestore();
    });

    it('removes its change listeners on release, and refuses new ones after', () => {
      // The registry's own listener set: the thing a leak would grow.
      const registered = (projectRegistry as unknown as { listeners: Set<() => void> }).listeners;
      const before = registered.size;
      const { ctx, releaseListeners } = buildCtx();
      ctx.projects.onChange(vi.fn());
      const stop = ctx.projects.onChange(vi.fn());
      expect(registered.size).toBe(before + 2);
      stop();
      expect(registered.size).toBe(before + 1);
      releaseListeners();
      expect(registered.size).toBe(before);
      expect(() => ctx.projects.onChange(vi.fn())).toThrow(/shut down or reloaded/);
      expect(registered.size).toBe(before);
    });
  });

  describe('agent (ctx.agent.send, DOR-2683)', () => {
    afterEach(() => setAgentSendService(undefined));

    it('sends as this extension, and removes its listeners when it shuts down', async () => {
      const remove = vi.fn();
      const send = vi.fn(async () => ({ messageId: 'm', status: 'started', sessionId: 's' }));
      const subscribe = vi.fn(() => remove);
      setAgentSendService({ send, subscribe } as unknown as AgentSendService);
      const { ctx, releaseListeners } = buildCtx();
      const input = { to: 's', text: 't', idempotencyKey: 'k' };

      await expect(ctx.agent.send(input)).resolves.toMatchObject({ messageId: 'm' });
      expect(send).toHaveBeenCalledWith(extensionId, input);
      ctx.agent.subscribe(() => undefined);
      expect(subscribe).toHaveBeenCalledWith(extensionId, expect.any(Function));

      releaseListeners();
      expect(remove).toHaveBeenCalledTimes(1);
      // A late call from the old instance starts nothing.
      await expect(ctx.agent.send(input)).rejects.toMatchObject({ code: 'stopped' });
      expect(() => ctx.agent.subscribe(() => undefined)).toThrow(/shut down or reloaded/);
    });

    it.each([false, undefined])(
      'manual agent unsubscribe failure %s remains owned by disposal',
      (cause) => {
        const removers = [
          vi.fn(() => {
            throw cause;
          }),
          vi.fn(),
        ];
        let entered = 0;
        const subscribe = vi.fn(() => removers[entered++]);
        setAgentSendService({ subscribe } as unknown as AgentSendService);
        const built = buildCtx();
        const unsubscribe = built.ctx.agent.subscribe(vi.fn());
        built.ctx.agent.subscribe(vi.fn());
        const capture = (cleanup: () => void): { value: unknown } => {
          try {
            cleanup();
          } catch (value) {
            return { value };
          }
          throw new Error('original failure was lost');
        };
        expect(capture(unsubscribe).value).toBe(cause);
        expect(capture(built.dispose).value).toBe(cause);
        expect(removers[0]).toHaveBeenCalledTimes(1);
        expect(removers[1]).toHaveBeenCalledTimes(1);
        expect(capture(built.dispose).value).toBe(cause);
        expect(removers[0]).toHaveBeenCalledTimes(1);
      }
    );

    it('says plainly when DorkOS cannot send yet', async () => {
      const { ctx } = buildCtx();
      await expect(
        ctx.agent.send({ to: 's', text: 't', idempotencyKey: 'k' })
      ).rejects.toMatchObject({ code: 'unavailable' });
    });
  });

  describe('private registration recovery copy', () => {
    it.each([false, true])(
      'keeps isolated reload copy separate from in-process UNKNOWN, restart=%s',
      async (restart) => {
        const built = createDataProviderContext({
          extensionId,
          extensionDir,
          dorkHome: tmpDir,
          ...(restart ? { registrationRecovery: 'restart-app' as const } : {}),
        });
        built.dispose();
        const { logger } = await import('../../../lib/logger.js');
        built.ctx.schedule(60, async () => undefined);
        expect(logger.warn).toHaveBeenCalledWith(
          `[ext:${extensionId}] ctx.schedule was called after DorkOS stopped waiting for this extension to start; it does nothing. ` +
            (restart
              ? 'Restart the DorkOS app before trying again.'
              : 'Reload the extension to try again.')
        );
        await expect(
          built.ctx.sessions.start({ project: '/repos/x', prompt: 'p', title: 't', reason: 'r' })
        ).rejects.toThrow(
          restart ? 'Restart the DorkOS app before trying again.' : 'Reload it to try again.'
        );
      }
    );
  });

  describe('original scheduled cancellation custody', () => {
    it('manual cancellation then disposal enters original clearInterval once', () => {
      vi.useFakeTimers();
      const clear = vi.spyOn(globalThis, 'clearInterval');
      let built: ReturnType<typeof buildCtx> | undefined;
      try {
        built = buildCtx();
        const cancel = built.ctx.schedule(60, async () => undefined);
        expect(built.getScheduledCleanups()[0]).toBe(cancel);
        cancel();
        built.dispose();
        cancel();
        expect(clear).toHaveBeenCalledTimes(1);
      } finally {
        try {
          built?.dispose();
        } finally {
          clear.mockRestore();
          vi.useRealTimers();
        }
      }
    });

    it.each([false, undefined])(
      'failed manual cancellation %s stays owned and siblings are attempted',
      (cause) => {
        vi.useFakeTimers();
        const originalClear = globalThis.clearInterval;
        const clear = vi.spyOn(globalThis, 'clearInterval');
        let count = 0;
        clear.mockImplementation((timer) => {
          originalClear(timer);
          if (++count === 1) throw cause;
        });
        let built: ReturnType<typeof buildCtx> | undefined;
        const capture = (cleanup: () => void): { value: unknown } => {
          try {
            cleanup();
          } catch (value) {
            return { value };
          }
          throw new Error('original failure was lost');
        };
        try {
          built = buildCtx();
          const cancel = built.ctx.schedule(60, async () => undefined);
          built.ctx.schedule(60, async () => undefined);
          expect(capture(cancel).value).toBe(cause);
          expect(clear).toHaveBeenCalledTimes(1);
          expect(capture(built.dispose).value).toBe(cause);
          expect(clear).toHaveBeenCalledTimes(2);
          expect(capture(built.dispose).value).toBe(cause);
          expect(capture(cancel).value).toBe(cause);
          expect(clear).toHaveBeenCalledTimes(2);
        } finally {
          // Both original fake timers were cleared before the first throw.
          try {
            built?.dispose();
          } catch {
            /* Preserve the original asserted failure. */
          }
          clear.mockRestore();
          vi.useRealTimers();
        }
      }
    );
  });

  describe('dispose (a register() DorkOS stopped waiting for, DOR-2527 R3)', () => {
    it('cancels what it scheduled, and makes every later schedule or listener a logged no-op', async () => {
      vi.useFakeTimers();
      try {
        const { ctx, dispose, getScheduledCleanups } = buildCtx();
        const before = vi.fn(async () => undefined);
        ctx.schedule(60, before);
        dispose();
        const { logger } = await import('../../../lib/logger.js');

        // The hung register() finishes later and tries to start things.
        const after = vi.fn(async () => undefined);
        const cancel = ctx.schedule(60, after);
        const offProjects = ctx.projects?.onChange(() => undefined);
        const offInbox = ctx.inbox?.onAction(async () => ({ resolve: 'answered' as const }));
        const offUsage = ctx.accounts?.onUsage(() => undefined);
        vi.advanceTimersByTime(10 * 60_000);

        expect(before).not.toHaveBeenCalled();
        expect(after).not.toHaveBeenCalled();
        expect(getScheduledCleanups()).toEqual([]);
        expect(() => {
          cancel();
          offProjects?.();
          offInbox?.();
          offUsage?.();
        }).not.toThrow();
        // Said once, not once per call.
        expect(
          vi
            .mocked(logger.warn)
            .mock.calls.filter(([msg]) => String(msg).includes('stopped waiting'))
        ).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('sends no agent message once disposed, and listens to nothing (DOR-2683)', async () => {
      const send = vi.fn();
      const subscribe = vi.fn(() => () => undefined);
      setAgentSendService({ send, subscribe } as unknown as AgentSendService);
      try {
        const { ctx, dispose } = buildCtx();
        dispose();
        await expect(
          ctx.agent.send({ to: 's', text: 't', idempotencyKey: 'k' })
        ).rejects.toMatchObject({ code: 'stopped' });
        expect(() => ctx.agent.subscribe(() => undefined)()).not.toThrow();
        expect(send).not.toHaveBeenCalled();
        expect(subscribe).not.toHaveBeenCalled();
      } finally {
        setAgentSendService(undefined);
      }
    });

    it('starts no chat once disposed (spec flow-multiproject §7.7)', async () => {
      const start = vi.fn(async () => ({ sessionId: 'never' }));
      setStartWorkService({ start } as unknown as StartWorkService);
      try {
        const { ctx, dispose } = buildCtx();
        dispose();
        await expect(
          ctx.sessions.start({ project: '/repos/x', prompt: 'p', title: 't', reason: 'r' })
        ).rejects.toThrow(/stopped before it finished starting/);
        expect(start).not.toHaveBeenCalled();
      } finally {
        setStartWorkService(undefined);
      }
    });
  });
  it.each([false, undefined])(
    'does not heal the original private currentness failure %s',
    async (value) => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'context-refusal-'));
      const requireCurrent = vi.fn().mockImplementationOnce(() => {
        throw value;
      });
      const built = createDataProviderContext({
        extensionId: 'owned',
        extensionDir: home,
        dorkHome: home,
        requireCurrent,
      });
      try {
        const first = await built.ctx.storage.saveData({ refused: true }).then(
          () => ({ ok: true }),
          (cause) => ({ value: cause })
        );
        const second = await built.ctx.projects.list().then(
          () => ({ ok: true }),
          (cause) => ({ value: cause })
        );
        expect(first).toEqual({ value });
        expect(second).toEqual({ value });
        expect(requireCurrent).toHaveBeenCalledTimes(1);
        await expect(
          fs.stat(path.join(home, 'extension-data/owned/data.json'))
        ).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        built.dispose();
        await fs.rm(home, { recursive: true, force: true });
      }
    }
  );
});
