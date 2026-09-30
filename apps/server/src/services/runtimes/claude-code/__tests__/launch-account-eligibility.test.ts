/**
 * The launch ladder keeps to the accounts that may work in the launch's project
 * (spec `flow-multiproject` §8.4): a NAMED account (rungs 1-2) that may not work
 * here refuses; an AUTOMATIC one (rungs 3-4) skips to the next eligible account;
 * nothing eligible refuses.
 *
 * Account folders are real temporary directories, because the ladder names an
 * account by its folder canonically (`accountIdForRoot`).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import type { ProjectRef } from '@dorkos/shared/project-schemas';
import { resolveLaunchAccountRoot } from '../claude-config-dir.js';
import { AccountNotAllowedError } from '../../../core/usage/account-eligibility.js';
import { setAccountUsageStore } from '../../../core/usage/current-usage-store.js';
import type { AccountUsageStore } from '../../../core/usage/account-usage-store.js';
import type { RuntimeAccount } from '../../../core/usage/runtime-accounts.js';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const CLIENT_APP: ProjectRef = { root: '/projects/client-app', name: 'client-app' };
const DORKOS: ProjectRef = { root: '/projects/dorkos', name: 'dorkos' };

let dir: string;
let WORK: string;
let PERSONAL: string;
let SPARE: string;
let ENV: string;

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), 'dorkos-ladder-elig-')));
  WORK = path.join(dir, 'claude-work');
  PERSONAL = path.join(dir, 'claude-personal');
  SPARE = path.join(dir, 'claude-spare');
  ENV = path.join(dir, 'claude-env');
  for (const d of [WORK, PERSONAL, SPARE, ENV]) await mkdir(d, { recursive: true });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A config reader over one full `runtimes.claudeCode` block. */
function fakeConfig(claudeCode: Partial<UserConfig['runtimes']['claudeCode']> = {}): {
  get<K extends keyof UserConfig>(key: K): UserConfig[K];
} {
  const runtimes: UserConfig['runtimes'] = {
    ...USER_CONFIG_DEFAULTS.runtimes,
    claudeCode: {
      defaultAccount: null,
      accounts: [],
      defaultAccountColor: null,
      defaultAccountOnlyProjects: null,
      projectAccounts: {},
      dismissedFolders: [],
      defaultModel: null,
      defaultEffort: null,
      defaultTrustStop: null,
      persistentSession: false,
      ...claudeCode,
    },
  };
  return {
    get: (<K extends keyof UserConfig>(key: K) =>
      key === 'runtimes' ? runtimes : USER_CONFIG_DEFAULTS[key]) as <K extends keyof UserConfig>(
      key: K
    ) => UserConfig[K],
  };
}

/** The registry: `work` kept to client-app, `personal` and `spare` anywhere. */
function registry(
  only: { work?: string[] | null; personal?: string[] | null; spare?: string[] | null } = {}
) {
  return [
    {
      id: 'work',
      path: WORK,
      label: 'Work',
      color: null,
      onlyProjects: only.work ?? [CLIENT_APP.root],
    },
    {
      id: 'personal',
      path: PERSONAL,
      label: 'Personal',
      color: null,
      onlyProjects: only.personal ?? null,
    },
    { id: 'spare', path: SPARE, label: 'Spare', color: null, onlyProjects: only.spare ?? null },
  ] as UserConfig['runtimes']['claudeCode']['accounts'];
}

describe('resolveLaunchAccountRoot with account rules (spec flow-multiproject §8.4)', () => {
  const ORIGINAL_ENV = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    process.env.CLAUDE_CONFIG_DIR = ENV;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_ENV;
    setAccountUsageStore(undefined);
  });

  it('runs a named account that may work in the project', () => {
    // Purpose: the rules never get in the way of an allowed pick.
    const launch = resolveLaunchAccountRoot({
      hintId: 'work',
      project: CLIENT_APP,
      config: fakeConfig({ accounts: registry() }),
    });
    expect(launch).toEqual({ ok: true, root: WORK, accountId: 'work' });
  });

  it('refuses a hint naming an account kept to another project, without falling through', () => {
    // Purpose: running a person's pick somewhere else silently is a surprise about money.
    const launch = resolveLaunchAccountRoot({
      hintId: 'work',
      agentAccountId: 'personal',
      project: DORKOS,
      config: fakeConfig({ accounts: registry(), defaultAccount: SPARE }),
    });
    expect(launch.ok).toBe(false);
    if (launch.ok) return;
    expect(launch.error).toBeInstanceOf(AccountNotAllowedError);
    expect(launch.error.accountId).toBe('work');
    expect(launch.error.detail).toMatchObject({ reason: 'only-projects' });
    expect(launch.error.message).toBe(
      "Work can't be used in dorkos. It's set to work only in client-app. Pick another account, or change this in Settings → Runtimes."
    );
  });

  it("refuses a hint the project's allow list leaves out", () => {
    // Purpose: the project side of the rule refuses a named account too.
    const launch = resolveLaunchAccountRoot({
      hintId: 'personal',
      project: DORKOS,
      config: fakeConfig({
        accounts: registry(),
        projectAccounts: { [DORKOS.root]: { allow: ['spare'] } },
      }),
    });
    expect(launch.ok).toBe(false);
    if (!launch.ok) {
      expect(launch.error.detail).toEqual({ reason: 'project-allowlist', project: DORKOS });
      expect(launch.error.accountId).toBe('personal');
    }
  });

  it("refuses the agent manifest's account when it may not work here", () => {
    // Purpose: rung 2 is a named account as well; it refuses rather than skipping.
    const launch = resolveLaunchAccountRoot({
      agentAccountId: 'work',
      project: DORKOS,
      config: fakeConfig({ accounts: registry(), defaultAccount: SPARE }),
    });
    expect(launch.ok).toBe(false);
    if (!launch.ok) expect(launch.error.accountId).toBe('work');
  });

  it('refuses a restricted named account in a folder that is in no project', () => {
    // Purpose: a list never allows "no project".
    const launch = resolveLaunchAccountRoot({
      hintId: 'work',
      project: null,
      config: fakeConfig({ accounts: registry() }),
    });
    expect(launch.ok).toBe(false);
    if (!launch.ok) {
      expect(launch.error.message).toBe(
        "Work is set to work only in client-app, and this folder isn't in a project. Pick another account."
      );
    }
  });

  it("judges a `default` hint by Main's own rule", () => {
    // Purpose: Main has no row; `defaultAccountOnlyProjects` is its rule.
    const cfg = fakeConfig({
      accounts: registry(),
      defaultAccountOnlyProjects: [CLIENT_APP.root],
    });
    const refused = resolveLaunchAccountRoot({ hintId: 'default', project: DORKOS, config: cfg });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.accountId).toBe('default');
      expect(refused.error.message.startsWith("Main can't be used in dorkos.")).toBe(true);
    }
    const allowed = resolveLaunchAccountRoot({
      hintId: 'default',
      project: CLIENT_APP,
      config: cfg,
    });
    expect(allowed).toMatchObject({ ok: true, accountId: 'default' });
  });

  it('skips an ineligible defaultAccount to the first eligible account', () => {
    // Purpose: rung 3 is an automatic choice; the next eligible account runs it.
    const launch = resolveLaunchAccountRoot({
      project: DORKOS,
      config: fakeConfig({ accounts: registry(), defaultAccount: WORK }),
    });
    expect(launch).toEqual({ ok: true, root: PERSONAL, accountId: 'personal' });
  });

  it('keeps an eligible defaultAccount', () => {
    // Purpose: control for the skip — rung 3 still answers when it may work here.
    const launch = resolveLaunchAccountRoot({
      project: CLIENT_APP,
      config: fakeConfig({ accounts: registry(), defaultAccount: WORK }),
    });
    expect(launch).toEqual({ ok: true, root: WORK, accountId: 'work' });
  });

  it('skips the environment root (Main) when Main may not work here', () => {
    // Purpose: rung 4 counts as `default`, judged by Main's rule, and skips when refused.
    const launch = resolveLaunchAccountRoot({
      project: DORKOS,
      config: fakeConfig({
        accounts: registry({ personal: [CLIENT_APP.root] }),
        defaultAccountOnlyProjects: [CLIENT_APP.root],
      }),
    });
    expect(launch).toEqual({ ok: true, root: SPARE, accountId: 'spare' });
  });

  it('runs the environment root as Main when Main may work here', () => {
    // Purpose: control for the rung-4 skip.
    const launch = resolveLaunchAccountRoot({
      project: DORKOS,
      config: fakeConfig({ accounts: registry() }),
    });
    expect(launch).toEqual({ ok: true, root: ENV, accountId: 'default' });
  });

  it('skips in core ranking order (weekly headroom) when a usage store is present', () => {
    // Purpose: the fallback is "first eligible in rankAccounts order", not registry order.
    installStore([
      { id: 'work', weekly: 0 },
      { id: 'personal', weekly: 80 },
      { id: 'spare', weekly: 10 },
    ]);
    const launch = resolveLaunchAccountRoot({
      project: DORKOS,
      config: fakeConfig({ accounts: registry(), defaultAccount: WORK }),
    });
    expect(launch).toEqual({ ok: true, root: SPARE, accountId: 'spare' });
  });

  it('refuses with none-eligible when no account may work in the project', () => {
    // Purpose: the automatic rungs refuse only when nothing at all may work here.
    const launch = resolveLaunchAccountRoot({
      project: DORKOS,
      config: fakeConfig({
        accounts: registry({ personal: [CLIENT_APP.root], spare: [CLIENT_APP.root] }),
        defaultAccountOnlyProjects: [CLIENT_APP.root],
      }),
    });
    expect(launch.ok).toBe(false);
    if (!launch.ok) {
      expect(launch.error.detail).toEqual({ reason: 'none-eligible' });
      expect(launch.error.accountId).toBeNull();
      expect(launch.error.message).toBe(
        'No account is allowed to work in dorkos. Choose which accounts it may use in Settings → Runtimes.'
      );
    }
  });

  it('refuses with none-eligible in no project when every account is restricted', () => {
    // Purpose: "no project" plus all-restricted is the fourth sentence's case.
    const launch = resolveLaunchAccountRoot({
      project: null,
      config: fakeConfig({
        accounts: registry({ personal: [CLIENT_APP.root], spare: [CLIENT_APP.root] }),
        defaultAccountOnlyProjects: [CLIENT_APP.root],
      }),
    });
    expect(launch.ok).toBe(false);
    if (!launch.ok) {
      expect(launch.error.detail).toEqual({ reason: 'none-eligible' });
      expect(launch.error.message).toContain("because it isn't in a project");
    }
  });
});

/** Install a usage store that knows these Claude Code accounts. */
function installStore(fixtures: { id: string; weekly: number }[]): void {
  const roots: Record<string, string> = { work: WORK, personal: PERSONAL, spare: SPARE };
  const accounts: RuntimeAccount[] = fixtures.map((f) => ({
    runtime: 'claude-code',
    id: f.id,
    path: roots[f.id]!,
    canonicalPath: roots[f.id]!,
    label: f.id,
    color: '#123456',
    storedColor: null,
    routable: true,
    implicit: false,
    isDefault: false,
    ledgerId: f.id,
  }));
  const usageOf = (a: RuntimeAccount): AccountUsage => ({
    runtime: 'claude-code',
    accountId: a.id,
    path: a.path ?? '',
    label: a.label,
    color: '#123456',
    subscriptionType: null,
    plan: null,
    credits: null,
    spend: null,
    windows: [
      {
        key: 'seven_day',
        label: 'Weekly',
        usedPct: fixtures.find((f) => f.id === a.id)!.weekly,
        resetsAt: null,
        status: null,
        expired: false,
        observedAt: '2026-09-27T00:00:00.000Z',
        source: 'sdk_event',
      },
    ],
    state: 'ok',
    limit: null,
    updatedAt: null,
  });
  setAccountUsageStore({
    listAccounts: (runtime: string) => (runtime === 'claude-code' ? accounts : []),
    usageOfAccount: usageOf,
  } as unknown as AccountUsageStore);
}
