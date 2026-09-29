/**
 * `session_start` (spec `claude-account-fleet` D5): an agent starts a session
 * of its own, optionally on a named account. The session always runs as the
 * calling agent; every refusal starts nothing and leaves no settings row; a
 * named account needs the account policy; the mode is clamped; the launch cap
 * holds; and every started session leaves one Activity entry.
 *
 * The launch service is real here, down to the dispatcher, so what reaches the
 * turn (the account hint, the origin, the cap) is what production sends.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import type { MeshCore } from '@dorkos/mesh';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import type { AccountAdvisor } from '@dorkos/extension-api/server';
import { USER_CONFIG_DEFAULTS, type UserConfig } from '@dorkos/shared/config-schema';
import { FakeAgentRuntime } from '@dorkos/test-utils';

const runtimes = vi.hoisted(() => new Map<string, unknown>());
/** The folders the mocked boundary lets through. */
const boundaryRoots = vi.hoisted(() => ['/work']);

vi.mock('../../../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    has: vi.fn((type: string) => runtimes.has(type)),
    get: vi.fn((type: string) => runtimes.get(type)),
    getDefaultType: vi.fn(() => 'claude-code'),
    persistSessionRuntime: vi.fn(async () => true),
    resolveForSession: vi.fn(async () => runtimes.get('claude-code')),
    saveSessionSettings: vi.fn(async () => undefined),
    discardSessionSettings: vi.fn(async () => undefined),
  },
}));
vi.mock('../../../../../lib/boundary.js', () => ({
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => {
    if (!boundaryRoots.some((root) => p.startsWith(root))) {
      throw new Error('Access denied: path outside directory boundary');
    }
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
import {
  clearTestHomes,
  registerTestHomes,
} from '../../../../core/agent-identity/__tests__/agent-home-fixture.js';
import { resolveLaunchAccountRoot } from '../../claude-config-dir.js';
import { MCP_TOOL_TIERS } from '../../../../core/mcp-tool-tiers.js';
import type { McpToolDeps } from '../types.js';
import type { ToolRegistrar } from '../../../../core/mcp-tool-gate.js';
import type { AgentIdentity } from '../../../../core/agent-identity/index.js';
import { registerSessionTools } from '../../../../core/external-mcp/session-tools.js';
import {
  NOT_THE_CALLER_MESSAGE,
  OTHER_AGENTS_HOME_MESSAGE,
  SESSION_START_CLIENT_ID,
  SessionStartInputShape,
  UNKNOWN_CALLER_MESSAGE,
  createSessionStartHandler,
  getSessionTools,
} from '../session-tools.js';

const AGENT_HOME = '/work/agents/scout';
const OTHER_HOME = '/work/agents/dorkbot';
const ROOMS_DIR = '/work/rooms';

interface MeshAgent {
  id: string;
  name: string;
  displayName?: string;
  projectPath: string;
}

/** The agents Mesh lists; reset to the calling agent and one other before each test. */
let meshAgents: MeshAgent[] = [];

const mesh = { listWithPaths: () => meshAgents } as unknown as MeshCore;

type Deps = McpToolDeps & { activityService: { emit: ReturnType<typeof vi.fn> } };

function makeDeps(): Deps {
  return {
    meshCore: mesh,
    activityService: { emit: vi.fn(async () => undefined) },
  } as unknown as Deps;
}

/** The handler, called by the registered agent at {@link AGENT_HOME}. */
function asScout(deps: Deps = makeDeps()) {
  return createSessionStartHandler(deps, () => ({ agentPath: AGENT_HOME }));
}

function account(id: string, label: string | null = id.toUpperCase()): RuntimeAccount {
  return {
    runtime: 'claude-code',
    id,
    path: `/accounts/${id}`,
    canonicalPath: `/accounts/${id}`,
    label,
    color: '#123456',
    // No colour of its own: `color` above is the default for its position.
    storedColor: null,
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

function advise(rank: AccountAdvisor['rank']): void {
  registerAccountAdvisor('flow', { rank });
}

/** Register an advisor that marks `eligible` ids eligible and the rest not. */
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
  registerTestHomes([AGENT_HOME, OTHER_HOME], { roomsDir: ROOMS_DIR });
  meshAgents = [
    { id: 'a1', name: 'scout', displayName: 'Scout', projectPath: AGENT_HOME },
    { id: 'a2', name: 'dorkbot', displayName: 'DorkBot', projectPath: OTHER_HOME },
  ];
  boundaryRoots.splice(0, boundaryRoots.length, '/work');
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
  clearTestHomes();
  vi.useRealTimers();
});

describe('session_start', () => {
  it('starts a session as the calling agent, with the agent-launch origin', async () => {
    const result = await asScout()(BASE);

    expect(result.isError).toBeUndefined();
    const body = payloadOf(result);
    expect(body).toMatchObject({ runtime: 'claude-code', account: null, status: 'started' });
    expect(String(body.sessionId)).toMatch(/^canon-/);

    expect(runtimeRegistry.persistSessionRuntime).toHaveBeenCalledWith(
      expect.any(String),
      'claude-code',
      { kind: 'agent-launch' },
      AGENT_HOME
    );
    const sent = vi.mocked(dispatchMessage).mock.calls[0]![0];
    expect(sent.content).toBe(BASE.prompt);
    expect(sent.cwd).toBe('/work/project');
    expect(sent.clientId).toBe(SESSION_START_CLIENT_ID);
    // Omitted, the ladder decides: no hint rides the send.
    expect(sent.accountHint).toBeUndefined();
    expect(runtimeRegistry.discardSessionSettings).not.toHaveBeenCalled();
  });

  it("sends a named account's id as the launch hint, which the ladder resolves to its folder", async () => {
    allowOnly('work');
    const result = await asScout()({ ...BASE, account: 'work' });

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
      args: Parameters<ReturnType<typeof createSessionStartHandler>>[0],
      handler = asScout()
    ) {
      const result = await handler(args);
      expect(result.isError).toBe(true);
      expect(dispatchMessage).not.toHaveBeenCalled();
      expect(runtimeRegistry.persistSessionRuntime).not.toHaveBeenCalled();
      expect(runtimeRegistry.saveSessionSettings).not.toHaveBeenCalled();
      expect(claude.updateSession).not.toHaveBeenCalled();
      return payloadOf(result);
    }

    it('a caller with no agent identity', async () => {
      const noCaller = createSessionStartHandler(makeDeps(), () => undefined);
      expect(await expectRefused(BASE, noCaller)).toMatchObject({
        error: UNKNOWN_CALLER_MESSAGE,
        code: 'UNKNOWN_CALLER',
      });
      // The external server with no agent token passes a resolver that names nobody,
      // and a handler built with none at all refuses the same way.
      expect(await expectRefused(BASE, createSessionStartHandler(makeDeps()))).toMatchObject({
        code: 'UNKNOWN_CALLER',
      });
    });

    it('a caller Mesh has not registered', async () => {
      const stranger = createSessionStartHandler(makeDeps(), () => ({
        agentPath: '/work/agents/stranger',
      }));
      expect(await expectRefused(BASE, stranger)).toMatchObject({ code: 'UNKNOWN_CALLER' });
    });

    it('an agentPath that is another agent', async () => {
      expect(await expectRefused({ ...BASE, agentPath: OTHER_HOME })).toMatchObject({
        error: NOT_THE_CALLER_MESSAGE,
        code: 'NOT_THE_CALLER',
      });
    });

    it("another agent's home as the folder, or a folder inside it", async () => {
      for (const cwd of [OTHER_HOME, `${OTHER_HOME}/notes`]) {
        expect(await expectRefused({ ...BASE, cwd })).toMatchObject({
          error: OTHER_AGENTS_HOME_MESSAGE,
          code: 'OTHER_AGENTS_FOLDER',
        });
      }
    });

    it("a room's files as the folder, before any settings are saved", async () => {
      expect(
        await expectRefused({ ...BASE, cwd: `${ROOMS_DIR}/r1`, permissionMode: 'plan' })
      ).toMatchObject({ code: 'DESK_NOT_OWN' });
    });

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
      const pending = asScout()({ ...BASE, account: 'work' });
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

  describe("refuses a folder that is another agent's", () => {
    async function expectOtherAgentsFolder(cwd: string) {
      const result = await asScout()({ ...BASE, cwd });
      expect(payloadOf(result)).toMatchObject({ code: 'OTHER_AGENTS_FOLDER' });
      expect(runtimeRegistry.saveSessionSettings).not.toHaveBeenCalled();
      expect(dispatchMessage).not.toHaveBeenCalled();
    }

    it("another agent's managed workspace", async () => {
      // Outside every home by path; only the home resolver knows whose it is.
      const workspace = '/work/workspaces/dorkbot-fix';
      registerTestHomes([AGENT_HOME, OTHER_HOME], {
        roomsDir: ROOMS_DIR,
        managed: { [workspace]: OTHER_HOME },
      });
      await expectOtherAgentsFolder(workspace);
    });

    it("another agent's home nested inside the caller's own", async () => {
      const nested = `${AGENT_HOME}/vendor/helper`;
      registerTestHomes([AGENT_HOME, OTHER_HOME, nested], { roomsDir: ROOMS_DIR });
      meshAgents.push({ id: 'a3', name: 'helper', projectPath: nested });
      // Both homes contain the folder; the innermost one owns it.
      await expectOtherAgentsFolder(`${nested}/src`);
      // And the caller's own folders around it are still the caller's.
      expect((await asScout()({ ...BASE, cwd: `${AGENT_HOME}/vendor` })).isError).toBeUndefined();
    });

    it('a home Mesh lists through a symlink, reached by its real path', async () => {
      const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-start-')));
      try {
        fs.mkdirSync(path.join(base, 'real', 'other', 'sub'), { recursive: true });
        fs.symlinkSync(path.join(base, 'real'), path.join(base, 'link'));
        boundaryRoots.push(base);
        meshAgents.push({
          id: 'a4',
          name: 'linked',
          projectPath: path.join(base, 'link', 'other'),
        });
        // The boundary check hands `cwd` back real-pathed, as production's does.
        await expectOtherAgentsFolder(path.join(base, 'real', 'other', 'sub'));
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });
  });

  describe('on the external /mcp server', () => {
    /** Register the tool as the external server does, and return its handler. */
    function externalHandler(identity?: AgentIdentity) {
      let handler:
        | ((args: typeof BASE) => Promise<{ isError?: boolean; content: { text: string }[] }>)
        | undefined;
      const registrar = {
        registerTool: (_name: string, _config: unknown, fn: typeof handler) => {
          handler = fn;
        },
      } as unknown as ToolRegistrar;
      registerSessionTools(registrar, makeDeps(), identity);
      return handler!;
    }

    const scout: AgentIdentity = {
      agentPath: AGENT_HOME,
      displayName: 'Scout',
      createdAt: '2026-09-27T00:00:00.000Z',
    };

    it('starts a session as the agent the request token names', async () => {
      const result = await externalHandler(scout)(BASE);
      expect(result.isError).toBeUndefined();
      expect(vi.mocked(dispatchMessage).mock.calls[0]![0]).toBeDefined();
      expect(runtimeRegistry.persistSessionRuntime).toHaveBeenCalledWith(
        expect.any(String),
        'claude-code',
        { kind: 'agent-launch' },
        AGENT_HOME
      );
    });

    it('refuses a revoked or expired identity, and a request with none', async () => {
      for (const identity of [
        { ...scout, inactive: 'revoked' as const },
        { ...scout, inactive: 'expired' as const },
        undefined,
      ]) {
        const result = await externalHandler(identity)(BASE);
        expect(payloadOf(result)).toMatchObject({ code: 'UNKNOWN_CALLER' });
      }
      expect(dispatchMessage).not.toHaveBeenCalled();
    });
  });

  it('starts in its own home, and accepts its own agentPath', async () => {
    const result = await asScout()({ ...BASE, cwd: AGENT_HOME, agentPath: AGENT_HOME });
    expect(result.isError).toBeUndefined();
  });

  it('still starts a session with no account when no advisor is registered', async () => {
    const result = await asScout()(BASE);
    expect(result.isError).toBeUndefined();
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('accepts `default` on a runtime with no accounts, and sends no hint', async () => {
    const result = await asScout()({ ...BASE, runtime: 'codex', account: 'default' });
    expect(payloadOf(result)).toMatchObject({ runtime: 'codex', account: null });
    expect(vi.mocked(dispatchMessage).mock.calls[0]![0].accountHint).toBeUndefined();
  });

  it('lowers bypassPermissions to acceptEdits on the settings row, before the send', async () => {
    await asScout()({
      ...BASE,
      permissionMode: 'bypassPermissions',
      model: 'claude-opus',
      effort: 'high',
    });
    const save = vi.mocked(runtimeRegistry.saveSessionSettings);
    const [sessionId, settings] = save.mock.calls[0]!;
    expect(settings).toEqual({
      permissionMode: 'acceptEdits',
      model: 'claude-opus',
      effort: 'high',
    });
    expect(vi.mocked(dispatchMessage).mock.calls[0]![0].sessionId).toBe(sessionId);
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(dispatchMessage).mock.invocationCallOrder[0]!
    );
    // Only the row: no runtime is handed an in-memory session for the new id.
    expect(claude.updateSession).not.toHaveBeenCalled();
  });

  it('clamps in the input schema, so the approval card shows the mode it grants', () => {
    const schema = z.object(SessionStartInputShape);
    expect(schema.parse({ ...BASE, permissionMode: 'bypassPermissions' }).permissionMode).toBe(
      'acceptEdits'
    );
    expect(schema.parse({ ...BASE, permissionMode: 'plan' }).permissionMode).toBe('plan');
  });

  it('writes no permission mode when none was asked for', async () => {
    await asScout()({ ...BASE, model: 'claude-opus' });
    expect(vi.mocked(runtimeRegistry.saveSessionSettings).mock.calls[0]![1]).toEqual({
      model: 'claude-opus',
    });
  });

  describe('removes the settings row of a launch that did not start', () => {
    it('when the launch throws', async () => {
      vi.mocked(dispatchMessage).mockRejectedValueOnce(new Error('spawn failed'));
      await expect(asScout()({ ...BASE, model: 'claude-opus' })).rejects.toThrow('spawn failed');
      const [sessionId] = vi.mocked(runtimeRegistry.saveSessionSettings).mock.calls[0]!;
      expect(runtimeRegistry.discardSessionSettings).toHaveBeenCalledWith(sessionId);
    });

    it('when the launch is not accepted', async () => {
      vi.mocked(dispatchMessage).mockResolvedValueOnce({
        accepted: false,
        outcome: { kind: 'started', messageId: 'm' },
        queued: false,
        queuePosition: 0,
      } as never);
      const result = await asScout()(BASE);
      expect(payloadOf(result)).toMatchObject({ code: 'NOT_STARTED' });
      const [sessionId] = vi.mocked(runtimeRegistry.saveSessionSettings).mock.calls[0]!;
      expect(runtimeRegistry.discardSessionSettings).toHaveBeenCalledWith(sessionId);
    });

    it('when a launch loses the race for the last slot', async () => {
      // All nine pass the early cap check together; the launch service then
      // hands out eight slots and refuses the ninth after its row was saved.
      const handler = asScout();
      const results = await Promise.all(
        Array.from({ length: AGENT_LAUNCH_MAX_LIVE + 1 }, () =>
          handler({ ...BASE, model: 'claude-opus' })
        )
      );
      const refused = results.filter((r) => r.isError);
      expect(refused).toHaveLength(1);
      expect(payloadOf(refused[0]!)).toMatchObject({ code: 'LAUNCH_CAP_FULL' });
      expect(runtimeRegistry.saveSessionSettings).toHaveBeenCalledTimes(AGENT_LAUNCH_MAX_LIVE + 1);
      const dispatched = new Set(
        vi.mocked(dispatchMessage).mock.calls.map(([opts]) => opts.sessionId)
      );
      const lost = vi
        .mocked(runtimeRegistry.saveSessionSettings)
        .mock.calls.map(([id]) => id)
        .find((id) => !dispatched.has(id));
      expect(runtimeRegistry.discardSessionSettings).toHaveBeenCalledTimes(1);
      expect(runtimeRegistry.discardSessionSettings).toHaveBeenCalledWith(lost);
    });
  });

  it(`refuses the ${AGENT_LAUNCH_MAX_LIVE + 1}th live launch, and starts again once one settles`, async () => {
    const handler = asScout();
    for (let i = 0; i < AGENT_LAUNCH_MAX_LIVE; i++) {
      expect((await handler(BASE)).isError).toBeUndefined();
    }
    vi.mocked(runtimeRegistry.saveSessionSettings).mockClear();
    const refused = await handler({ ...BASE, model: 'claude-opus' });
    expect(payloadOf(refused)).toMatchObject({
      error: AGENT_LAUNCH_CAP_MESSAGE,
      code: 'LAUNCH_CAP_FULL',
    });
    expect(dispatchMessage).toHaveBeenCalledTimes(AGENT_LAUNCH_MAX_LIVE);
    // Nothing is written for the refused launch either.
    expect(runtimeRegistry.saveSessionSettings).not.toHaveBeenCalled();

    vi.mocked(dispatchMessage).mock.calls[0]![0].onSettled?.('ok');
    expect((await handler(BASE)).isError).toBeUndefined();
  });

  describe('the Activity entry', () => {
    it('names the calling agent, the account and the folder', async () => {
      allowOnly('work');
      const deps = makeDeps();
      await asScout(deps)({ ...BASE, account: 'work' });
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

    it('is not written for a refused call', async () => {
      const deps = makeDeps();
      await asScout(deps)({ ...BASE, cwd: '/etc' });
      expect(deps.activityService.emit).not.toHaveBeenCalled();
    });
  });

  it('is an act-tier tool in the agents area whose card shows what it grants', () => {
    expect(MCP_TOOL_TIERS.session_start).toMatchObject({
      tier: 'act',
      area: 'agents',
      title: 'Start a new agent session',
      approvalDisplayFields: ['cwd', 'account', 'permissionMode', 'agentPath', 'prompt'],
    });
    expect(getSessionTools(makeDeps()).map((t) => t.name)).toEqual(['session_start']);
  });
});
