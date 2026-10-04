/**
 * The ctx conformance suite (DOR-2686 task 4.4) against both runtimes, with
 * the same fixture extension: in-process (the real ctx, in this process) and
 * isolated (a real forked child with the real flags, whose proxy ctx crosses
 * to this process's real ctx through the host dispatcher). Then the cases
 * only a child can have: a crash releases everything it registered, and a
 * hostile child writing raw messages reaches nothing the protocol refuses.
 */
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as extensionServerApi from '@dorkos/extension-api/server';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import { createDataProviderContext } from '../../extension-server-api-factory.js';
import { describeCtxConformance, type CtxUnderTest } from '../../__tests__/ctx-conformance.js';
import { setAccountUsageStore } from '../../../core/usage/current-usage-store.js';
import type { AccountUsageStore } from '../../../core/usage/account-usage-store.js';
import {
  __resetAccountAdvisorForTests,
  accountAdvisorOwner,
} from '../../../core/usage/account-advisor.js';
import { setAgentSendService, type AgentSendService } from '../../agent-send/agent-send.js';
import { createInboxFixture, type InboxFixture } from '../../inbox/__tests__/inbox-fixture.js';
import { CTX_BUNDLE_SOURCE } from './fixtures/ctx-bundle.js';
import { cleanup, createHarness, makeHost, startOk, type Harness } from './isolation-harness.js';

const nodeRequire = createRequire(import.meta.url);

/** Evaluate the fixture source in this process, as the in-process host would load it. */
function loadInProcess(): {
  register: (router: unknown, ctx: unknown) => unknown;
  probes: Record<string, (...args: unknown[]) => unknown>;
} {
  const injected = (name: string) =>
    name === '@dorkos/extension-api/server' ? extensionServerApi : nodeRequire(name);
  const fn = vm.compileFunction(CTX_BUNDLE_SOURCE, ['exports', 'require', 'module']);
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  fn(mod.exports, injected, mod);
  const register = mod.exports as unknown as (router: unknown, ctx: unknown) => unknown;
  return {
    register,
    probes: (register as unknown as { probes: Record<string, (...args: unknown[]) => unknown> })
      .probes,
  };
}

let h: Harness;
let bundlePath: string;

beforeEach(async () => {
  h = await createHarness();
  bundlePath = path.join(h.tmp, 'bundles', 'ctx.js');
  await fs.writeFile(bundlePath, CTX_BUNDLE_SOURCE);
});

afterEach(async () => {
  await cleanup(h);
});

/** Start the fixture isolated, with its host holding a real ctx. */
async function startIsolated(extensionId: string, allowAgents: boolean) {
  const built = createDataProviderContext({
    extensionId,
    extensionDir: path.join(h.tmp, 'ext', extensionId),
    dorkHome: h.dorkHome,
    extensionName: 'Conformance',
  });
  const host = makeHost(h, {
    id: extensionId,
    bundle: bundlePath,
    overrides: {
      ctx: built.ctx,
      isolation: {
        runtime: 'subprocess',
        net: [],
        run: [],
        resolvedRun: [],
        agents: allowAgents,
        memoryMb: 256,
      },
    },
  });
  await startOk(host);
  return { host, built };
}

describeCtxConformance('in-process', () => ({
  dorkHome: () => h.dorkHome,
  async start({ extensionId }) {
    const built = createDataProviderContext({
      extensionId,
      extensionDir: path.join(h.tmp, 'ext', extensionId),
      dorkHome: h.dorkHome,
      extensionName: 'Conformance',
    });
    const fixture = loadInProcess();
    const cleanupFn = (await fixture.register({}, built.ctx)) as (() => void) | undefined;
    let stopped = false;
    const t: CtxUnderTest = {
      runtime: 'in-process',
      extensionId,
      probe: async <T>(name: string, ...args: unknown[]) =>
        (await fixture.probes[name]!(...args)) as T,
      // The lifecycle's shutdown order: cleanup, scheduled cancels, listeners.
      async stop() {
        if (stopped) return;
        stopped = true;
        cleanupFn?.();
        for (const cancel of built.getScheduledCleanups()) cancel();
        built.releaseListeners();
      },
      dispatched: () => null,
    };
    return t;
  },
}));

describeCtxConformance('isolated', () => ({
  dorkHome: () => h.dorkHome,
  async start({ extensionId, allowAgents }) {
    const { host } = await startIsolated(extensionId, allowAgents);
    const t: CtxUnderTest = {
      runtime: 'isolated',
      extensionId,
      probe: async <T>(name: string, ...args: unknown[]) => (await host.probe(name, ...args)) as T,
      // Only the child stops: no releaseListeners here, so the suite proves
      // the dispatcher itself releases what the child registered.
      stop: () => host.stop(),
      crash: async () => {
        host.killNow();
        const began = Date.now();
        while (host.running && Date.now() - began < 3_000) {
          await new Promise((r) => setTimeout(r, 20));
        }
      },
      dispatched: (member) => host.ctxDispatchCounts()[member] ?? 0,
    };
    return t;
  },
}));

describe('ctx over the boundary: what only a child can do', () => {
  let fx: InboxFixture;
  let usageListeners: Set<(u: AccountUsage) => void>;
  let agentSends: number;

  beforeEach(() => {
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
    agentSends = 0;
    setAgentSendService({
      send: async () => {
        agentSends++;
        return { messageId: 'm' };
      },
      subscribe: () => () => undefined,
    } as unknown as AgentSendService);
  });

  afterEach(() => {
    setAccountUsageStore(undefined);
    setAgentSendService(undefined);
    __resetAccountAdvisorForTests();
    fx.inbox.stop();
    fx.close();
  });

  // Purpose: a child that dies (killed, not stopped) leaves nothing on the
  // host: its usage listener, its advisor and its inbox handler are gone, and
  // the host's own release was never called.
  it('releases every registration when the child is killed', async () => {
    const { host } = await startIsolated('crashy', false);
    fx.inbox.markRunning('crashy', 'Crashy');
    await host.probe('subscribe', 'accounts.onUsage');
    await host.probe('advisor', 0);
    await host.probe('onAction', 0);
    const raised = (await host.probe('call', 'inbox.raise', [
      {
        key: 'k',
        title: 'T?',
        why: 'Because.',
        actions: { kind: 'yes-no', approveLabel: 'Yes', rejectLabel: 'No' },
      },
    ])) as { value: { id: string } };
    expect(usageListeners.size).toBe(1);
    expect(accountAdvisorOwner()).toBe('crashy');
    expect(host.ctxRegistrations).toBe(3);

    host.killNow();
    const began = Date.now();
    while (host.running && Date.now() - began < 3_000) await new Promise((r) => setTimeout(r, 20));

    expect(host.running).toBe(false);
    expect(usageListeners.size).toBe(0);
    expect(accountAdvisorOwner()).toBeUndefined();
    expect(host.ctxRegistrations).toBe(0);
    const answer = await fx.inbox.answer(
      raised.value.id,
      { action: 'approve' },
      { kind: 'person' }
    );
    expect(answer).toMatchObject({ ok: false, status: 409 });
  });

  // Purpose: a hostile extension writing raw messages around its proxy gets
  // refusals, never a host capability: an unlisted method, a prototype key,
  // a kind mismatch, a gated call without the grant, a __proto__ argument.
  // The legitimate control on the same channel succeeds.
  it('refuses raw messages outside the protocol', async () => {
    const { host } = await startIsolated('hostile', false);
    const raw = (message: Record<string, unknown>) =>
      host.probe('raw', message) as Promise<{
        answered: boolean;
        ok?: boolean;
        error?: { message: string; code?: string; name?: string } | null;
        value?: unknown;
      }>;

    // The control: a raw, well-formed call works.
    await host.probe('call', 'secrets.set', ['k', 'v']);
    expect(
      await raw({ type: 'call', id: 900_001, path: 'secrets.get', args: ['k'] })
    ).toMatchObject({
      answered: true,
      ok: true,
      value: 'v',
    });

    for (const [id, path] of [
      [900_002, 'secrets.keys'],
      [900_003, 'constructor'],
      [900_004, '__proto__'],
      [900_005, 'secrets.get.constructor'],
      [900_006, 'accounts.onUsage'],
    ] as const) {
      const answer = await raw({ type: 'call', id, path, args: [] });
      expect(answer, path).toMatchObject({ answered: true, ok: false });
      expect(answer.error?.code, path).toBe('ERR_EXTENSION_CTX_UNKNOWN');
    }

    const gated = await raw({
      type: 'call',
      id: 900_010,
      path: 'agent.send',
      args: [{ to: 'a', text: 't' }],
    });
    expect(gated).toMatchObject({ answered: true, ok: false, error: { code: 'not_allowed' } });
    expect(agentSends).toBe(0);

    const polluted = await raw({
      type: 'call',
      id: 900_011,
      path: 'storage.saveData',
      args: [JSON.parse('{"__proto__": {"polluted": true}}')],
    });
    expect(polluted).toMatchObject({ answered: true, ok: false });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    const notArray = await raw({ type: 'call', id: 900_012, path: 'secrets.get', args: 'k' });
    expect(notArray).toMatchObject({ answered: true, ok: false });

    expect(host.ctxDispatchCounts()).toEqual({ 'secrets.set': 1, 'secrets.get': 1 });
  });
});
