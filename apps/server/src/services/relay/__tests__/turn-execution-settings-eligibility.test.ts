/**
 * A relay message naming an account that may not work in the addressed agent's
 * project runs on the ladder instead (spec `flow-multiproject` §8.4, "Relay
 * messages"), however willing the account advisor is.
 *
 * Unlike `turn-execution-settings.test.ts`, the launch check here is the REAL
 * `checkAccountLaunch` with a real registered advisor; only the registry, the
 * config the rules live in, the usage store and the folder → project step are
 * doubles.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { USER_CONFIG_DEFAULTS, type UserConfig } from '@dorkos/shared/config-schema';
import type { AccountAdvisor } from '@dorkos/extension-api/server';

vi.mock('../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getSessionSettings: () => Promise.resolve(null),
    has: (type: string) => type === 'claude-code',
    get: () => ({
      getCapabilities: () => ({
        settings: { configSection: 'claudeCode', supportsEffort: true, sections: [] },
      }),
    }),
  },
}));

/** The stored `runtimes` section, account rules included. */
let runtimesConfig: UserConfig['runtimes'] = USER_CONFIG_DEFAULTS.runtimes;

vi.mock('../../core/config-manager.js', () => ({
  configManager: { get: (key: string) => (key === 'runtimes' ? runtimesConfig : undefined) },
}));

vi.mock('../../core/usage/current-usage-store.js', () => ({
  getAccountUsageStore: () => ({
    listAccounts: (runtime: string) =>
      runtime === 'claude-code'
        ? [
            {
              runtime: 'claude-code',
              id: 'work',
              path: '/accounts/work',
              canonicalPath: '/accounts/work',
              label: 'Work',
              color: '#123456',
              storedColor: null,
              routable: true,
              implicit: false,
              isDefault: false,
              ledgerId: 'work',
            },
          ]
        : [],
    usageOfAccount: () => ({
      runtime: 'claude-code',
      accountId: 'work',
      path: '/accounts/work',
      label: 'Work',
      color: '#123456',
      subscriptionType: null,
      plan: null,
      credits: null,
      spend: null,
      windows: [],
      state: 'unknown',
      limit: null,
      updatedAt: null,
    }),
  }),
}));

/** The addressed agent's directory, and the project it is in. */
let agentDir = '';
const PROJECT_NAME = 'agent-project';

vi.mock('../../core/usage/account-eligibility.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/usage/account-eligibility.js')>()),
  projectOfFolder: vi.fn(async (cwd: string | null | undefined) =>
    cwd && cwd === agentDir ? { root: agentDir, name: PROJECT_NAME } : null
  ),
}));

const logInfo = vi.fn();

vi.mock('../../../lib/logger.js', () => ({
  logger: {
    info: (...a: unknown[]) => logInfo(...a),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

const { createTurnExecutionSettingsResolver } = await import('../turn-execution-settings.js');
const { __resetAccountAdvisorForTests, registerAccountAdvisor } =
  await import('../../core/usage/account-advisor.js');

/** Keep `work` to `roots` (null = any project). */
function keepWorkTo(roots: string[] | null): void {
  runtimesConfig = {
    ...USER_CONFIG_DEFAULTS.runtimes,
    claudeCode: {
      ...USER_CONFIG_DEFAULTS.runtimes.claudeCode,
      accounts: [
        { id: 'work', path: '/accounts/work', label: 'Work', color: null, onlyProjects: roots },
      ],
    },
  };
}

function ask() {
  return createTurnExecutionSettingsResolver()({
    runtimeType: 'claude-code',
    sessionId: 'agent-ulid-1',
    agentDirectory: agentDir,
    requestedAccount: 'work',
  });
}

describe('a relay message naming an account the project may not use', () => {
  let rank: ReturnType<typeof vi.fn<AccountAdvisor['rank']>>;

  beforeEach(async () => {
    // Canonical, as the project registry reports a root.
    agentDir = await realpath(await mkdtemp(path.join(tmpdir(), 'dorkos-relay-elig-')));
    logInfo.mockReset();
    __resetAccountAdvisorForTests();
    // An advisor that would allow `work` anywhere.
    rank = vi.fn<AccountAdvisor['rank']>(() => ({
      accounts: [{ id: 'work', eligible: true, reason: 'ok' }],
      recommendedId: 'work',
    }));
    registerAccountAdvisor('flow', { rank });
  });

  afterEach(async () => {
    __resetAccountAdvisorForTests();
    await rm(agentDir, { recursive: true, force: true });
  });

  it('runs on the ladder when the account is kept to another project', async () => {
    // Purpose: a relay sender cannot spend an account outside the projects it is kept to.
    keepWorkTo(['/projects/client-app']);
    const settings = await ask();
    expect(settings).not.toHaveProperty('accountHint');
    expect(rank).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith(
      expect.stringContaining('account'),
      expect.objectContaining({
        account: 'work',
        reason: expect.stringContaining(`Work can't be used in ${PROJECT_NAME}.`),
      })
    );
  });

  it("runs on the ladder when the project's allow list leaves the account out", async () => {
    // Purpose: the project side of the rule holds for relay messages too.
    keepWorkTo(null);
    runtimesConfig = {
      ...runtimesConfig,
      claudeCode: { ...runtimesConfig.claudeCode, projectAccounts: { [agentDir]: { allow: [] } } },
    };
    const settings = await ask();
    expect(settings).not.toHaveProperty('accountHint');
    expect(rank).not.toHaveBeenCalled();
  });

  it('launches on the account where it may work and the advisor allows it', async () => {
    // Purpose: control — the refusals above are the rule's, not the setup's.
    keepWorkTo([agentDir]);
    const settings = await ask();
    expect(settings.accountHint).toBe('work');
  });
});
