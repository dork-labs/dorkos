import { extensionId, extensionDir, buildCtx, st } from './harness.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { type AccountUsage } from '@dorkos/shared/account-usage';
import {
  createDataProviderContext,
  INBOX_NOT_ALLOWED,
  INBOX_NOT_DECLARED,
} from '../../extension-server-api-factory.js';
import type { InboxApi } from '@dorkos/extension-api/server';
import { recordContextDeps } from '../../server-bundle/extension-context-deps.js';
import {
  __resetAccountAdvisorForTests,
  accountAdvisorOwner,
  hasAccountAdvisor,
} from '../../../core/usage/account-advisor.js';
import { setAccountUsageStore } from '../../../core/usage/current-usage-store.js';
import { AccountUsageStore } from '../../../core/usage/account-usage-store.js';
import { setContinuationRecorder } from '../../../core/usage/session-continuation.js';

describe('createDataProviderContext', () => {
  describe('inbox and the places a manifest declares (DOR-4282)', () => {
    /**
     * A plain inbox standing in for DorkOS's own: it answers with real values
     * and keeps the one handler, so a test can send a person's answer to it.
     */
    function stubInbox() {
      const decision = { id: 'd1', key: 'k', title: 'Approve?', why: 'Because.' };
      let handler: Parameters<InboxApi['onAction']>[0] | null = null;
      const inbox: InboxApi = {
        raise: async () => decision as never,
        resolve: async () => true,
        record: async () => undefined,
        list: async () => [decision as never],
        onAction: (next) => {
          handler = next;
          return () => {
            handler = null;
          };
        },
      };
      /** Send an answer to this app, the way the Inbox does; null when nothing listens. */
      const answer = async () =>
        handler
          ? handler({ key: 'k', action: 'approve', choiceId: null, decidedBy: 'person' } as never)
          : null;
      return { inbox, decision, answer };
    }

    it('refuses every inbox call for an app that does not declare Inbox cards', async () => {
      const stub = stubInbox();
      const { ctx } = createDataProviderContext({
        extensionId,
        extensionDir,
        dorkHome: st.tmpDir,
        contributions: { pages: true },
        allowedPlaces: () => ['inbox', 'pages'],
        inbox: stub.inbox,
      });
      await expect(ctx.inbox.list()).rejects.toThrow(INBOX_NOT_DECLARED);
      await expect(
        ctx.inbox.raise({ key: 'k', title: 'Approve?', why: 'Because.' } as never)
      ).rejects.toThrow(INBOX_NOT_DECLARED);
      await expect(ctx.inbox.record({ title: 'Done' } as never)).rejects.toThrow(
        INBOX_NOT_DECLARED
      );
      await expect(ctx.inbox.resolve('k', { outcome: 'approved' } as never)).rejects.toThrow(
        INBOX_NOT_DECLARED
      );
    });

    it('refuses every inbox call for a ctx built with no map at all (fail-closed)', async () => {
      const stub = stubInbox();
      const { ctx } = createDataProviderContext({
        extensionId,
        extensionDir,
        dorkHome: st.tmpDir,
        inbox: stub.inbox,
      });
      await expect(ctx.inbox.list()).rejects.toThrow(INBOX_NOT_DECLARED);
      const handler = vi.fn(async () => ({ resolve: 'answered' as const }));
      expect(() => ctx.inbox.onAction(handler)).not.toThrow();
      expect(await stub.answer()).toBeNull();
      expect(handler).not.toHaveBeenCalled();
    });

    // Purpose: a declared inbox the person has not allowed gets no data, while
    // the rest of the app keeps running; a yes given later works at once.
    it('refuses a declared inbox until a person allows it, then lets it through', async () => {
      let allowed: string[] = ['pages'];
      const stub = stubInbox();
      const { ctx } = createDataProviderContext({
        extensionId,
        extensionDir,
        dorkHome: st.tmpDir,
        contributions: { inbox: true, pages: true },
        allowedPlaces: () => allowed,
        inbox: stub.inbox,
      });
      await expect(ctx.inbox.list()).rejects.toThrow(INBOX_NOT_ALLOWED);
      await expect(
        ctx.inbox.raise({ key: 'k', title: 'Approve?', why: 'Because.' } as never)
      ).rejects.toThrow(INBOX_NOT_ALLOWED);
      await expect(ctx.inbox.record({ title: 'Done' } as never)).rejects.toThrow(INBOX_NOT_ALLOWED);
      await expect(ctx.inbox.resolve('k', { outcome: 'approved' } as never)).rejects.toThrow(
        INBOX_NOT_ALLOWED
      );
      // Its handler is kept, so starting never fails on the wait, but it
      // hears nothing until the person says yes.
      const handler = vi.fn(async () => ({ resolve: 'answered' as const }));
      expect(() => ctx.inbox.onAction(handler)).not.toThrow();
      expect(await stub.answer()).toEqual({ keepOpen: true });
      expect(handler).not.toHaveBeenCalled();

      allowed = ['inbox', 'pages'];
      await expect(ctx.inbox.list()).resolves.toEqual([stub.decision]);
      expect(await stub.answer()).toEqual({ resolve: 'answered' });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('refuses a declared inbox for a ctx built with no allowed places (fail-closed)', async () => {
      const stub = stubInbox();
      const { ctx } = createDataProviderContext({
        extensionId,
        extensionDir,
        dorkHome: st.tmpDir,
        contributions: { inbox: true },
        inbox: stub.inbox,
      });
      await expect(ctx.inbox.list()).rejects.toThrow(INBOX_NOT_ALLOWED);
    });

    /** A copy installed from a plugin, approved by a person for these files. */
    function notesRecord(contributions?: Record<string, boolean>) {
      return {
        id: 'notes',
        origin: 'user' as const,
        path: '/ext/notes',
        runPath: '/snap/notes',
        currentDigest: 'sha256:aaa',
        manifest: { id: 'notes', name: 'Notes', version: '1.0.0', contributions },
      } as unknown as Parameters<typeof recordContextDeps>[1];
    }
    const approvedFor = (slots?: string[]) => () => ({
      approvedToRun: ['notes'],
      approvedSources: { notes: { path: '/ext/notes', digest: 'sha256:aaa' } },
      approvedPermissions: {
        notes: { runtime: 'in-process' as const, net: [], run: [], agents: false, slots },
      },
    });

    // Purpose: the server reads the allowed places from the stored yes, never
    // from the manifest alone, so a newly declared inbox waits.
    it('allows Inbox cards only once the stored approval names them', () => {
      const declared = notesRecord({ inbox: true, 'right-panel': true });
      const before = recordContextDeps('notes', declared, st.tmpDir, approvedFor(['right-panel']));
      expect(before.allowedPlaces?.()).toEqual(['right-panel']);
      const after = recordContextDeps(
        'notes',
        declared,
        st.tmpDir,
        approvedFor(['inbox', 'right-panel'])
      );
      expect(after.allowedPlaces?.()).toEqual(['right-panel', 'inbox']);
    });
  });

  describe('filesDir', () => {
    // Purpose: one writable folder per extension at the documented place,
    // existing before register() could use it (DOR-2686 task 4.2).
    it('is {dorkHome}/extension-data/<id>/files and exists once the ctx is built', async () => {
      const { ctx } = buildCtx();
      expect(ctx.filesDir).toBe(path.join(st.tmpDir, 'extension-data', extensionId, 'files'));
      const stat = await fs.stat(ctx.filesDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('secrets', () => {
    it('can round-trip a secret value', async () => {
      const { ctx } = buildCtx();
      await ctx.secrets.set('api-key', 'sk-12345');
      const value = await ctx.secrets.get('api-key');
      expect(value).toBe('sk-12345');
    });
  });

  describe('storage.saveData', () => {
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
  });

  describe('getScheduledCleanups', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
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
  });
});
