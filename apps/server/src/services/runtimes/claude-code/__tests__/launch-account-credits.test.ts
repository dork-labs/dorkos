/**
 * DorkOS credits as one entry in Claude Code's Runs on list (ADR
 * 261001-000811): named by a session or an agent, or the machine default; held
 * to project rules like any account; and never reached by an automatic step.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import { CREDITS_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import type { ProjectRef } from '@dorkos/shared/project-schemas';
import {
  accountIdForRoot,
  describeClaudeCodeAccounts,
  isRegisteredClaudeAccount,
  resolveLaunchAccountRoot,
} from '../claude-config-dir.js';
import { creditsClaudeRoot } from '../credits-root.js';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const PROJECT: ProjectRef = { root: '/projects/client-app', name: 'client-app' };

let dir: string;
let WORK: string;

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), 'dorkos-ladder-credits-')));
  WORK = path.join(dir, 'claude-work');
  await mkdir(WORK, { recursive: true });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeConfig(
  claudeCode: Partial<UserConfig['runtimes']['claudeCode']> = {},
  credits: Record<string, unknown> = { defaults: {}, offer: 'none' }
): { get<K extends keyof UserConfig>(key: K): UserConfig[K] } {
  const runtimes: UserConfig['runtimes'] = {
    ...USER_CONFIG_DEFAULTS.runtimes,
    claudeCode: {
      ...USER_CONFIG_DEFAULTS.runtimes.claudeCode,
      defaultAccount: null,
      accounts: [{ id: 'work', path: WORK, label: 'Work', color: null }],
      ...claudeCode,
    },
  };
  const cloud = { ...USER_CONFIG_DEFAULTS.cloud, credits } as UserConfig['cloud'];
  return {
    get: (<K extends keyof UserConfig>(key: K) =>
      key === 'runtimes' ? runtimes : key === 'cloud' ? cloud : USER_CONFIG_DEFAULTS[key]) as <
      K extends keyof UserConfig,
    >(
      key: K
    ) => UserConfig[K],
  };
}

const CREDITS_DEFAULT = {
  defaults: { 'claude-code': { runsOn: 'credits', chosenBy: 'user' } },
  offer: 'none',
};

describe('credits in the launch ladder', () => {
  it('a session that picks credits runs in the credits folder', () => {
    const launch = resolveLaunchAccountRoot({
      hintId: CREDITS_ACCOUNT_ID,
      project: null,
      config: fakeConfig(),
    });
    expect(launch).toEqual({ ok: true, root: creditsClaudeRoot(), accountId: CREDITS_ACCOUNT_ID });
  });

  it('an agent a person allowed onto credits runs on them', () => {
    const launch = resolveLaunchAccountRoot({
      agentAccountId: CREDITS_ACCOUNT_ID,
      agentId: 'agent-1',
      project: null,
      config: fakeConfig({}, { defaults: {}, offer: 'none', agents: ['agent-1'] }),
    });
    expect(launch.ok && launch.accountId).toBe(CREDITS_ACCOUNT_ID);
  });

  it('ignores an agent file naming credits that no person allowed, and falls through', () => {
    for (const agentId of ['agent-2', undefined]) {
      const launch = resolveLaunchAccountRoot({
        agentAccountId: CREDITS_ACCOUNT_ID,
        agentId,
        project: null,
        config: fakeConfig(
          { defaultAccount: WORK },
          { defaults: {}, offer: 'none', agents: ['agent-1'] }
        ),
      });
      expect(launch.ok && launch.root).toBe(WORK);
    }
  });

  it('a person’s recorded no on the machine default runs on their own sign-in', () => {
    const launch = resolveLaunchAccountRoot({
      project: null,
      config: fakeConfig(
        { defaultAccount: WORK },
        { defaults: { 'claude-code': { runsOn: 'own-sign-in', chosenBy: 'user' } }, offer: 'none' }
      ),
    });
    expect(launch.ok && launch.root).toBe(WORK);
  });

  it('a session’s own pick beats an agent pinned to credits', () => {
    const launch = resolveLaunchAccountRoot({
      hintId: 'work',
      agentAccountId: CREDITS_ACCOUNT_ID,
      project: null,
      config: fakeConfig(),
    });
    expect(launch.ok && launch.root).toBe(WORK);
  });

  it('the machine default runs new work on credits, and an agent’s own account still wins', () => {
    const config = fakeConfig({ defaultAccount: WORK }, CREDITS_DEFAULT);
    const byDefault = resolveLaunchAccountRoot({ project: null, config });
    expect(byDefault.ok && byDefault.accountId).toBe(CREDITS_ACCOUNT_ID);
    const byAgent = resolveLaunchAccountRoot({ agentAccountId: 'work', project: null, config });
    expect(byAgent.ok && byAgent.root).toBe(WORK);
  });

  it('turning the default off returns to the person’s own default, untouched', () => {
    const launch = resolveLaunchAccountRoot({
      project: null,
      config: fakeConfig({ defaultAccount: WORK }),
    });
    expect(launch.ok && launch.root).toBe(WORK);
  });

  it('a named credits pick that a project rule refuses is refused, not moved', () => {
    const config = fakeConfig({ projectAccounts: { [PROJECT.root]: { allow: ['work'] } } });
    const launch = resolveLaunchAccountRoot({
      hintId: CREDITS_ACCOUNT_ID,
      project: PROJECT,
      config,
    });
    expect(launch.ok).toBe(false);
  });

  it('a project rule can allow credits by id', () => {
    const config = fakeConfig({
      projectAccounts: { [PROJECT.root]: { allow: [CREDITS_ACCOUNT_ID] } },
    });
    const launch = resolveLaunchAccountRoot({
      hintId: CREDITS_ACCOUNT_ID,
      project: PROJECT,
      config,
    });
    expect(launch.ok && launch.accountId).toBe(CREDITS_ACCOUNT_ID);
  });

  it('an automatic fallback never lands on credits, even when credits are the only eligible choice', () => {
    // The project allows only credits; nothing named an account; credits are
    // not the default. The automatic rungs may not start spending.
    const config = fakeConfig({
      projectAccounts: { [PROJECT.root]: { allow: [CREDITS_ACCOUNT_ID] } },
    });
    const launch = resolveLaunchAccountRoot({ project: PROJECT, config });
    expect(launch.ok).toBe(false);
  });
});

describe('a schedule or agent naming credits', () => {
  it('is a pick the ladder honours, so nobody is told it will not be used', () => {
    expect(isRegisteredClaudeAccount(CREDITS_ACCOUNT_ID, fakeConfig())).toBe(true);
    expect(isRegisteredClaudeAccount('nobody', fakeConfig())).toBe(false);
  });
});

describe('naming a credits session', () => {
  it('reads the credits folder as credits, never as the person’s own Main', () => {
    expect(accountIdForRoot(creditsClaudeRoot(), fakeConfig())).toBe(CREDITS_ACCOUNT_ID);
    expect(accountIdForRoot(`${creditsClaudeRoot()}/`, fakeConfig())).toBe(CREDITS_ACCOUNT_ID);
  });

  it('marks credits as the row in use when it is the default, and says who chose it', () => {
    const described = describeClaudeCodeAccounts(fakeConfig({}, CREDITS_DEFAULT), {
      creditsAvailable: true,
    });
    expect(described.resolvedAccountId).toBe(CREDITS_ACCOUNT_ID);
    expect(described.credits).toMatchObject({
      id: CREDITS_ACCOUNT_ID,
      path: creditsClaudeRoot(),
      available: true,
      isDefault: true,
      chosenBy: 'user',
    });
    // Never a registry row: flow's CLI reads the same list.
    expect(described.accounts.map((account) => account.id)).not.toContain(CREDITS_ACCOUNT_ID);
  });
});
