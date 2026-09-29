/**
 * Only accounts that may work in the project are ever ranked (spec
 * `flow-multiproject` §8.4): the default ranking, the advisor's candidates and
 * its answer, the launch check, and the "not allowed here" rows a picker shows.
 *
 * The config (where the rules live) and the folder → project step are doubles;
 * the rule itself and the ranking run for real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import type { ProjectRef } from '@dorkos/shared/project-schemas';
import type { AccountAdvisor } from '@dorkos/extension-api/server';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** The stored `runtimes.claudeCode` block the rules are read from. */
let claudeCode: Record<string, unknown> = {};

vi.mock('../../config-manager.js', () => ({
  configManager: { get: (key: string) => (key === 'runtimes' ? { claudeCode } : undefined) },
}));

const DORKOS: ProjectRef = { root: '/projects/dorkos', name: 'dorkos' };
const CLIENT_APP: ProjectRef = { root: '/projects/client-app', name: 'client-app' };
/** Which project each folder is in; anything else is no project. */
const PROJECTS: Record<string, ProjectRef> = {
  '/projects/dorkos': DORKOS,
  '/projects/client-app': CLIENT_APP,
};

vi.mock('../account-eligibility.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../account-eligibility.js')>()),
  projectOfFolder: vi.fn(async (cwd: string | null | undefined) =>
    cwd ? (PROJECTS[cwd] ?? null) : null
  ),
}));

const { checkAccountLaunch, notAllowedAccounts, rankAccounts } =
  await import('../account-ranking.js');
const { __resetAccountAdvisorForTests, registerAccountAdvisor } =
  await import('../account-advisor.js');
const { setAccountUsageStore } = await import('../current-usage-store.js');
import type { AccountUsageStore } from '../account-usage-store.js';
import type { RuntimeAccount } from '../runtime-accounts.js';

function account(id: string): RuntimeAccount {
  return {
    runtime: 'claude-code',
    id,
    path: `/accounts/${id}`,
    canonicalPath: `/accounts/${id}`,
    label: id.toUpperCase(),
    color: '#123456',
    storedColor: '#123456',
    routable: true,
    implicit: false,
    isDefault: false,
    ledgerId: id,
  };
}

function usage(id: string, weekly: number): AccountUsage {
  return {
    runtime: 'claude-code',
    accountId: id,
    path: `/accounts/${id}`,
    label: id.toUpperCase(),
    color: '#123456',
    subscriptionType: null,
    plan: null,
    credits: null,
    spend: null,
    windows: [
      {
        key: 'seven_day',
        label: 'seven_day',
        usedPct: weekly,
        resetsAt: null,
        status: null,
        expired: false,
        observedAt: '2026-09-26T00:00:00.000Z',
        source: 'sdk_event',
      },
    ],
    state: 'ok',
    limit: null,
    updatedAt: null,
  };
}

/** `work` (most headroom) is kept to client-app; `spare` and `personal` work anywhere. */
function installStore(): void {
  const weekly: Record<string, number> = { work: 0, spare: 30, personal: 60 };
  const accounts = Object.keys(weekly).map(account);
  setAccountUsageStore({
    listAccounts: (runtime?: string) =>
      accounts.filter((a) => runtime === undefined || a.runtime === runtime),
    usageOfAccount: (a: RuntimeAccount) => usage(a.id, weekly[a.id]!),
  } as unknown as AccountUsageStore);
}

function ctx(cwd: string) {
  return { purpose: 'continue', caller: 'person', cwd, runtime: 'claude-code' } as const;
}

beforeEach(() => {
  __resetAccountAdvisorForTests();
  claudeCode = {
    accounts: [
      { id: 'work', label: 'Work', onlyProjects: [CLIENT_APP.root] },
      { id: 'spare', onlyProjects: null },
      { id: 'personal', onlyProjects: null },
    ],
  };
  installStore();
});

afterEach(() => {
  setAccountUsageStore(undefined);
  __resetAccountAdvisorForTests();
});

describe('rankAccounts keeps to the accounts that may work in the project', () => {
  it('omits an account kept to another project from the default ranking', async () => {
    // Purpose: `work` has the most headroom and would lead; it may not work in dorkos.
    const ranking = await rankAccounts(ctx(DORKOS.root));
    expect(ranking.accounts.map((a) => a.id)).toEqual(['spare', 'personal']);
    expect(ranking.recommendedId).toBe('spare');
  });

  it('keeps it in the project it is kept to', async () => {
    // Purpose: control — the filter is by project, not a blanket removal.
    const ranking = await rankAccounts(ctx(CLIENT_APP.root));
    expect(ranking.accounts.map((a) => a.id)).toEqual(['work', 'spare', 'personal']);
  });

  it("omits an account the project's allow list leaves out", async () => {
    // Purpose: the project side of the rule filters the ranking too.
    claudeCode = { ...claudeCode, projectAccounts: { [DORKOS.root]: { allow: ['personal'] } } };
    const ranking = await rankAccounts(ctx(DORKOS.root));
    expect(ranking.accounts.map((a) => a.id)).toEqual(['personal']);
  });

  it('reads an empty folder as no project, where a restricted account never works', async () => {
    // Purpose: several callers pass `''`; that must not let a restricted account through.
    const ranking = await rankAccounts(ctx(''));
    expect(ranking.accounts.map((a) => a.id)).toEqual(['spare', 'personal']);
  });

  it('asks the advisor with eligible candidates only', async () => {
    // Purpose: the advisor never even sees an account that may not work here.
    const rank = vi.fn<AccountAdvisor['rank']>(() => ({
      accounts: [{ id: 'spare', eligible: true, reason: 'ok' }],
      recommendedId: 'spare',
    }));
    registerAccountAdvisor('flow', { rank });
    await rankAccounts(ctx(DORKOS.root));
    expect(rank).toHaveBeenCalledTimes(1);
    expect(rank.mock.calls[0]![0].map((c) => c.id)).toEqual(['spare', 'personal']);
  });

  it('drops an ineligible account the advisor names anyway', async () => {
    // Purpose: the advisor's answer is filtered again; it cannot re-introduce `work`.
    registerAccountAdvisor('flow', {
      rank: () => ({
        accounts: [
          { id: 'work', eligible: true, reason: 'Fastest', badge: 'recommended' },
          { id: 'personal', eligible: true, reason: 'ok' },
        ],
        recommendedId: 'work',
      }),
    });
    const ranking = await rankAccounts(ctx(DORKOS.root));
    expect(ranking.advised).toBe(true);
    expect(ranking.accounts.map((a) => a.id)).toEqual(['personal']);
    expect(ranking.recommendedId).not.toBe('work');
  });
});

describe('checkAccountLaunch refuses an ineligible account first', () => {
  it('refuses with the plain sentence without asking the advisor', async () => {
    // Purpose: the account rules decide before routing policy, whatever the advisor would say.
    const rank = vi.fn<AccountAdvisor['rank']>(() => ({
      accounts: [{ id: 'work', eligible: true, reason: 'ok' }],
      recommendedId: 'work',
    }));
    registerAccountAdvisor('flow', { rank });
    const decision = await checkAccountLaunch({
      accountId: 'work',
      cwd: DORKOS.root,
      runtime: 'claude-code',
      caller: 'agent',
    });
    expect(decision).toEqual({
      allowed: false,
      reason:
        "Work can't be used in dorkos. It's set to work only in client-app. Pick another account, or change this in Settings → Runtimes.",
    });
    expect(rank).not.toHaveBeenCalled();
  });

  it('allows it where it may work and the advisor agrees', async () => {
    // Purpose: control — eligibility is the only reason for the refusal above.
    registerAccountAdvisor('flow', {
      rank: () => ({
        accounts: [{ id: 'work', eligible: true, reason: 'ok' }],
        recommendedId: 'work',
      }),
    });
    expect(
      await checkAccountLaunch({
        accountId: 'work',
        cwd: CLIENT_APP.root,
        runtime: 'claude-code',
        caller: 'agent',
      })
    ).toEqual({ allowed: true });
  });
});

describe('notAllowedAccounts', () => {
  it('lists an account kept to another project, disabled, with "Only for <name>"', async () => {
    // Purpose: a picker shows the account greyed out with the reason instead of hiding it.
    const rows = await notAllowedAccounts(ctx(DORKOS.root));
    expect(rows.map((r) => [r.id, r.eligible, r.reason])).toEqual([
      ['work', false, 'Only for client-app'],
    ]);
  });

  it('says "Not used in <project>" for an account the allow list leaves out', async () => {
    // Purpose: the project-side reason reads differently from the account-side one.
    claudeCode = { ...claudeCode, projectAccounts: { [DORKOS.root]: { allow: ['spare'] } } };
    const rows = await notAllowedAccounts(ctx(DORKOS.root));
    expect(rows.map((r) => [r.id, r.reason])).toEqual([
      ['work', 'Only for client-app'],
      ['personal', 'Not used in dorkos'],
    ]);
  });

  it('lists nothing where every account may work', async () => {
    // Purpose: control — only ineligible accounts appear.
    expect(await notAllowedAccounts(ctx(CLIENT_APP.root))).toEqual([]);
  });
});
