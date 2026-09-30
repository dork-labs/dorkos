/**
 * `session_start` holds to the account rules (spec `flow-multiproject` §8.4):
 * a named account that may not work in the folder's project is refused with
 * `ACCOUNT_REFUSED` and the plain sentence before the advisor is asked, and an
 * unnamed launch whose agent/default account may not work there, with no other
 * account allowed, is refused the same way by the launch service's own check.
 * Either way nothing starts and no settings row is left behind.
 *
 * The launch service is real down to the dispatcher, as in
 * `session-tools.test.ts`; the fake Claude runtime's `checkLaunchAccount` runs
 * the real pre-launch ladder check, so the unnamed refusal is production's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MeshCore } from '@dorkos/mesh';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import { FakeAgentRuntime } from '@dorkos/test-utils';

const runtimes = vi.hoisted(() => new Map<string, unknown>());
const rules = vi.hoisted(() => ({ claudeCode: {} as Record<string, unknown> }));

vi.mock('../../../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    has: vi.fn((type: string) => runtimes.has(type)),
    get: vi.fn((type: string) => runtimes.get(type)),
    getDefaultType: vi.fn(() => 'claude-code'),
    persistSessionRuntime: vi.fn(async () => true),
    resolveForSession: vi.fn(async () => runtimes.get('claude-code')),
    resolveSessionRuntime: vi.fn(async () => ({ type: 'claude-code', bound: false })),
    saveSessionSettings: vi.fn(async () => undefined),
    discardSessionSettings: vi.fn(async () => undefined),
  },
}));
vi.mock('../../../../../lib/boundary.js', () => ({
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
}));
vi.mock('../../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'runtimes' ? { claudeCode: rules.claudeCode } : undefined),
    set: vi.fn(),
  },
}));
vi.mock('../../../../core/usage/account-eligibility.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../core/usage/account-eligibility.js')>()),
  projectOfFolder: vi.fn(async (cwd: string | null | undefined) =>
    cwd === '/work/project' ? { root: '/work/project', name: 'project' } : null
  ),
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
  __resetAccountAdvisorForTests,
  registerAccountAdvisor,
} from '../../../../core/usage/account-advisor.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../../../core/agent-identity/__tests__/agent-home-fixture.js';
import { checkClaudeLaunchAccount } from '../../launch-account-check.js';
import type { McpToolDeps } from '../types.js';
import { createSessionStartHandler } from '../session-tools.js';

const AGENT_HOME = '/work/agents/scout';

const mesh = {
  listWithPaths: () => [{ id: 'a1', name: 'scout', displayName: 'Scout', projectPath: AGENT_HOME }],
} as unknown as MeshCore;

function makeDeps(): McpToolDeps {
  return {
    meshCore: mesh,
    activityService: { emit: vi.fn(async () => undefined) },
  } as unknown as McpToolDeps;
}

function asScout() {
  return createSessionStartHandler(makeDeps(), () => ({ agentPath: AGENT_HOME }));
}

function account(id: string, label: string): RuntimeAccount {
  return {
    runtime: 'claude-code',
    id,
    path: `/accounts/${id}`,
    canonicalPath: `/accounts/${id}`,
    label,
    color: '#123456',
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

function payloadOf(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

const BASE = { prompt: 'Fix the flaky test', cwd: '/work/project' };
const advisorRank = vi.fn();
const ORIGINAL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;

let claude: FakeAgentRuntime & { checkLaunchAccount?: unknown };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CLAUDE_CONFIG_DIR;
  __resetAccountAdvisorForTests();
  registerTestHomes([AGENT_HOME], { roomsDir: '/work/rooms' });
  advisorRank.mockImplementation(async (candidates: { id: string }[]) => ({
    accounts: candidates.map((c) => ({ id: c.id, eligible: true, reason: 'ok' })),
    recommendedId: null,
  }));
  registerAccountAdvisor('flow', { rank: advisorRank });
  // Work may work anywhere; Client Work only in client-app.
  rules.claudeCode = {
    defaultAccount: null,
    accounts: [
      { id: 'work', path: '/accounts/work', label: 'Work', color: null, onlyProjects: null },
      {
        id: 'client',
        path: '/accounts/client',
        label: 'Client Work',
        color: null,
        onlyProjects: ['/clients/client-app'],
      },
    ],
    defaultAccountOnlyProjects: null,
    projectAccounts: {},
  };
  runtimes.clear();
  claude = new FakeAgentRuntime('claude-code');
  claude.getCapabilities.mockReturnValue({
    ...claude.getCapabilities(),
    supportsAccounts: true,
  });
  claude.checkLaunchAccount = vi.fn((_sid: string, cwd: string, hintId?: string) =>
    checkClaudeLaunchAccount({ cwd, hintId })
  );
  runtimes.set('claude-code', claude);
  const accounts = [account('work', 'Work'), account('client', 'Client Work')];
  setAccountUsageStore({
    listAccounts: (runtime?: string) =>
      accounts.filter((a) => runtime === undefined || a.runtime === runtime),
    usageOfAccount: (a: RuntimeAccount) => usage(a),
    peek: () => [],
    onChange: () => () => undefined,
  } as unknown as AccountUsageStore);
});

afterEach(() => {
  for (const [opts] of vi.mocked(dispatchMessage).mock.calls) opts.onSettled?.('ok');
  setAccountUsageStore(undefined);
  clearTestHomes();
  __resetAccountAdvisorForTests();
  if (ORIGINAL_CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CLAUDE_CONFIG_DIR;
});

function expectNothingStarted(): void {
  expect(dispatchMessage).not.toHaveBeenCalled();
  expect(runtimeRegistry.persistSessionRuntime).not.toHaveBeenCalled();
}

describe('session_start — the account rules', () => {
  it('refuses a named account that may not work in the project, before the advisor', async () => {
    const result = await asScout()({ ...BASE, account: 'client' });

    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toEqual({
      error:
        "Client Work can't be used in project. It's set to work only in client-app. Pick another account, or change this in Settings → Runtimes.",
      code: 'ACCOUNT_REFUSED',
    });
    expect(advisorRank).not.toHaveBeenCalled();
    expectNothingStarted();
    expect(runtimeRegistry.saveSessionSettings).not.toHaveBeenCalled();
  });

  it('starts on a named account the rules allow (control)', async () => {
    const result = await asScout()({ ...BASE, account: 'work' });
    expect(result.isError).toBeUndefined();
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dispatchMessage).mock.calls[0]![0].accountHint).toBe('work');
  });

  it('refuses an unnamed launch when no account may work here, and leaves no row', async () => {
    rules.claudeCode.defaultAccountOnlyProjects = ['/clients/client-app'];
    (rules.claudeCode.accounts as Record<string, unknown>[])[0].onlyProjects = [
      '/clients/client-app',
    ];

    const result = await asScout()(BASE);

    expect(result.isError).toBe(true);
    expect(payloadOf(result)).toEqual({
      error:
        'No account is allowed to work in project. Choose which accounts it may use in Settings → Runtimes.',
      code: 'ACCOUNT_REFUSED',
    });
    expect(claude.checkLaunchAccount).toHaveBeenCalledWith(
      expect.any(String),
      '/work/project',
      undefined
    );
    expectNothingStarted();
    // The row the handler saved before the launch is taken back.
    expect(runtimeRegistry.discardSessionSettings).toHaveBeenCalledTimes(1);
  });

  it('starts an unnamed launch when another account may work here (control)', async () => {
    rules.claudeCode.defaultAccountOnlyProjects = ['/clients/client-app'];
    const result = await asScout()(BASE);
    expect(result.isError).toBeUndefined();
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
  });
});
