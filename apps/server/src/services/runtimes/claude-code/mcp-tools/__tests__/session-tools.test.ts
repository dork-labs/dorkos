/**
 * `session_start` (spec `claude-account-fleet` D5): an agent starts a session,
 * optionally on a named account. Every refusal starts and writes nothing; a
 * named account needs the account policy; the mode is clamped; the launch cap
 * holds; and every started session leaves one Activity entry.
 *
 * The launch service is real here, down to the dispatcher, so what reaches the
 * turn (the account hint, the origin, the cap) is what production sends.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MeshCore } from '@dorkos/mesh';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import type { AccountAdvisor } from '@dorkos/extension-api/server';
import { USER_CONFIG_DEFAULTS, type UserConfig } from '@dorkos/shared/config-schema';
import { FakeAgentRuntime } from '@dorkos/test-utils';

const runtimes = vi.hoisted(() => new Map<string, unknown>());

vi.mock('../../../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    has: vi.fn((type: string) => runtimes.has(type)),
    get: vi.fn((type: string) => runtimes.get(type)),
    getDefaultType: vi.fn(() => 'claude-code'),
    persistSessionRuntime: vi.fn(async () => true),
    resolveForSession: vi.fn(async () => runtimes.get('claude-code')),
  },
}));
vi.mock('../../../../../lib/boundary.js', () => ({
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => {
    if (!p.startsWith('/work')) throw new Error('Access denied: path outside directory boundary');
    return p;
  }),
}));
vi.mock('../../../../core/usage-reporter.js', () => ({ reportUsageEvent: vi.fn() }));
vi.mock('../../../../workspace/room-session-place.js', () => ({
  resolveSessionCwdWithRoom: vi.fn(async (opts: { cwd?: string }) => ({
    rung: 'explicit',
    cwd: opts.cwd,
  })),
}));
vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn(async () => null) }));
vi.mock('../../../../session/session-state-projector.js', () => ({
  getOrCreateProjector: vi.fn(() => ({ cwd: undefined })),
}));
vi.mock('../../../../session/projector-persistence.js', () => ({
  persistenceModeFor: vi.fn(() => 'none'),
}));
vi.mock('../../../../observability/dispatch-buffers.js', () => ({
  recordDispatchStart: vi.fn(),
  recordDispatchEnd: vi.fn(),
}));
vi.mock('../../../../session/message-dispatcher.js', () => ({
  dispatchMessage: vi.fn(async (opts: { sessionId: string }) => ({
    accepted: true,
    canonicalId: `canon-${opts.sessionId}`,
    outcome: { kind: 'started', messageId: 'm-1' },
    queued: false,
    queuePosition: 0,
  })),
}));

import { runtimeRegistry } from '../../../../core/runtime-registry.js';
import { dispatchMessage } from '../../../../session/message-dispatcher.js';
import { setAccountUsageStore } from '../../../../core/usage/current-usage-store.js';
import type { AccountUsageStore } from '../../../../core/usage/account-usage-store.js';
import type { RuntimeAccount } from '../../../../core/usage/runtime-accounts.js';
import {
  ADVISOR_TIMEOUT_MS,
  __resetAccountAdvisorForTests,
  registerAccountAdvisor,
} from '../../../../core/usage/account-advisor.js';
import {
  ADVISOR_FAILED_REASON,
  NO_ADVISOR_REASON,
} from '../../../../core/usage/account-ranking.js';
import {
  AGENT_LAUNCH_CAP_MESSAGE,
  AGENT_LAUNCH_MAX_LIVE,
} from '../../../../session/launch/launch-session.js';
import { resolveLaunchAccountRoot } from '../../claude-config-dir.js';
import { MCP_TOOL_TIERS } from '../../../../core/mcp-tool-tiers.js';
import type { McpToolDeps } from '../types.js';
import {
  createSessionStartHandler,
  getSessionTools,
  SESSION_START_CLIENT_ID,
} from '../session-tools.js';

const AGENT_HOME = '/work/agents/scout';

/** Mesh that knows one agent. */
const mesh = {
  listWithPaths: () => [{ id: 'a1', name: 'scout', displayName: 'Scout', projectPath: AGENT_HOME }],
} as unknown as MeshCore;

function makeDeps(): McpToolDeps & { activityService: { emit: ReturnType<typeof vi.fn> } } {
  return {
    meshCore: mesh,
    activityService: { emit: vi.fn(async () => undefined) },
  } as unknown as McpToolDeps & { activityService: { emit: ReturnType<typeof vi.fn> } };
}

function account(id: string, label: string | null = id.toUpperCase()): RuntimeAccount {
  return {
    runtime: 'claude-code',
    id,
    path: `/accounts/${id}`,
    canonicalPath: `/accounts/${id}`,
    label,
    color: '#123456',
    routable: true,
    implicit: false,
    isDefault: false,
    ledgerId: id,
  };
}

function usage(a: RuntimeAccount): AccountUsage {
  return {
    runtime: 'claude-code',
    accountId: a.id,
    path: a.path ?? `/accounts/${a.id}`,
    label: a.label,
    color: a.color,
    subscriptionType: null,
    plan: null,
    credits: null,
    spend: null,
    windows: [],
    state: 'unknown',
    limit: null,
    updatedAt: null,
  };
}

/** A usage store that knows exactly these claude-code accounts. */
function installStore(accounts: RuntimeAccount[]): void {
  setAccountUsageStore({
    listAccounts: (runtime?: string) =>
      accounts.filter((a) => runtime === undefined || a.runtime === runtime),
    usageOfAccount: (a: RuntimeAccount) => usage(a),
  } as unknown as AccountUsageStore);
}

/** Register an advisor that marks `eligible` ids eligible and the rest not. */
function advise(rank: AccountAdvisor['rank']): void {
  registerAccountAdvisor('flow', { rank });
}

function allowOnly(...eligible: string[]): void {
  advise((candidates) => ({
    accounts: candidates.map((c) => ({
      id: c.id,
      eligible: eligible.includes(c.id),
      reason: eligible.includes(c.id) ? 'ok' : 'Kept for the operator',
    })),
    recommendedId: null,
  }));
}

function payloadOf(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

const BASE = { prompt: 'Fix the flaky test', cwd: '/work/project' };

let claude: FakeAgentRuntime;
let codex: FakeAgentRuntime;

beforeEach(() => {
  vi.clearAllMocks();
  __resetAccountAdvisorForTests();
  runtimes.clear();
  claude = new FakeAgentRuntime('claude-code');
  claude.getCapabilities.mockReturnValue({
    ...claude.getCapabilities(),
    supportsAccounts: true,
  });
  codex = new FakeAgentRuntime('codex');
  runtimes.set('claude-code', claude);
  runtimes.set('codex', codex);
  installStore([account('work'), account('client')]);
});

afterEach(() => {
  // Free every launch slot a test took.
  for (const [opts] of vi.mocked(dispatchMessage).mock.calls) opts.onSettled?.('ok');
  setAccountUsageStore(undefined);
  vi.useRealTimers();
});

describe('session_start', () => {
  it('starts a session with the agent-launch origin and answers with its canonical id', async () => {
    const deps = makeDeps();
    const result = await createSessionStartHandler(deps)(BASE);

    expect(result.isError).toBeUndefined();
    const body = payloadOf(result);
    expect(body).toMatchObject({ runtime: 'claude-code', account: null, status: 'started' });
    expect(String(body.sessionId)).toMatch(/^canon-/);

    expect(runtimeRegistry.persistSessionRuntime).toHaveBeenCalledWith(
      expect.any(String),
      'claude-code',
      { kind: 'agent-launch' },
      undefined
    );
    const sent = vi.mocked(dispatchMessage).mock.calls[0]![0];
    expect(sent.content).toBe(BASE.prompt);
    expect(sent.cwd).toBe('/work/project');
    expect(sent.clientId).toBe(SESSION_START_CLIENT_ID);
    // Omitted, the ladder decides: no hint rides the send.
    expect(sent.accountHint).toBeUndefined();
  });

  it("sends a named account's id as the launch hint, which the ladder resolves to its folder", async () => {
    allowOnly('work');
    const result = await createSessionStartHandler(makeDeps())({ ...BASE, account: 'work' });

    expect(payloadOf(result)).toMatchObject({ account: { id: 'work', label: 'WORK' } });
    const sent = vi.mocked(dispatchMessage).mock.calls[0]![0];
    expect(sent.accountHint).toBe('work');

    const runtimesConfig: UserConfig['runtimes'] = {
      ...USER_CONFIG_DEFAULTS.runtimes,
      claudeCode: {
        ...USER_CONFIG_DEFAULTS.runtimes.claudeCode,
        accounts: [{ id: 'work', path: '/accounts/work', label: 'WORK', color: null }],
      },
    };
    const config = {
      get: (<K extends keyof UserConfig>(key: K) =>
        key === 'runtimes' ? runtimesConfig : USER_CONFIG_DEFAULTS[key]) as <
        K extends keyof UserConfig,
      >(
        key: K
      ) => UserConfig[K],
    };
    expect(resolveLaunchAccountRoot({ hintId: sent.accountHint, config })).toBe('/accounts/work');
  });

  describe('refuses, and starts and writes nothing', () => {
    async function expectRefused(
      args: Parameters<ReturnType<typeof createSessionStartHandler>>[0]
    ) {
      const result = await createSessionStartHandler(makeDeps())(args);
      expect(result.isError).toBe(true);
      expect(dispatchMessage).not.toHaveBeenCalled();
      expect(runtimeRegistry.persistSessionRuntime).not.toHaveBeenCalled();
      expect(claude.updateSession).not.toHaveBeenCalled();
      expect(codex.updateSession).not.toHaveBeenCalled();
      return payloadOf(result);
    }

    it('an account nobody registered', async () => {
      allowOnly('work', 'client');
      expect(await expectRefused({ ...BASE, account: 'ghost', model: 'm' })).toMatchObject({
        error: 'No Claude account with id ghost is registered.',
      });
    });

    it('an account on a runtime that has none', async () => {
      allowOnly('work');
      expect(await expectRefused({ ...BASE, runtime: 'codex', account: 'work' })).toMatchObject({
        code: 'ACCOUNT_NOT_SUPPORTED',
      });
    });

    it('a folder outside the boundary', async () => {
      expect(await expectRefused({ ...BASE, cwd: '/etc' })).toMatchObject({
        code: 'OUTSIDE_BOUNDARY',
      });
    });

    it('a relative folder', async () => {
      expect(await expectRefused({ ...BASE, cwd: 'work/project' })).toMatchObject({
        code: 'INVALID_CWD',
      });
    });

    it('an agent Mesh does not know', async () => {
      expect(await expectRefused({ ...BASE, agentPath: '/work/agents/stranger' })).toMatchObject({
        code: 'INVALID_AGENT_PATH',
      });
    });

    it('a runtime that is not registered', async () => {
      expect(await expectRefused({ ...BASE, runtime: 'nope' })).toMatchObject({
        code: 'UNKNOWN_RUNTIME',
      });
    });

    it('an account the advisor marks ineligible, with its reason', async () => {
      allowOnly('work');
      expect(await expectRefused({ ...BASE, account: 'client' })).toMatchObject({
        error: 'Kept for the operator',
      });
    });

    it('an account, when the advisor throws', async () => {
      advise(() => {
        throw new Error('boom');
      });
      expect(await expectRefused({ ...BASE, account: 'work' })).toMatchObject({
        error: ADVISOR_FAILED_REASON,
      });
    });

    it('an account, when the advisor takes too long', async () => {
      vi.useFakeTimers();
      advise(() => new Promise(() => {}));
      const pending = createSessionStartHandler(makeDeps())({ ...BASE, account: 'work' });
      await vi.advanceTimersByTimeAsync(ADVISOR_TIMEOUT_MS);
      const result = await pending;
      expect(payloadOf(result)).toMatchObject({ error: ADVISOR_FAILED_REASON });
      expect(dispatchMessage).not.toHaveBeenCalled();
    });

    it('an account, when no advisor is registered', async () => {
      expect(await expectRefused({ ...BASE, account: 'work' })).toMatchObject({
        error: NO_ADVISOR_REASON,
      });
    });
  });

  it('still starts a session with no account when no advisor is registered', async () => {
    const result = await createSessionStartHandler(makeDeps())(BASE);
    expect(result.isError).toBeUndefined();
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('accepts `default` on a runtime with no accounts, and sends no hint', async () => {
    const result = await createSessionStartHandler(makeDeps())({
      ...BASE,
      runtime: 'codex',
      account: 'default',
    });
    expect(payloadOf(result)).toMatchObject({ runtime: 'codex', account: null });
    expect(vi.mocked(dispatchMessage).mock.calls[0]![0].accountHint).toBeUndefined();
  });

  it('lowers bypassPermissions to acceptEdits on the settings row, before the send', async () => {
    await createSessionStartHandler(makeDeps())({
      ...BASE,
      permissionMode: 'bypassPermissions',
      model: 'claude-opus',
      effort: 'high',
    });
    const [sessionId, settings] = claude.updateSession.mock.calls[0]!;
    expect(settings).toEqual({
      permissionMode: 'acceptEdits',
      model: 'claude-opus',
      effort: 'high',
    });
    expect(vi.mocked(dispatchMessage).mock.calls[0]![0].sessionId).toBe(sessionId);
    expect(claude.updateSession.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(dispatchMessage).mock.invocationCallOrder[0]!
    );
  });

  it('writes no permission mode when none was asked for', async () => {
    await createSessionStartHandler(makeDeps())(BASE);
    expect(claude.updateSession).not.toHaveBeenCalled();
    await createSessionStartHandler(makeDeps())({ ...BASE, model: 'claude-opus' });
    expect(claude.updateSession.mock.calls[0]![1]).toEqual({ model: 'claude-opus' });
  });

  it(`refuses the ${AGENT_LAUNCH_MAX_LIVE + 1}th live launch, and starts again once one settles`, async () => {
    const handler = createSessionStartHandler(makeDeps());
    for (let i = 0; i < AGENT_LAUNCH_MAX_LIVE; i++) {
      expect((await handler(BASE)).isError).toBeUndefined();
    }
    const refused = await handler({ ...BASE, model: 'claude-opus' });
    expect(payloadOf(refused)).toMatchObject({
      error: AGENT_LAUNCH_CAP_MESSAGE,
      code: 'LAUNCH_CAP_FULL',
    });
    expect(dispatchMessage).toHaveBeenCalledTimes(AGENT_LAUNCH_MAX_LIVE);
    // Nothing is written for the refused launch either.
    expect(claude.updateSession).not.toHaveBeenCalled();

    vi.mocked(dispatchMessage).mock.calls[0]![0].onSettled?.('ok');
    expect((await handler(BASE)).isError).toBeUndefined();
  });

  describe('the Activity entry', () => {
    it('names the calling agent, the account and the folder', async () => {
      allowOnly('work');
      const deps = makeDeps();
      await createSessionStartHandler(deps, () => ({ agentPath: AGENT_HOME }))({
        ...BASE,
        account: 'work',
      });
      expect(deps.activityService.emit).toHaveBeenCalledTimes(1);
      expect(deps.activityService.emit.mock.calls[0]![0]).toMatchObject({
        actorType: 'agent',
        actorLabel: 'Scout',
        actorId: AGENT_HOME,
        category: 'agent',
        eventType: 'agent.session_started',
        summary: 'Started a session in /work/project on the account WORK',
        metadata: { cwd: '/work/project', runtime: 'claude-code', account: 'work' },
      });
    });

    it('names the external server when there is no calling session', async () => {
      const deps = makeDeps();
      await createSessionStartHandler(deps)(BASE);
      expect(deps.activityService.emit.mock.calls[0]![0]).toMatchObject({
        actorLabel: 'external MCP',
        summary: 'Started a session in /work/project',
      });
    });

    it('is not written for a refused call', async () => {
      const deps = makeDeps();
      await createSessionStartHandler(deps)({ ...BASE, cwd: '/etc' });
      expect(deps.activityService.emit).not.toHaveBeenCalled();
    });
  });

  it('is an act-tier tool in the agents area', () => {
    expect(MCP_TOOL_TIERS.session_start).toMatchObject({
      tier: 'act',
      area: 'agents',
      title: 'Start a new agent session',
    });
    expect(getSessionTools(makeDeps()).map((t) => t.name)).toEqual(['session_start']);
  });
});
