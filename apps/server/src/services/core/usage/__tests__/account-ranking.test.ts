import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AccountUsage, LedgerRuntime } from '@dorkos/shared/account-usage';
import type { AccountAdvisor, AdvisorRanking } from '@dorkos/extension-api/server';
import {
  ACCOUNT_HIDDEN_REASON,
  ADVISOR_FAILED_REASON,
  NO_ADVISOR_REASON,
  SIGNED_OUT_REASON,
  checkAccountLaunch,
  coreRanking,
  formatShortLocalTime,
  mayAutoPick,
  rankAccounts,
} from '../account-ranking.js';
import {
  recordAccountSignin,
  resetAccountSignins,
} from '../../../observability/account-signin-state.js';
import {
  ADVISOR_TIMEOUT_MS,
  __resetAccountAdvisorForTests,
  registerAccountAdvisor,
} from '../account-advisor.js';
import { setAccountUsageStore } from '../current-usage-store.js';
import type { AccountUsageStore } from '../account-usage-store.js';
import type { RuntimeAccount } from '../runtime-accounts.js';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

interface Fixture {
  id: string;
  runtime?: LedgerRuntime;
  weekly?: number | null;
  fiveHour?: number | null;
  state?: AccountUsage['state'];
  resetsAt?: string | null;
  routable?: boolean;
  implicit?: boolean;
  /** A registered row with Main's folder: `default` names it. */
  isDefault?: boolean;
  /** A person turned off "Move agents here automatically" on it. */
  noAutoMove?: boolean;
}

function account(f: Fixture): RuntimeAccount {
  return {
    runtime: f.runtime ?? 'claude-code',
    id: f.id,
    path: `/accounts/${f.id}`,
    canonicalPath: `/accounts/${f.id}`,
    label: f.id.toUpperCase(),
    color: '#123456',
    storedColor: '#123456',
    routable: f.routable ?? true,
    implicit: f.implicit ?? false,
    isDefault: f.isDefault ?? f.implicit ?? false,
    ledgerId: f.id,
    ...(f.noAutoMove ? { noAutoMove: true as const } : {}),
  };
}

function usage(f: Fixture): AccountUsage {
  const windows: AccountUsage['windows'] = [];
  const window = (key: string, usedPct: number) => ({
    key,
    label: key,
    usedPct,
    resetsAt: null,
    status: null,
    expired: false,
    observedAt: '2026-09-26T00:00:00.000Z',
    source: 'sdk_event' as const,
  });
  if (f.fiveHour !== undefined && f.fiveHour !== null)
    windows.push(window('five_hour', f.fiveHour));
  if (f.weekly !== undefined && f.weekly !== null) windows.push(window('seven_day', f.weekly));
  const state = f.state ?? (windows.length > 0 ? 'ok' : 'unknown');
  return {
    runtime: f.runtime ?? 'claude-code',
    accountId: f.id,
    path: `/accounts/${f.id}`,
    label: f.id.toUpperCase(),
    color: '#123456',
    subscriptionType: null,
    plan: null,
    credits: null,
    spend: null,
    windows,
    state,
    limit: state === 'limited' ? { window: 'seven_day', resetsAt: f.resetsAt ?? null } : null,
    updatedAt: null,
  };
}

/** Install a store that knows exactly these accounts, in this order. */
function installStore(fixtures: Fixture[]): void {
  const accounts = fixtures.map(account);
  const byId = new Map(fixtures.map((f) => [`${f.runtime ?? 'claude-code'}:${f.id}`, usage(f)]));
  const store = {
    listAccounts: (runtime?: LedgerRuntime) =>
      accounts.filter((a) => runtime === undefined || a.runtime === runtime),
    usageOfAccount: (a: RuntimeAccount) => byId.get(`${a.runtime}:${a.id}`)!,
  };
  setAccountUsageStore(store as unknown as AccountUsageStore);
}

function advise(rank: AccountAdvisor['rank']): void {
  registerAccountAdvisor('flow', { rank });
}

const continueCtx = {
  purpose: 'continue',
  caller: 'person',
  cwd: '/w',
  runtime: 'claude-code',
} as const;

beforeEach(() => {
  __resetAccountAdvisorForTests();
  resetAccountSignins();
});

afterEach(() => {
  setAccountUsageStore(undefined);
  vi.useRealTimers();
});

describe('rankAccounts: the default ranking', () => {
  it('orders eligible accounts by weekly headroom, unknown after known, limited last', async () => {
    installStore([
      { id: 'out', state: 'limited', weekly: 100, resetsAt: '2026-09-29T15:00:00' },
      { id: 'unknown' },
      { id: 'half', weekly: 50 },
      { id: 'fresh', weekly: 42 },
      { id: 'busy', weekly: 90 },
    ]);
    const ranking = await rankAccounts(continueCtx);
    expect(ranking.accounts.map((a) => [a.id, a.eligible, a.reason])).toEqual([
      ['fresh', true, '58% of the week left'],
      ['half', true, '50% of the week left'],
      ['busy', true, '10% of the week left'],
      ['unknown', true, 'Usage unknown'],
      ['out', false, `Out until ${formatShortLocalTime('2026-09-29T15:00:00')}`],
    ]);
    expect(ranking.recommendedId).toBe('fresh');
    expect(ranking.advised).toBe(false);
  });

  it('breaks a weekly tie on 5-hour headroom, then registry order', async () => {
    installStore([
      { id: 'a', weekly: 20, fiveHour: 80 },
      { id: 'b', weekly: 20, fiveHour: 10 },
      { id: 'c', weekly: 20, fiveHour: 10 },
    ]);
    const ranking = await rankAccounts(continueCtx);
    expect(ranking.accounts.map((a) => a.id)).toEqual(['b', 'c', 'a']);
  });

  it('leaves out the excluded account and accounts that cannot be routed to', async () => {
    installStore([
      { id: 'work', weekly: 10 },
      { id: 'legacy_id', weekly: 0, routable: false },
      { id: 'client', weekly: 30 },
    ]);
    const ranking = await rankAccounts({ ...continueCtx, excludeAccountId: 'work' });
    expect(ranking.accounts.map((a) => a.id)).toEqual(['client']);
  });

  it('recommends nothing when every account is out, and carries label, color and usage', async () => {
    installStore([{ id: 'out', state: 'limited', weekly: 100 }]);
    const ranking = await rankAccounts(continueCtx);
    expect(ranking.recommendedId).toBeNull();
    expect(ranking.accounts[0]).toMatchObject({
      id: 'out',
      label: 'OUT',
      color: '#123456',
      reason: 'Out of usage',
      usage: { state: 'limited' },
    });
  });

  it("ranks only the context's runtime", async () => {
    installStore([
      { id: 'work', weekly: 10 },
      { id: 'default', runtime: 'codex', implicit: true },
    ]);
    const ranking = await rankAccounts({ ...continueCtx, runtime: 'codex' });
    expect(ranking.accounts.map((a) => [a.runtime, a.id])).toEqual([['codex', 'default']]);
  });
});

describe('rankAccounts: with an advisor', () => {
  it('keeps limited accounts unusable even when the advisor recommends them', async () => {
    installStore([
      { id: 'out', state: 'limited', weekly: 100 },
      { id: 'spare', weekly: 40 },
    ]);
    advise(() => ({
      accounts: [
        { id: 'out', eligible: true, reason: 'Pick this one' },
        { id: 'spare', eligible: true, reason: 'Has room' },
      ],
      recommendedId: 'out',
    }));

    const ranking = await rankAccounts(continueCtx);
    expect(ranking.accounts[0]).toMatchObject({
      id: 'out',
      eligible: false,
      reason: 'Out of usage',
    });
    expect(ranking.recommendedId).toBe('spare');
    expect(ranking.accounts.filter(mayAutoPick).map((row) => row.id)).toEqual(['spare']);
    expect(
      coreRanking('claude-code', null)
        .filter(mayAutoPick)
        .map((row) => row.id)
    ).toEqual(['spare']);
  });

  it("uses the advisor's order, drops unknown ids, keeps hidden ids absent, and fills rows in", async () => {
    installStore([
      { id: 'work', weekly: 10 },
      { id: 'client', weekly: 30 },
      { id: 'kept-out', weekly: 0 },
      { id: 'default', runtime: 'codex', implicit: true },
    ]);
    const rank = vi.fn<AccountAdvisor['rank']>(() => ({
      accounts: [
        { id: 'client', eligible: true, reason: 'Client work', badge: 'recommended' },
        { id: 'ghost', eligible: true, reason: 'Not real' },
        { id: 'work', eligible: false, reason: 'Main account is reserved', badge: 'reserved' },
        { runtime: 'codex', id: 'default', eligible: true, reason: 'Codex fallback' },
      ],
      recommendedId: 'client',
    }));
    advise(rank);
    const ranking = await rankAccounts(continueCtx);

    expect(rank).toHaveBeenCalledWith(
      [
        expect.objectContaining({ id: 'work', label: 'WORK', usage: expect.anything() }),
        expect.objectContaining({ id: 'client' }),
        expect.objectContaining({ id: 'kept-out' }),
      ],
      continueCtx
    );
    for (const candidate of rank.mock.calls[0]?.[0] ?? []) {
      expect(candidate.usage).not.toHaveProperty('path');
    }
    expect(ranking.advised).toBe(true);
    expect(ranking.recommendedId).toBe('client');
    expect(ranking.accounts.map((a) => [a.runtime, a.id, a.eligible, a.reason, a.badge])).toEqual([
      ['claude-code', 'client', true, 'Client work', 'recommended'],
      ['claude-code', 'work', false, 'Main account is reserved', 'reserved'],
      ['codex', 'default', true, 'Codex fallback', undefined],
    ]);
    expect(ranking.accounts[0]).toMatchObject({ label: 'CLIENT', color: '#123456' });
  });

  it('never offers the excluded account, even when the advisor lists it', async () => {
    installStore([
      { id: 'work', weekly: 10 },
      { id: 'client', weekly: 30 },
    ]);
    advise(() => ({
      accounts: [
        { id: 'work', eligible: true, reason: 'x' },
        { id: 'client', eligible: true, reason: 'y' },
      ],
      recommendedId: 'work',
    }));
    const ranking = await rankAccounts({ ...continueCtx, excludeAccountId: 'work' });
    expect(ranking.accounts.map((a) => a.id)).toEqual(['client']);
    expect(ranking.recommendedId).toBeNull();
  });

  it('falls back to the default when the advisor throws or answers nonsense', async () => {
    installStore([
      { id: 'a', weekly: 90 },
      { id: 'b', weekly: 10 },
    ]);
    advise(() => {
      throw new Error('boom');
    });
    let ranking = await rankAccounts(continueCtx);
    expect(ranking.advised).toBe(false);
    expect(ranking.accounts.map((a) => a.id)).toEqual(['b', 'a']);

    __resetAccountAdvisorForTests();
    advise(() => 'nonsense' as unknown as AdvisorRanking);
    ranking = await rankAccounts(continueCtx);
    expect(ranking.advised).toBe(false);
  });
});

describe('rankAccounts: a sign-in last seen signed out (DOR-4439)', () => {
  /** `fresh` has the most room, so only its sign-in can keep it from going first. */
  const FLEET: Fixture[] = [
    { id: 'fresh', weekly: 10 },
    { id: 'next', weekly: 50 },
  ];

  it('an automatic pick skips it for the next eligible account', async () => {
    installStore(FLEET);
    recordAccountSignin('claude-code', '/accounts/fresh', 'signed-out');
    const ranking = await rankAccounts(continueCtx);
    expect(ranking.recommendedId).toBe('next');
    // Core's own ranking (failover, room reseat, beats, the work queue) agrees.
    const core = coreRanking('claude-code', null);
    expect(core[0]?.id).toBe('next');
    expect(core.find(mayAutoPick)?.id).toBe('next');
  });

  it('keeps it eligible for a person to pick, saying it is signed out', async () => {
    installStore(FLEET);
    recordAccountSignin('claude-code', '/accounts/fresh', 'signed-out');
    const ranking = await rankAccounts(continueCtx);
    expect(ranking.accounts.map((a) => [a.id, a.eligible, a.reason, a.signedOut])).toEqual([
      ['next', true, '50% of the week left', undefined],
      ['fresh', true, SIGNED_OUT_REASON, true],
    ]);
  });

  it('an agent or a relay naming it through the advisor is refused with "Signed out"', async () => {
    installStore(FLEET);
    recordAccountSignin('claude-code', '/accounts/fresh', 'signed-out');
    advise(() => ({
      accounts: [{ id: 'fresh', eligible: true, reason: 'Most room' }],
      recommendedId: 'fresh',
    }));
    const request = { accountId: 'fresh', cwd: '/w', runtime: 'claude-code' } as const;
    expect(await checkAccountLaunch({ ...request, caller: 'agent' })).toEqual({
      allowed: false,
      reason: SIGNED_OUT_REASON,
    });
    expect(await checkAccountLaunch({ ...request, caller: 'relay' })).toEqual({
      allowed: false,
      reason: SIGNED_OUT_REASON,
    });
  });

  it('the advisor cannot offer it either', async () => {
    installStore(FLEET);
    recordAccountSignin('claude-code', '/accounts/fresh', 'signed-out');
    advise(() => ({
      accounts: [
        { id: 'fresh', eligible: true, reason: 'Most room' },
        { id: 'next', eligible: true, reason: 'Fine' },
      ],
      recommendedId: 'fresh',
    }));
    const ranking = await rankAccounts(continueCtx);
    expect(ranking.advised).toBe(true);
    expect(ranking.accounts.find((a) => a.id === 'fresh')).toMatchObject({
      eligible: true,
      signedOut: true,
      reason: SIGNED_OUT_REASON,
    });
    expect(ranking.recommendedId).toBe('next');
  });

  it('is picked again once it is seen signed in', async () => {
    installStore(FLEET);
    recordAccountSignin('claude-code', '/accounts/fresh', 'signed-out');
    expect((await rankAccounts(continueCtx)).recommendedId).toBe('next');
    recordAccountSignin('claude-code', '/accounts/fresh', 'signed-in');
    const ranking = await rankAccounts(continueCtx);
    expect(ranking.recommendedId).toBe('fresh');
    expect(ranking.accounts[0]).toMatchObject({ id: 'fresh', eligible: true });
    expect(ranking.accounts[0]).not.toHaveProperty('signedOut');
  });

  it('an account nobody has seen since boot stays eligible', async () => {
    installStore([
      { id: 'out', weekly: 5 },
      { id: 'unseen', weekly: 30 },
      { id: 'seen', weekly: 60 },
    ]);
    recordAccountSignin('claude-code', '/accounts/out', 'signed-out');
    recordAccountSignin('claude-code', '/accounts/seen', 'signed-in');
    const ranking = await rankAccounts(continueCtx);
    expect(ranking.recommendedId).toBe('unseen');
    expect(ranking.accounts.map((a) => [a.id, mayAutoPick(a)])).toEqual([
      ['unseen', true],
      ['seen', true],
      ['out', false],
    ]);
  });
});

describe('checkAccountLaunch', () => {
  const request = {
    accountId: 'client',
    cwd: '/w',
    runtime: 'claude-code',
    caller: 'agent',
  } as const;

  beforeEach(() => {
    installStore([
      { id: 'work', weekly: 10 },
      { id: 'client', weekly: 30 },
    ]);
  });

  it('refuses a relay message with no advisor registered: anyone outside can write one', async () => {
    expect(await checkAccountLaunch({ ...request, caller: 'relay' })).toEqual({
      allowed: false,
      reason: NO_ADVISOR_REASON,
    });
  });

  it("allows an account the advisor allows, even one core's own rule would refuse", async () => {
    installStore([{ id: 'client', weekly: 30, noAutoMove: true }]);
    advise(() => ({
      accounts: [{ id: 'client', eligible: true, reason: 'ok' }],
      recommendedId: 'client',
    }));
    expect(await checkAccountLaunch(request)).toEqual({ allowed: true });
  });

  it('refuses when the advisor throws', async () => {
    advise(() => {
      throw new Error('boom');
    });
    expect(await checkAccountLaunch(request)).toEqual({
      allowed: false,
      reason: ADVISOR_FAILED_REASON,
    });
  });

  it('refuses when the advisor takes longer than 2 s', async () => {
    vi.useFakeTimers();
    advise(() => new Promise(() => {}));
    const decision = checkAccountLaunch(request);
    await vi.advanceTimersByTimeAsync(ADVISOR_TIMEOUT_MS);
    expect(await decision).toEqual({ allowed: false, reason: ADVISOR_FAILED_REASON });
  });

  it("allows an account the advisor's launch ranking marks eligible", async () => {
    const rank = vi.fn<AccountAdvisor['rank']>(() => ({
      accounts: [{ id: 'client', eligible: true, reason: 'ok' }],
      recommendedId: 'client',
    }));
    advise(rank);
    expect(await checkAccountLaunch({ ...request, caller: 'relay' })).toEqual({ allowed: true });
    expect(rank.mock.calls[0]?.[1]).toEqual({
      purpose: 'launch',
      caller: 'relay',
      cwd: '/w',
      runtime: 'claude-code',
    });
  });

  it("refuses an ineligible account with the advisor's reason", async () => {
    advise(() => ({
      accounts: [{ id: 'client', eligible: false, reason: 'Kept for client work only' }],
      recommendedId: null,
    }));
    expect(await checkAccountLaunch(request)).toEqual({
      allowed: false,
      reason: 'Kept for client work only',
    });
  });

  it('refuses an account the advisor hid', async () => {
    advise(() => ({
      accounts: [{ id: 'work', eligible: true, reason: 'ok' }],
      recommendedId: 'work',
    }));
    expect(await checkAccountLaunch(request)).toEqual({
      allowed: false,
      reason: ACCOUNT_HIDDEN_REASON,
    });
  });
});

/** Core's own refusals (DOR-5033), pinned word for word: an agent reads them. */
const MAIN_ACCOUNT_REASON = 'Agents can’t pick the main sign-in. Name another account.';
const KEPT_OFF_REASON = 'A person kept agents off this account.';
const CREDITS_REASON = 'Only a person can pick DorkOS credits.';

describe("checkAccountLaunch with no advisor: core's own rule for an agent (DOR-5033)", () => {
  const ask = (accountId: string) =>
    checkAccountLaunch({ accountId, cwd: '/w', runtime: 'claude-code', caller: 'agent' });

  it('allows a registered account no rule keeps agents off', async () => {
    installStore([
      { id: 'work', weekly: 10 },
      { id: 'client', weekly: 30 },
      { id: 'default', implicit: true, weekly: 0 },
    ]);
    expect(await ask('client')).toEqual({ allowed: true });
    expect(await ask('work')).toEqual({ allowed: true });
  });

  it('refuses an account a person kept agents off', async () => {
    installStore([
      { id: 'work', weekly: 10 },
      { id: 'client', weekly: 30, noAutoMove: true },
    ]);
    expect(await ask('client')).toEqual({ allowed: false, reason: KEPT_OFF_REASON });
  });

  it('never picks the main sign-in, standalone or as a registered row', async () => {
    installStore([
      { id: 'work', weekly: 10 },
      { id: 'default', implicit: true, weekly: 0 },
    ]);
    expect(await ask('default')).toEqual({ allowed: false, reason: MAIN_ACCOUNT_REASON });
    installStore([
      { id: 'main-row', isDefault: true, weekly: 0 },
      { id: 'work', weekly: 10 },
    ]);
    expect(await ask('main-row')).toEqual({ allowed: false, reason: MAIN_ACCOUNT_REASON });
  });

  it('refuses an unknown, an unroutable and a credits account', async () => {
    installStore([
      { id: 'work', weekly: 10 },
      { id: 'Bad Id', routable: false },
    ]);
    expect(await ask('ghost')).toEqual({ allowed: false, reason: ACCOUNT_HIDDEN_REASON });
    expect(await ask('Bad Id')).toEqual({ allowed: false, reason: ACCOUNT_HIDDEN_REASON });
    expect(await ask('dorkos-credits')).toEqual({ allowed: false, reason: CREDITS_REASON });
  });

  it('refuses an account that is out, or last seen signed out, with its reason', async () => {
    installStore([
      { id: 'out', state: 'limited', weekly: 100, resetsAt: '2026-09-29T15:00:00' },
      { id: 'seen', weekly: 10 },
    ]);
    recordAccountSignin('claude-code', '/accounts/seen', 'signed-out');
    expect(await ask('out')).toEqual({
      allowed: false,
      reason: `Out until ${formatShortLocalTime('2026-09-29T15:00:00')}`,
    });
    expect(await ask('seen')).toEqual({ allowed: false, reason: SIGNED_OUT_REASON });
  });
});

describe('formatShortLocalTime', () => {
  it('reads as a weekday and an hour, with minutes only off the hour', () => {
    expect(formatShortLocalTime('2026-09-29T15:00:00')).toBe('Tue 3pm');
    expect(formatShortLocalTime('2026-09-29T00:30:00')).toBe('Tue 12:30am');
    expect(formatShortLocalTime('not a time')).toBeNull();
  });
});
