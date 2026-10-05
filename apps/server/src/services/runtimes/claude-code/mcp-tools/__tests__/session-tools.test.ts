/**
 * `session_start` (spec `claude-account-fleet` D5): an agent starts a session
 * of its own, optionally on a named account. The session always runs as the
 * calling agent; every refusal starts nothing and leaves no settings row; a
 * named account needs the account policy; the mode is the calling chat's own
 * level or lower, never higher (spec `inherited-start-permission`); the launch
 * cap holds; and every started session leaves one Activity entry.
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
import type { PermissionMode } from '@dorkos/shared/types';
import type { AccountAdvisor } from '@dorkos/extension-api/server';
import { USER_CONFIG_DEFAULTS, type UserConfig } from '@dorkos/shared/config-schema';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtime-constants.js';
import { CODEX_CAPABILITIES } from '../../../codex/runtime-constants.js';

const runtimes = vi.hoisted(() => new Map<string, unknown>());
/** The folders the mocked boundary lets through. */
const boundaryRoots = vi.hoisted(() => ['/work']);

// Whether the new session runs on DorkOS credits, and what they cover (DOR-2636).
const credits = vi.hoisted(() => ({ onCredits: false }));
vi.mock('../../../../core/cloud/credits-model-gate.js', () => ({
  sessionRunsOnCredits: vi.fn(async () => credits.onCredits),
  creditsModelRefusal: vi.fn(async (_runtime: unknown, model: string) =>
    model === 'opus' ? 'DorkOS credits don’t cover that model. Pick one from the model menu.' : null
  ),
}));
// Whether the person has a standing Full autonomy acknowledgement on file.
const consent = vi.hoisted(() => ({ acknowledged: true }));
vi.mock('../../../../core/approvals/autonomy-consent.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  hasStandingAutonomyAck: vi.fn(() => consent.acknowledged),
}));
/** The stored settings rows `getSessionSettings` answers from, by session id. */
const storedSettings = vi.hoisted(() => new Map<string, { permissionMode?: string }>());
vi.mock('../../../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getSessionSettings: vi.fn(async (id: string) => storedSettings.get(id) ?? null),
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
vi.mock('../../../../session/session-state-projector.js', async (importOriginal) => ({
  // The real module for everything the in-session tool set loads; only the
  // projector the launch creates is a stand-in.
  ...(await importOriginal<object>()),
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
import { resolveLaunchAccountRoot as resolveLaunch } from '../../claude-config-dir.js';
import { MCP_TOOL_TIERS } from '../../../../core/mcp-tool-tiers.js';
import type { McpToolDeps } from '../types.js';
import type { ToolRegistrar } from '../../../../core/mcp-tool-gate.js';
import type { AgentIdentity } from '../../../../core/agent-identity/index.js';
import { registerSessionTools } from '../../../../core/external-mcp/session-tools.js';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  SessionStartedByStore,
  setSessionStartedByStore,
} from '../../../../session/origin/session-started-by-store.js';
import { StartWorkService, setStartWorkService } from '../../../../extensions/start-work.js';
import { handRegisteredInSessionTools } from '../index.js';
import { SessionStore } from '../../sessions/session-store.js';
import {
  NOT_THE_CALLER_MESSAGE,
  OTHER_AGENTS_HOME_MESSAGE,
  SESSION_START_CLIENT_ID,
  SessionStartInputShape,
  UNKNOWN_CALLER_MESSAGE,
  createSessionStartHandler,
  getSessionTools,
} from '../session-tools.js';

/**
 * The ladder's folder for a launch in no project (where no account rule
 * applies), or the refusal thrown: what this file asserts on.
 */
function resolveLaunchAccountRoot(
  opts: Omit<Parameters<typeof resolveLaunch>[0], 'project'> & {
    project?: Parameters<typeof resolveLaunch>[0]['project'];
  }
): string {
  const launch = resolveLaunch({ project: null, ...opts });
  if (!launch.ok) throw launch.error;
  return launch.root;
}

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
  // The real runtimes' declared modes: the ceiling is compared on them.
  claude.getCapabilities.mockReturnValue({
    ...claude.getCapabilities(),
    supportsAccounts: true,
    permissionModes: CLAUDE_CODE_CAPABILITIES.permissionModes,
  });
  codex = new FakeAgentRuntime('codex');
  codex.getCapabilities.mockReturnValue({
    ...codex.getCapabilities(),
    permissionModes: CODEX_CAPABILITIES.permissionModes,
  });
  consent.acknowledged = true;
  storedSettings.clear();
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

    it('a model DorkOS credits do not cover, for a session that will run on them (DOR-2636)', async () => {
      credits.onCredits = true;
      try {
        expect(await expectRefused({ ...BASE, model: 'opus' })).toMatchObject({
          code: 'UNSUPPORTED_MODEL',
        });
      } finally {
        credits.onCredits = false;
      }
    });

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

  it('writes the granted mode on the settings row with the model and effort, before the send', async () => {
    await asScout()({ ...BASE, permissionMode: 'plan', model: 'claude-opus', effort: 'high' });
    const save = vi.mocked(runtimeRegistry.saveSessionSettings);
    const [sessionId, settings] = save.mock.calls[0]!;
    expect(settings).toEqual({ permissionMode: 'plan', model: 'claude-opus', effort: 'high' });
    expect(vi.mocked(dispatchMessage).mock.calls[0]![0].sessionId).toBe(sessionId);
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(dispatchMessage).mock.invocationCallOrder[0]!
    );
    // Only the row: no runtime is handed an in-memory session for the new id.
    expect(claude.updateSession).not.toHaveBeenCalled();
  });

  it('leaves the input schema alone, so the approval card shows the mode asked for', () => {
    const schema = z.object(SessionStartInputShape);
    expect(schema.parse({ ...BASE, permissionMode: 'bypassPermissions' }).permissionMode).toBe(
      'bypassPermissions'
    );
    expect(schema.parse({ ...BASE, permissionMode: 'plan' }).permissionMode).toBe('plan');
  });

  it('writes the granted mode even when none was asked for, so the row never seeds another', async () => {
    await asScout()({ ...BASE, model: 'claude-opus' });
    expect(vi.mocked(runtimeRegistry.saveSessionSettings).mock.calls[0]![1]).toEqual({
      model: 'claude-opus',
      permissionMode: 'default',
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
        metadata: {
          cwd: '/work/project',
          runtime: 'claude-code',
          account: 'work',
          permissionMode: 'default',
        },
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

describe('session_start records who started the new session (spec flow-multiproject §7.7)', () => {
  let store: SessionStartedByStore;

  /** The handler, called by Scout from inside the chat `parentId`. */
  const fromChat = (parentId: string) =>
    createSessionStartHandler(makeDeps(), () => ({ agentPath: AGENT_HOME, sessionId: parentId }));

  beforeEach(() => {
    store = new SessionStartedByStore(createTestDb());
    setSessionStartedByStore(store);
    setStartWorkService(
      new StartWorkService({
        store,
        projects: { rootWithin: vi.fn(), listForExtension: vi.fn(), list: vi.fn() },
        extensionName: (id) => (id === 'flow' ? 'Flow' : id),
        runningSessionIds: () => [],
      })
    );
  });

  afterEach(() => {
    setStartWorkService(undefined);
    setSessionStartedByStore(undefined);
  });

  it('records the calling session and the reason, under the id the runtime settled on', async () => {
    const result = await fromChat('parent-chat')({ ...BASE, reason: 'Split off the tests' });
    const { sessionId } = payloadOf(result) as { sessionId: string };

    expect(store.get(sessionId)).toMatchObject({
      kind: 'chat',
      extensionId: null,
      startedBySessionId: 'parent-chat',
      originExtensionId: null,
      reason: 'Split off the tests',
    });
    expect(store.get(sessionId.replace(/^canon-/, ''))).toBeNull();
  });

  it('takes an optional reason of at most 200 characters', () => {
    const schema = z.object(SessionStartInputShape);
    expect(schema.safeParse(BASE).success).toBe(true);
    expect(schema.safeParse({ ...BASE, reason: 'x'.repeat(200) }).success).toBe(true);
    expect(schema.safeParse({ ...BASE, reason: 'x'.repeat(201) }).success).toBe(false);
  });

  it('inherits the calling chat’s extension, and counts against its limits', async () => {
    store.insert({
      sessionId: 'flow-chat',
      kind: 'extension',
      extensionId: 'flow',
      startedBySessionId: null,
      originExtensionId: 'flow',
      reason: '12 new ideas were waiting to be sorted',
      createdAt: new Date().toISOString(),
    });
    const first = await fromChat('flow-chat')(BASE);
    const { sessionId } = payloadOf(first) as { sessionId: string };
    expect(store.get(sessionId)).toMatchObject({
      startedBySessionId: 'flow-chat',
      originExtensionId: 'flow',
    });
    expect(store.countSince('flow', '1970-01-01T00:00:00.000Z')).toBe(2);
  });

  it('refuses a start past the extension’s limits, and starts and writes nothing', async () => {
    const now = new Date().toISOString();
    for (let i = 0; i < 10; i++) {
      store.insert({
        sessionId: `flow-chat-${i}`,
        kind: 'extension',
        extensionId: 'flow',
        startedBySessionId: null,
        originExtensionId: 'flow',
        reason: 'r',
        createdAt: now,
      });
    }
    const result = await fromChat('flow-chat-0')(BASE);

    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toEqual({
      error: 'Flow has started a lot of chats in the last hour. Try again later.',
      code: 'START_LIMIT',
    });
    expect(dispatchMessage).not.toHaveBeenCalled();
    expect(runtimeRegistry.saveSessionSettings).not.toHaveBeenCalled();
    expect(store.countSince('flow', '1970-01-01T00:00:00.000Z')).toBe(10);
  });

  it('forgets the start when the launch does not go through', async () => {
    vi.mocked(dispatchMessage).mockResolvedValueOnce({
      accepted: false,
      outcome: { kind: 'refused', messageId: 'm-1' },
      queued: false,
      queuePosition: 0,
    } as never);
    const result = await fromChat('parent-chat')(BASE);
    expect(result.isError).toBe(true);
    const minted = vi.mocked(dispatchMessage).mock.calls[0]![0].sessionId;
    expect(store.get(minted)).toBeNull();
  });

  it('records the calling chat and inherits its extension through the REAL in-session tool set', async () => {
    // Every other case here hands the handler its caller. This drives what a
    // live session drives (`createDorkOsToolServer` → `handRegisteredInSessionTools`)
    // with only a session, so the resolver in `mcp-tools/index.ts` is what
    // names the calling chat.
    store.insert({
      sessionId: 'flow-chat',
      kind: 'extension',
      extensionId: 'flow',
      startedBySessionId: null,
      originExtensionId: 'flow',
      reason: '12 new ideas were waiting to be sorted',
      createdAt: new Date().toISOString(),
    });
    const deps = makeDeps();
    // What the tool set asks Mesh while it builds; nothing here depends on it.
    (deps.meshCore as unknown as { getSubjectByPath: () => undefined }).getSubjectByPath = () =>
      undefined;
    const tools = handRegisteredInSessionTools(deps, {
      session: { eventQueue: [], cwd: AGENT_HOME, sdkSessionId: 'flow-chat' },
    } as never) as unknown as Array<{
      name: string;
      handler: (args: unknown, extra: unknown) => Promise<{ content: { text: string }[] }>;
    }>;
    const sessionStart = tools.find((t) => t.name === 'session_start')!;

    const result = await sessionStart.handler({ ...BASE, reason: 'Split off the tests' }, {});
    const { sessionId } = payloadOf(result) as { sessionId: string };

    expect(store.get(sessionId)).toMatchObject({
      kind: 'chat',
      startedBySessionId: 'flow-chat',
      originExtensionId: 'flow',
      reason: 'Split off the tests',
    });
  });

  it('records nothing when there is no calling chat (the external /mcp server)', async () => {
    const result = await asScout()(BASE);
    const { sessionId } = payloadOf(result) as { sessionId: string };
    expect(store.get(sessionId)).toBeNull();
  });
});

describe("session_start runs at the calling chat's level or lower (spec inherited-start-permission)", () => {
  /** The handler, called by Scout from inside a chat whose live mode is `mode`. */
  const fromChatAt = (mode: string | undefined, sessionId = 'parent-chat') =>
    createSessionStartHandler(makeDeps(), () => ({
      agentPath: AGENT_HOME,
      sessionId,
      runtime: 'claude-code',
      ...(mode !== undefined ? { permissionMode: mode } : {}),
    }));

  /** The mode written on the new session's settings row. */
  const savedMode = () =>
    vi.mocked(runtimeRegistry.saveSessionSettings).mock.calls[0]![1].permissionMode;

  async function expectRefused(
    handler: ReturnType<typeof createSessionStartHandler>,
    args: Parameters<ReturnType<typeof createSessionStartHandler>>[0]
  ) {
    const result = await handler(args);
    expect(result.isError).toBe(true);
    expect(dispatchMessage).not.toHaveBeenCalled();
    expect(runtimeRegistry.saveSessionSettings).not.toHaveBeenCalled();
    return payloadOf(result);
  }

  it('grants a chat at Bypass permissions a new chat at Bypass permissions', async () => {
    const result = await fromChatAt('bypassPermissions')({
      ...BASE,
      permissionMode: 'bypassPermissions',
    });
    expect(result.isError).toBeUndefined();
    expect(savedMode()).toBe('bypassPermissions');
    expect(payloadOf(result).permission).toEqual({
      mode: 'bypassPermissions',
      label: 'Bypass permissions',
      callerMode: 'bypassPermissions',
      sameAsCaller: true,
    });
  });

  it('gives a chat its own level when no mode is asked for', async () => {
    const result = await fromChatAt('acceptEdits')(BASE);
    expect(result.isError).toBeUndefined();
    expect(savedMode()).toBe('acceptEdits');
    expect(payloadOf(result).permission).toMatchObject({
      mode: 'acceptEdits',
      callerMode: 'acceptEdits',
      sameAsCaller: true,
    });
  });

  it('never grants Full autonomy silently: it has to be asked for by name', async () => {
    // An approval card shows only the arguments sent, so an inherited Full
    // autonomy would be invisible to the person approving it.
    const body = await expectRefused(fromChatAt('bypassPermissions'), BASE);
    expect(body).toEqual({
      error:
        'A new chat at Bypass permissions has to be asked for by name, so the person ' +
        'approving can see it. Pass permissionMode "bypassPermissions", or a lower mode.',
      code: 'NAME_FULL_AUTONOMY',
    });
    // Named, it is granted.
    const named = await fromChatAt('bypassPermissions')({
      ...BASE,
      permissionMode: 'bypassPermissions',
    });
    expect(payloadOf(named).permission).toMatchObject({ mode: 'bypassPermissions' });
  });

  it('refuses a mode above the calling chat, naming both levels, and writes nothing', async () => {
    const body = await expectRefused(fromChatAt('acceptEdits'), {
      ...BASE,
      permissionMode: 'bypassPermissions',
    });
    expect(body).toEqual({
      error:
        'This chat runs at Accept edits, so it cannot start a chat at Bypass permissions. ' +
        'Ask for Accept edits or lower.',
      code: 'ABOVE_YOUR_LEVEL',
    });
  });

  it('grants a mode at or below the calling chat, and says whether it was the same', async () => {
    const cases: Array<[PermissionMode, boolean]> = [
      ['acceptEdits', true],
      ['default', false],
      ['plan', false],
    ];
    for (const [mode, same] of cases) {
      vi.mocked(runtimeRegistry.saveSessionSettings).mockClear();
      const result = await fromChatAt('acceptEdits')({ ...BASE, permissionMode: mode });
      expect(result.isError).toBeUndefined();
      expect(savedMode()).toBe(mode);
      expect(payloadOf(result).permission).toMatchObject({
        mode,
        callerMode: 'acceptEdits',
        sameAsCaller: same,
      });
    }
  });

  describe('Auto', () => {
    // Auto declares the same asking and reach as Accept edits, but a classifier
    // approves commands that Accept edits asks a person about.
    it('is refused under a chat at Accept edits', async () => {
      expect(
        await expectRefused(fromChatAt('acceptEdits'), { ...BASE, permissionMode: 'auto' })
      ).toMatchObject({ code: 'ABOVE_YOUR_LEVEL' });
    });

    it('is granted under a chat at Auto, or one that never asks', async () => {
      for (const caller of ['auto', 'bypassPermissions']) {
        vi.mocked(runtimeRegistry.saveSessionSettings).mockClear();
        const result = await fromChatAt(caller)({ ...BASE, permissionMode: 'auto' });
        expect(result.isError).toBeUndefined();
        expect(savedMode()).toBe('auto');
      }
    });

    it('is what a chat at Auto passes on by default', async () => {
      const result = await fromChatAt('auto')(BASE);
      expect(payloadOf(result).permission).toMatchObject({ mode: 'auto', sameAsCaller: true });
    });
  });

  it('refuses a mode the target runtime does not declare', async () => {
    // `dontAsk` is a name the input schema knows and Claude Code no longer offers.
    const body = await expectRefused(fromChatAt('bypassPermissions'), {
      ...BASE,
      permissionMode: 'dontAsk',
    });
    expect(body).toMatchObject({ code: 'UNKNOWN_PERMISSION_MODE' });
  });

  describe('the ceiling', () => {
    it('is the live mode, not the stored row, when the two disagree', async () => {
      // The row says Bypass, the turn runs at Accept edits (lowered, or a
      // scheduled run below its row): the live mode is the truth.
      storedSettings.set('parent-chat', { permissionMode: 'bypassPermissions' });
      const body = await expectRefused(fromChatAt('acceptEdits'), {
        ...BASE,
        permissionMode: 'bypassPermissions',
      });
      expect(body).toMatchObject({ code: 'ABOVE_YOUR_LEVEL' });
    });

    it('falls back to the stored row when the live session has no mode', async () => {
      storedSettings.set('parent-chat', { permissionMode: 'acceptEdits' });
      const result = await fromChatAt(undefined)(BASE);
      expect(savedMode()).toBe('acceptEdits');
      expect(payloadOf(result).permission).toMatchObject({ callerMode: 'acceptEdits' });
    });

    it("is the runtime's default when neither the live mode nor a row is known", async () => {
      const handler = fromChatAt(undefined);
      expect(
        await expectRefused(handler, { ...BASE, permissionMode: 'acceptEdits' })
      ).toMatchObject({ code: 'ABOVE_YOUR_LEVEL' });
      await handler(BASE);
      expect(savedMode()).toBe('default');
    });

    it("is the runtime's default for a live mode it does not declare (fails closed)", async () => {
      const handler = fromChatAt('retiredMode');
      expect(
        await expectRefused(handler, { ...BASE, permissionMode: 'bypassPermissions' })
      ).toMatchObject({ code: 'ABOVE_YOUR_LEVEL' });
      const result = await handler(BASE);
      expect(savedMode()).toBe('default');
      // The record names the caller's actual mode, never the stand-in.
      expect(payloadOf(result).permission).toMatchObject({
        mode: 'default',
        callerMode: 'retiredMode',
        sameAsCaller: false,
      });
    });

    it("is Read only when the calling chat's runtime declares no modes at all", async () => {
      const ghost = createSessionStartHandler(makeDeps(), () => ({
        agentPath: AGENT_HOME,
        sessionId: 'parent-chat',
        runtime: 'ghost',
        permissionMode: 'bypassPermissions',
      }));
      expect(await expectRefused(ghost, { ...BASE, permissionMode: 'acceptEdits' })).toEqual({
        error:
          'This chat runs at Read only, so it cannot start a chat at Accept edits. ' +
          'Ask for Read only or lower.',
        code: 'ABOVE_YOUR_LEVEL',
      });
    });

    it('reads a stored Auto as Default, since nothing confirmed Auto for it', async () => {
      storedSettings.set('parent-chat', { permissionMode: 'auto' });
      expect(
        await expectRefused(fromChatAt(undefined), { ...BASE, permissionMode: 'auto' })
      ).toMatchObject({ code: 'ABOVE_YOUR_LEVEL' });
    });

    it('cannot be climbed along a chain', async () => {
      // A (Bypass) starts B at Accept edits; B, running at Accept edits, cannot
      // start C at Bypass.
      const b = await fromChatAt('bypassPermissions')({ ...BASE, permissionMode: 'acceptEdits' });
      expect(savedMode()).toBe('acceptEdits');
      vi.clearAllMocks();
      const bId = (payloadOf(b) as { sessionId: string }).sessionId;
      expect(
        await expectRefused(fromChatAt('acceptEdits', bId), {
          ...BASE,
          permissionMode: 'bypassPermissions',
        })
      ).toMatchObject({ code: 'ABOVE_YOUR_LEVEL' });
    });
  });

  describe('a caller with no chat (the external /mcp server)', () => {
    /** Register the tool as the external server does, and return its handler. */
    function externalHandler() {
      let handler: ReturnType<typeof createSessionStartHandler> | undefined;
      const registrar = {
        registerTool: (_name: string, _config: unknown, fn: typeof handler) => {
          handler = fn;
        },
      } as unknown as ToolRegistrar;
      registerSessionTools(registrar, makeDeps(), {
        agentPath: AGENT_HOME,
        displayName: 'Scout',
        createdAt: '2026-09-27T00:00:00.000Z',
      });
      return handler!;
    }

    it('is held to Accept edits', async () => {
      expect(
        await expectRefused(externalHandler(), { ...BASE, permissionMode: 'bypassPermissions' })
      ).toEqual({
        error:
          'Without a chat of your own, you can start a chat at Accept edits or lower, ' +
          'not Bypass permissions.',
        code: 'ABOVE_YOUR_LEVEL',
      });
      const result = await externalHandler()({ ...BASE, permissionMode: 'acceptEdits' });
      expect(savedMode()).toBe('acceptEdits');
      expect(payloadOf(result).permission).toEqual({
        mode: 'acceptEdits',
        label: 'Accept edits',
        callerMode: null,
        sameAsCaller: false,
      });
    });

    it("gets the runtime's default when it asks for no mode", async () => {
      await externalHandler()(BASE);
      expect(savedMode()).toBe('default');
    });
  });

  describe('a chat on another runtime is compared by declared level, never by id', () => {
    it('grants Codex Full access under a chat at Bypass permissions', async () => {
      const result = await fromChatAt('bypassPermissions')({
        ...BASE,
        runtime: 'codex',
        permissionMode: 'bypassPermissions',
      });
      expect(savedMode()).toBe('bypassPermissions');
      expect(payloadOf(result).permission).toMatchObject({
        mode: 'bypassPermissions',
        label: 'Full access',
        sameAsCaller: true,
      });
    });

    it("refuses Codex's acceptEdits under Claude's acceptEdits: one id, a higher level", async () => {
      // Codex's workspace-write never stops to ask; Claude's Accept edits does.
      expect(
        await expectRefused(fromChatAt('acceptEdits'), {
          ...BASE,
          runtime: 'codex',
          permissionMode: 'acceptEdits',
        })
      ).toMatchObject({ code: 'ABOVE_YOUR_LEVEL' });
    });

    it("falls to Codex's read-only default when the caller's own id would be higher there", async () => {
      const result = await fromChatAt('acceptEdits')({ ...BASE, runtime: 'codex' });
      expect(savedMode()).toBe('default');
      expect(payloadOf(result).permission).toMatchObject({
        mode: 'default',
        label: 'Read only',
        callerMode: 'acceptEdits',
        sameAsCaller: false,
      });
    });
  });

  describe('Full autonomy still needs the standing acknowledgement', () => {
    it('refuses Bypass permissions, asked for by name, with none on file', async () => {
      consent.acknowledged = false;
      expect(
        await expectRefused(fromChatAt('bypassPermissions'), {
          ...BASE,
          permissionMode: 'bypassPermissions',
        })
      ).toMatchObject({ code: 'AUTONOMY_ACK_REQUIRED' });
    });

    it('refuses a never-asking Codex mode too, and grants a lower one', async () => {
      consent.acknowledged = false;
      expect(
        await expectRefused(fromChatAt('bypassPermissions'), {
          ...BASE,
          runtime: 'codex',
          permissionMode: 'acceptEdits',
        })
      ).toMatchObject({ code: 'AUTONOMY_ACK_REQUIRED' });
      const result = await fromChatAt('bypassPermissions')({
        ...BASE,
        permissionMode: 'acceptEdits',
      });
      expect(result.isError).toBeUndefined();
    });
  });

  it('reads the live mode at CALL time through the REAL in-session tool set', async () => {
    const deps = makeDeps();
    (deps.meshCore as unknown as { getSubjectByPath: () => undefined }).getSubjectByPath = () =>
      undefined;
    const session = {
      eventQueue: [],
      cwd: AGENT_HOME,
      sdkSessionId: 'live-chat',
      permissionMode: 'bypassPermissions',
    };
    const tools = handRegisteredInSessionTools(deps, { session } as never) as unknown as Array<{
      name: string;
      handler: (args: unknown, extra: unknown) => Promise<{ content: { text: string }[] }>;
    }>;
    const sessionStart = tools.find((t) => t.name === 'session_start')!;

    const first = await sessionStart.handler({ ...BASE, permissionMode: 'bypassPermissions' }, {});
    expect(payloadOf(first).permission).toMatchObject({
      mode: 'bypassPermissions',
      callerMode: 'bypassPermissions',
    });

    // A person lowers the chat mid-turn: the very next call is held to it.
    session.permissionMode = 'acceptEdits';
    const second = await sessionStart.handler({ ...BASE, permissionMode: 'bypassPermissions' }, {});
    expect(payloadOf(second)).toMatchObject({ code: 'ABOVE_YOUR_LEVEL' });
  });

  /** `session_start` from the REAL in-session tool set, built over `session`. */
  function realSessionStart(session: object) {
    const deps = makeDeps();
    (deps.meshCore as unknown as { getSubjectByPath: () => undefined }).getSubjectByPath = () =>
      undefined;
    const tools = handRegisteredInSessionTools(deps, { session } as never) as unknown as Array<{
      name: string;
      handler: (args: unknown, extra: unknown) => Promise<{ content: { text: string }[] }>;
    }>;
    return tools.find((t) => t.name === 'session_start')!.handler;
  }

  describe('an Auto the turn is not really running', () => {
    const autoChat = (extra: object) => ({
      eventQueue: [],
      cwd: AGENT_HOME,
      sdkSessionId: 'auto-chat',
      permissionMode: 'auto',
      model: 'opus',
      ...extra,
    });

    it('counts as Default when Auto was never confirmed for the model', async () => {
      // The launcher ran this turn at Default and left `permissionMode` at Auto.
      const start = realSessionStart(autoChat({}));
      expect(payloadOf(await start({ ...BASE, permissionMode: 'auto' }, {}))).toMatchObject({
        code: 'ABOVE_YOUR_LEVEL',
      });
      const inherited = await start(BASE, {});
      expect(payloadOf(inherited).permission).toMatchObject({
        mode: 'default',
        callerMode: 'default',
      });
    });

    it('counts as Default when Auto was confirmed for another model', async () => {
      const start = realSessionStart(autoChat({ autoModeConfirmedFor: 'haiku' }));
      expect(payloadOf(await start({ ...BASE, permissionMode: 'auto' }, {}))).toMatchObject({
        code: 'ABOVE_YOUR_LEVEL',
      });
    });

    it('counts as Auto when it was confirmed for the model the chat runs', async () => {
      const start = realSessionStart(autoChat({ autoModeConfirmedFor: 'opus' }));
      const result = await start({ ...BASE, permissionMode: 'auto' }, {});
      expect(payloadOf(result).permission).toMatchObject({ mode: 'auto', callerMode: 'auto' });
    });
  });

  it('cannot be climbed along a chain whose next link is hydrated the way production does it', async () => {
    // A, at Bypass permissions, starts B at Accept edits.
    await fromChatAt('bypassPermissions')({ ...BASE, permissionMode: 'acceptEdits' });
    const [bId, bRow] = vi.mocked(runtimeRegistry.saveSessionSettings).mock.calls[0]!;
    vi.clearAllMocks();

    // B's live session is built from B's stored row by the session store,
    // exactly as its first turn builds it: no mode is handed in by the test.
    const store = new SessionStore();
    store.configureSettings(
      {
        getSessionSettings: async (id: string) => (id === bId ? bRow : null),
        saveSessionSettings: async () => undefined,
        rekeySessionSettings: async () => undefined,
      } as never,
      'default'
    );
    const b = await store.ensureForMessage(
      bId,
      { hasTranscript: async () => ({ exists: false }) } as never,
      AGENT_HOME,
      { cwd: AGENT_HOME } as never
    );
    expect(b.permissionMode).toBe('acceptEdits');

    const start = realSessionStart(b);
    expect(
      payloadOf(await start({ ...BASE, permissionMode: 'bypassPermissions' }, {}))
    ).toMatchObject({ code: 'ABOVE_YOUR_LEVEL' });
    const inherited = await start(BASE, {});
    expect(payloadOf(inherited).permission).toMatchObject({
      mode: 'acceptEdits',
      callerMode: 'acceptEdits',
    });
  });

  describe('records the level on who started it', () => {
    let store: SessionStartedByStore;

    beforeEach(() => {
      store = new SessionStartedByStore(createTestDb());
      setSessionStartedByStore(store);
      setStartWorkService(
        new StartWorkService({
          store,
          projects: { rootWithin: vi.fn(), listForExtension: vi.fn(), list: vi.fn() },
          extensionName: (id) => id,
          runningSessionIds: () => [],
        })
      );
    });

    afterEach(() => {
      setStartWorkService(undefined);
      setSessionStartedByStore(undefined);
    });

    it('stores the granted mode, the starter’s mode and whether they were one level', async () => {
      const same = await fromChatAt('bypassPermissions')({
        ...BASE,
        permissionMode: 'bypassPermissions',
      });
      const lower = await fromChatAt('bypassPermissions')({ ...BASE, permissionMode: 'plan' });
      const idOf = (r: typeof same) => (payloadOf(r) as { sessionId: string }).sessionId;

      expect(store.get(idOf(same))).toMatchObject({
        permissionMode: 'bypassPermissions',
        starterPermissionMode: 'bypassPermissions',
        permissionSameAsStarter: true,
      });
      expect(store.get(idOf(lower))).toMatchObject({
        permissionMode: 'plan',
        starterPermissionMode: 'bypassPermissions',
        permissionSameAsStarter: false,
      });
    });

    it('leaves no reservation behind for a start refused above the ceiling', async () => {
      const insert = vi.spyOn(store, 'insert');
      const result = await fromChatAt('acceptEdits')({
        ...BASE,
        permissionMode: 'bypassPermissions',
      });
      expect(result.isError).toBe(true);
      expect(insert).not.toHaveBeenCalled();
    });
  });
});
