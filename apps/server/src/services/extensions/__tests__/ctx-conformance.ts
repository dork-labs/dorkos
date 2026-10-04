/**
 * One suite of ctx behaviours, run against every runtime an extension's server
 * half can have (DOR-2686 task 4.4, spec §Testing Strategy): in-process, where
 * the extension holds the real ctx, and isolated, where it holds the proxy in
 * its own process and every call crosses to the host.
 *
 * The host side is real in both legs: `createDataProviderContext`, the secret
 * and settings stores on disk, `eventFanOut`, the account advisor, a real
 * inbox on a real database, the project registry and the project-settings
 * store. Only the account usage store and the agent-send and start-work
 * services are stand-ins (their own suites cover them), and they record the
 * extension id they were called for, which only the host can supply.
 *
 * Where the runtimes differ on purpose, the case says so and asserts each
 * side: `allow.agents` gates `agent.*` and `sessions.start` for an isolated
 * extension only, and `tools.handle` is refused for one until tools cross the
 * boundary.
 *
 * Every isolated assertion is paired with the host dispatcher's own count of
 * the member it reached (`dispatched`), so the isolated leg fails if a call
 * ever stops going through the host.
 *
 * @module services/extensions/__tests__/ctx-conformance
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSendError } from '@dorkos/extension-api/server';
import { ExtensionSecretStore } from '@dorkos/shared/extension-secrets';
import { ExtensionSettingsStore } from '@dorkos/shared/extension-settings';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import { TOOLS_REFUSAL } from '../isolation/ctx-protocol.js';
import { isolatedFilesDir, isolatedRunDir } from '../isolation/grants.js';
import { AGENTS_REFUSAL } from '../isolation/ctx-dispatcher.js';
import { setAgentSendService, type AgentSendService } from '../agent-send/agent-send.js';
import { setStartWorkService, type StartWorkService } from '../start-work.js';
import { projectRegistry } from '../../projects/project-registry.js';
import { projectSettingsStore } from '../inbox/extension-project-settings.js';
import {
  __resetAccountAdvisorForTests,
  accountAdvisorOwner,
  callAdvisor,
} from '../../core/usage/account-advisor.js';
import { setAccountUsageStore } from '../../core/usage/current-usage-store.js';
import type { AccountUsageStore } from '../../core/usage/account-usage-store.js';
import { createInboxFixture, type InboxFixture } from '../inbox/__tests__/inbox-fixture.js';

/** One started extension, in one runtime, with the conformance fixture loaded. */
export interface CtxUnderTest {
  /** Which runtime it runs in. */
  runtime: 'in-process' | 'isolated';
  /** Its extension id. */
  extensionId: string;
  /** Run one of the fixture's probes (see `fixtures/ctx-bundle.ts`). */
  probe<T = unknown>(name: string, ...args: unknown[]): Promise<T>;
  /** Stop it the way DorkOS does (cleanup, scheduled cancels, listeners). */
  stop(): Promise<void>;
  /** Kill it without asking (isolated only). */
  crash?: () => Promise<void>;
  /** How often the host dispatcher reached a member (`null` in-process). */
  dispatched(member: string): number | null;
}

/** What a runtime leg provides to the suite. */
export interface CtxRuntime {
  /** The DorkOS data directory both the host and the leg use. */
  dorkHome(): string;
  /** Start the fixture extension. */
  start(options: { extensionId: string; allowAgents: boolean }): Promise<CtxUnderTest>;
}

/** A probe's `attempt` report. */
interface Attempt<T = unknown> {
  ok: boolean;
  value?: T;
  error?: {
    name: string;
    code: string | null;
    message: string;
    limit: string | null;
    isAgentSendError: boolean;
    isInboxLimitError: boolean;
    hasStack: boolean;
  };
}

/** Wait for a condition (real timers: the isolated leg is another process). */
async function until(check: () => boolean | Promise<boolean>, ms = 3_000): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Register the conformance suite for one runtime.
 *
 * @param label - The runtime's name in test titles.
 * @param runtime - Builds that runtime's legs (called inside each test).
 */
export function describeCtxConformance(label: string, runtime: () => CtxRuntime): void {
  describe(`ctx conformance: ${label}`, () => {
    let fx: InboxFixture;
    let rt: CtxRuntime;
    let started: CtxUnderTest[] = [];
    let usageListeners: Set<(u: AccountUsage) => void>;
    let agentSend: { send: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };
    let startWork: { start: ReturnType<typeof vi.fn> };
    let ids = 0;

    const start = async (allowAgents = false): Promise<CtxUnderTest> => {
      const extensionId = `conformance-${++ids}`;
      const t = await rt.start({ extensionId, allowAgents });
      started.push(t);
      fx.inbox.markRunning(extensionId, 'Conformance');
      return t;
    };

    /** The isolated leg must have gone through the host for `member`. */
    const throughHost = (t: CtxUnderTest, member: string): void => {
      const count = t.dispatched(member);
      if (t.runtime === 'isolated') expect(count, `${member} via the host`).toBeGreaterThan(0);
      else expect(count).toBeNull();
    };

    const broadcasts = (t: CtxUnderTest, event: string) =>
      (fx.broadcast.mock.calls as unknown[][]).filter(
        (c) => c[0] === `ext:${t.extensionId}:${event}`
      );

    beforeEach(() => {
      rt = runtime();
      started = [];
      fx = createInboxFixture();
      __resetAccountAdvisorForTests();
      usageListeners = new Set();
      setAccountUsageStore({
        listAccounts: () => [],
        list: () => [],
        onChange: (listener: (u: AccountUsage) => void) => {
          usageListeners.add(listener);
          return () => usageListeners.delete(listener);
        },
      } as unknown as AccountUsageStore);
      agentSend = {
        send: vi.fn(async () => ({ messageId: 'm1', status: 'started', sessionId: 's1' })),
        subscribe: vi.fn(() => () => undefined),
      };
      setAgentSendService(agentSend as unknown as AgentSendService);
      startWork = { start: vi.fn(async () => ({ sessionId: 'started-1' })) };
      setStartWorkService(startWork as unknown as StartWorkService);
    });

    afterEach(async () => {
      for (const t of started) await t.stop().catch(() => undefined);
      setAccountUsageStore(undefined);
      setAgentSendService(undefined);
      setStartWorkService(undefined);
      __resetAccountAdvisorForTests();
      fx.inbox.stop();
      fx.close();
      vi.restoreAllMocks();
    });

    // Purpose: the const members are the host's values, and filesDir is a
    // folder the extension can write and the host reads at the same place.
    it('copies the constants, and filesDir is the same writable folder', async () => {
      const t = await start();
      const consts = await t.probe<Record<string, string>>('consts');
      const expected = isolatedFilesDir(rt.dorkHome(), t.extensionId);
      expect(consts).toMatchObject({ extensionId: t.extensionId, filesDir: expected });
      expect(consts.dorkHome).toBe(rt.dorkHome());
      if (t.runtime === 'isolated') {
        // The run folder the child reads its code and assets/ from, never
        // the extension's source folder (which it cannot read).
        expect(consts.extensionDir).toBe(
          await fs.realpath(isolatedRunDir(rt.dorkHome(), t.extensionId))
        );
      }
      const wrote = await t.probe<Attempt>('writeFile', 'note.txt', 'hello');
      expect(wrote.ok).toBe(true);
      expect(await fs.readFile(path.join(expected, 'note.txt'), 'utf8')).toBe('hello');
    });

    // Purpose: secrets round-trip, and land in the host's real store under
    // this extension's id.
    it('round-trips secrets through the real store', async () => {
      const t = await start();
      expect((await t.probe<Attempt>('call', 'secrets.set', ['token', 'sk-1'])).ok).toBe(true);
      expect((await t.probe<Attempt>('call', 'secrets.get', ['token'])).value).toBe('sk-1');
      expect((await t.probe<Attempt>('call', 'secrets.has', ['token'])).value).toBe(true);
      const host = new ExtensionSecretStore(t.extensionId, rt.dorkHome());
      expect(await host.get('token')).toBe('sk-1');
      await t.probe('call', 'secrets.delete', ['token']);
      expect((await t.probe<Attempt>('call', 'secrets.has', ['token'])).value).toBe(false);
      throughHost(t, 'secrets.set');
    });

    // Purpose: settings and storage round-trip, storage on disk where the
    // host keeps it.
    it('round-trips settings and storage', async () => {
      const t = await start();
      await t.probe('call', 'settings.set', ['mode', 'fast']);
      expect((await t.probe<Attempt>('call', 'settings.get', ['mode'])).value).toBe('fast');
      expect((await t.probe<Attempt>('call', 'settings.getAll', [])).value).toEqual({
        mode: 'fast',
      });
      await t.probe('call', 'storage.saveData', [{ count: 3, when: 'now' }]);
      expect((await t.probe<Attempt>('call', 'storage.loadData', [])).value).toEqual({
        count: 3,
        when: 'now',
      });
      const onDisk = path.join(rt.dorkHome(), 'extension-data', t.extensionId, 'data.json');
      expect(JSON.parse(await fs.readFile(onDisk, 'utf8'))).toEqual({ count: 3, when: 'now' });
      throughHost(t, 'storage.saveData');
      throughHost(t, 'settings.getAll');
    });

    // Purpose: emit reaches eventFanOut namespaced by the extension's real id.
    it('emits through eventFanOut as ext:<id>:<event>', async () => {
      const t = await start();
      await t.probe('emit', 'updated', { n: 1 });
      await until(() => broadcasts(t, 'updated').length > 0);
      expect(broadcasts(t, 'updated')[0]![1]).toEqual({ n: 1 });
      throughHost(t, 'emit');
    });

    // Purpose: accounts.onUsage hears the store's changes (without the
    // account's path), unsubscribes, and is released by stop: no listener
    // is left in the store.
    it('fires accounts.onUsage and leaves no listener after stop', async () => {
      const t = await start();
      const sub = await t.probe<Attempt<number>>('subscribe', 'accounts.onUsage');
      expect(sub.ok).toBe(true);
      await until(() => usageListeners.size === 1);
      for (const l of usageListeners) {
        l({
          runtime: 'claude-code',
          accountId: 'work',
          path: '/Users/kai/.claude',
        } as AccountUsage);
      }
      await until(async () => (await t.probe<unknown[]>('events', sub.value)).length === 1);
      expect(await t.probe('events', sub.value)).toEqual([
        [{ runtime: 'claude-code', accountId: 'work' }],
      ]);
      throughHost(t, 'accounts.onUsage');
      // An explicit unsubscribe removes it on the host…
      await t.probe('unsubscribe', sub.value);
      await until(() => usageListeners.size === 0);
      // …and stop removes one left registered.
      await t.probe('subscribe', 'accounts.onUsage');
      await until(() => usageListeners.size === 1);
      await t.stop();
      await until(() => usageListeners.size === 0);
    });

    // Purpose: the advisor's rank is answered across the boundary, and a rank
    // that sleeps 3 s falls back to the default within core's 2 s bound.
    it('answers advisor rank, and falls back within the 2 s bound', async () => {
      const t = await start();
      await t.probe('advisor', 0);
      await until(() => accountAdvisorOwner() === t.extensionId);
      const candidates = [
        {
          id: 'a',
          label: null,
          color: '#000000',
          usage: { runtime: 'claude-code', accountId: 'a' } as never,
        },
      ];
      const context = {
        purpose: 'launch' as const,
        caller: 'person' as const,
        cwd: '/',
        runtime: 'claude-code',
      };
      const ranking = await callAdvisor('rank', candidates, context);
      expect(ranking?.recommendedId).toBe('from-extension:launch');
      throughHost(t, 'accounts.registerAdvisor');

      await t.probe('advisor', 3_000);
      const began = Date.now();
      expect(await callAdvisor('rank', candidates, context)).toBeUndefined();
      const took = Date.now() - began;
      expect(took).toBeGreaterThanOrEqual(1_900);
      expect(took).toBeLessThan(2_800);
    }, 15_000);

    // Purpose: inbox.onAction's answer reaches the inbox, and a handler that
    // sleeps past 5 s is cut off by the inbox's own bound.
    it('returns the onAction answer, and the 5 s bound applies', async () => {
      const t = await start();
      await t.probe('onAction', 0);
      const raised = await t.probe<Attempt<{ id: string }>>('call', 'inbox.raise', [
        {
          key: 'ship',
          title: 'Ship it?',
          why: 'The reviewer agent found nothing.',
          actions: { kind: 'yes-no', approveLabel: 'Yes', rejectLabel: 'No' },
        },
      ]);
      expect(raised.ok).toBe(true);
      const answer = await fx.inbox.answer(
        raised.value!.id,
        { action: 'approve' },
        { kind: 'person' }
      );
      expect(answer).toMatchObject({ ok: true });
      throughHost(t, 'inbox.onAction');
      throughHost(t, 'inbox.raise');

      await t.probe('onAction', 6_000);
      const second = await t.probe<Attempt<{ id: string }>>('call', 'inbox.raise', [
        {
          key: 'slow',
          title: 'Slow?',
          why: 'It sleeps.',
          actions: { kind: 'yes-no', approveLabel: 'Yes', rejectLabel: 'No' },
        },
      ]);
      const began = Date.now();
      const slow = await fx.inbox.answer(
        second.value!.id,
        { action: 'approve' },
        { kind: 'person' }
      );
      const took = Date.now() - began;
      expect(slow).toMatchObject({ ok: false, status: 504 });
      expect(took).toBeGreaterThanOrEqual(4_900);
      expect(took).toBeLessThan(6_000);
    }, 20_000);

    // Purpose: projects.onChange and projectSettings.onChange fire, and both
    // are released by stop (no listener left in the registry or the store).
    it('fires projects.onChange and projectSettings.onChange, released on stop', async () => {
      const registry = projectRegistry as unknown as {
        listeners: Set<() => void>;
        changed(): void;
      };
      const settings = projectSettingsStore(rt.dorkHome()) as unknown as {
        listeners: Set<unknown>;
      };
      const registryBefore = registry.listeners.size;
      const settingsBefore = settings.listeners.size;
      const t = await start();
      const projects = await t.probe<Attempt<number>>('subscribe', 'projects.onChange');
      const projectSettings = await t.probe<Attempt<number>>(
        'subscribe',
        'projectSettings.onChange'
      );
      expect(projects.ok && projectSettings.ok).toBe(true);
      await until(() => registry.listeners.size === registryBefore + 1);
      await until(() => settings.listeners.size === settingsBefore + 1);
      registry.changed();
      await projectSettingsStore(rt.dorkHome()).write(
        t.extensionId,
        '/repos/x',
        { a: 1 },
        'person'
      );
      // Another extension's change is not heard.
      await projectSettingsStore(rt.dorkHome()).write(
        'someone-else',
        '/repos/y',
        { a: 1 },
        'person'
      );
      await until(async () => (await t.probe<unknown[]>('events', projects.value)).length === 1);
      await until(
        async () => (await t.probe<unknown[]>('events', projectSettings.value)).length === 1
      );
      expect(await t.probe('events', projectSettings.value)).toEqual([['/repos/x']]);
      throughHost(t, 'projects.onChange');
      throughHost(t, 'projectSettings.onChange');
      await t.stop();
      await until(() => registry.listeners.size === registryBefore);
      await until(() => settings.listeners.size === settingsBefore);
    });

    // Purpose: without allow.agents an isolated extension's agent.send and
    // sessions.start are refused at the host and reach no service; in-process
    // they are not gated (an expected difference, spec §5.4).
    it('gates agent.send and sessions.start on allow.agents (isolated only)', async () => {
      const t = await start(false);
      const send = await t.probe<Attempt>('call', 'agent.send', [{ to: 'a', text: 'hi' }]);
      const session = await t.probe<Attempt>('call', 'sessions.start', [
        { project: '/repos/x', prompt: 'go' },
      ]);
      if (t.runtime === 'isolated') {
        expect(send.error).toMatchObject({
          code: 'not_allowed',
          message: AGENTS_REFUSAL,
          isAgentSendError: true,
        });
        expect(session.error).toMatchObject({ message: AGENTS_REFUSAL });
        expect(agentSend.send).not.toHaveBeenCalled();
        expect(startWork.start).not.toHaveBeenCalled();
      } else {
        expect(send.ok).toBe(true);
        expect(session.ok).toBe(true);
      }
    });

    // Purpose: with allow.agents both go through, and the services hear the
    // extension's id as the host knows it.
    it('allows agent.send and sessions.start with allow.agents', async () => {
      const t = await start(true);
      const send = await t.probe<Attempt>('call', 'agent.send', [{ to: 'a', text: 'hi' }]);
      expect(send).toMatchObject({ ok: true, value: { messageId: 'm1' } });
      const session = await t.probe<Attempt>('call', 'sessions.start', [
        { project: '/repos/x', prompt: 'go' },
      ]);
      expect(session).toMatchObject({ ok: true, value: { sessionId: 'started-1' } });
      expect(agentSend.send).toHaveBeenCalledWith(t.extensionId, { to: 'a', text: 'hi' });
      expect(startWork.start).toHaveBeenCalledWith(
        t.extensionId,
        { project: '/repos/x', prompt: 'go' },
        'ctx'
      );
      throughHost(t, 'agent.send');
      throughHost(t, 'sessions.start');
    });

    // Purpose: an AgentSendError's class and code survive the boundary, and
    // so does an InboxLimitError's limit; neither carries a host stack.
    it('keeps error classes and codes across the boundary', async () => {
      agentSend.send.mockRejectedValueOnce(new AgentSendError('not_found', 'No such agent.'));
      const t = await start(true);
      const send = await t.probe<Attempt>('call', 'agent.send', [{ to: 'x', text: 'hi' }]);
      expect(send.error).toMatchObject({ code: 'not_found', isAgentSendError: true });
      const limit = await t.probe<Attempt>('call', 'inbox.raise', [
        {
          key: 'k',
          title: 'T',
          why: '',
          actions: { kind: 'yes-no', approveLabel: 'Yes', rejectLabel: 'No' },
        },
      ]);
      expect(limit.error).toMatchObject({
        code: 'inbox_limit',
        limit: 'why',
        isInboxLimitError: true,
      });
      if (t.runtime === 'isolated') {
        // The rebuilt error's stack is the child's own, never the host's.
        expect(limit.error?.message).not.toContain(process.cwd());
      }
    });

    // Purpose: schedule clamps to 5 s and is cancelled on stop (its ticks are
    // emits, observed on the host).
    it('clamps schedule to 5 s and cancels it on stop', async () => {
      const t = await start();
      await t.probe('schedule', 1);
      await new Promise((r) => setTimeout(r, 4_000));
      expect(broadcasts(t, 'tick')).toHaveLength(0);
      await until(() => broadcasts(t, 'tick').length >= 1, 2_500);
      await t.stop();
      // The extension's async cleanup ran to the end on stop, in either
      // runtime: both of its ctx writes landed, then its last emit arrived.
      await until(() => broadcasts(t, 'cleanup').length === 1);
      const dataPath = path.join(rt.dorkHome(), 'extension-data', t.extensionId, 'data.json');
      expect(JSON.parse(await fs.readFile(dataPath, 'utf8'))).toEqual({ cleanup: 'first' });
      expect(await new ExtensionSettingsStore(rt.dorkHome(), t.extensionId).get('cleanup')).toBe(
        'second'
      );
      const ticks = broadcasts(t, 'tick').length;
      await new Promise((r) => setTimeout(r, 5_500));
      expect(broadcasts(t, 'tick')).toHaveLength(ticks);
    }, 20_000);

    // Purpose: tools.handle is refused for an isolated extension until tools
    // cross the boundary; in-process it binds against the manifest (this
    // fixture declares none, so it is refused there for that reason).
    it('refuses tools.handle (isolated: not yet; in-process: undeclared)', async () => {
      const t = await start();
      const result = await t.probe<Attempt>('toolsHandle');
      expect(result.ok).toBe(false);
      if (t.runtime === 'isolated') expect(result.error?.message).toBe(TOOLS_REFUSAL);
      else expect(result.error?.message).toMatch(/declares no tool/);
    });
  });
}
