import { extensionId, buildCtx, st } from './harness.js';
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { setAgentSendService, type AgentSendService } from '../../agent-send/agent-send.js';
import { projectRegistry } from '../../../projects/project-registry.js';
import { setAccountUsageStore } from '../../../core/usage/current-usage-store.js';
import { AccountUsageStore } from '../../../core/usage/account-usage-store.js';
import { readConfigFile } from '../../../core/usage/account-usage-reconcile.js';
import {
  DEFAULT_ACCOUNT_LABEL,
  defaultAccountFolder,
} from '../../../core/usage/runtime-accounts.js';
import { setStartWorkService } from '../../start-work.js';
import { type StartWorkService } from '../../start-work.js';

describe('createDataProviderContext', () => {
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
      const home = path.join(st.tmpDir, 'home');
      await fs.mkdir(path.join(home, '.claude'), { recursive: true });
      const configPath = path.join(st.tmpDir, 'config.json');
      await fs.writeFile(configPath, JSON.stringify({ runtimes: { claudeCode } }));
      const store = new AccountUsageStore({
        dorkHome: st.tmpDir,
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
  });

  describe('dispose (a register() DorkOS stopped waiting for, DOR-2527 R3)', () => {
    it('cancels what it scheduled, and makes every later schedule or listener a logged no-op', async () => {
      vi.useFakeTimers();
      try {
        const { ctx, dispose, getScheduledCleanups } = buildCtx();
        const before = vi.fn(async () => undefined);
        ctx.schedule(60, before);
        dispose();
        const { logger } = await import('../../../../lib/logger.js');

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

    it('also cancels a timer started after the cleanups list was copied (DOR-2462)', () => {
      vi.useFakeTimers();
      try {
        const { ctx, dispose, getScheduledCleanups } = buildCtx();
        // What the lifecycle stores when register() returns: a copy.
        const copied = getScheduledCleanups();
        const later = vi.fn(async () => undefined);
        ctx.schedule(60, later);
        for (const cancel of copied) cancel();
        dispose();
        vi.advanceTimersByTime(10 * 60_000);

        expect(copied).toHaveLength(0);
        expect(later).not.toHaveBeenCalled();
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
});
