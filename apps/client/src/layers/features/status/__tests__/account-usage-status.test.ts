/**
 * The status bar's usage rules (spec `claude-account-ui` §6.8): an account's
 * reading as the usage item's `UsageStatus`, and which of that reading and the
 * turn's own usage wins.
 */
import { describe, it, expect } from 'vitest';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import type { UsageStatus } from '@dorkos/shared/types';
import { createMockAccountUsage } from '@dorkos/test-utils';
import {
  accountUsageToStatus,
  isWindowExpired,
  newestObservedAt,
  pickUsage,
  readableWindows,
  staleNumberClass,
  showsStaleMark,
  withExpiredWindows,
} from '../lib/account-usage-status';

type UsageWindow = AccountUsage['windows'][number];

const NOW = new Date('2026-09-28T12:00:00.000Z');

function usageWindow(overrides: Partial<UsageWindow>): UsageWindow {
  return {
    key: 'five_hour',
    label: '5-hour window',
    usedPct: 40,
    resetsAt: '2026-09-28T15:00:00.000Z',
    status: 'allowed',
    expired: false,
    observedAt: '2026-09-28T11:48:00.000Z',
    source: 'sdk_event',
    ...overrides,
  };
}

function account(windows: UsageWindow[], state: AccountUsage['state'] = 'ok'): AccountUsage {
  return createMockAccountUsage({ windows, state });
}

describe('accountUsageToStatus', () => {
  it('shows the most-used readable window as a subscription utilization', () => {
    const status = accountUsageToStatus(
      account([
        usageWindow({ usedPct: 40 }),
        usageWindow({
          key: 'seven_day',
          label: 'Weekly',
          usedPct: 72,
          resetsAt: '2026-10-04T09:00:00.000Z',
        }),
      ]),
      NOW
    );
    expect(status).toEqual({
      kind: 'subscription',
      utilization: 0.72,
      windowLabel: 'Weekly',
      resetsAt: '2026-10-04T09:00:00.000Z',
      state: 'ok',
    });
  });

  it.each([
    ['ok', 'ok'],
    ['warning', 'warning'],
    ['limited', 'exhausted'],
  ] as const)('maps the account state %s to %s', (state, expected) => {
    expect(accountUsageToStatus(account([usageWindow({})], state), NOW)?.state).toBe(expected);
  });

  it('does not count an expired window, even one the server has not marked yet', () => {
    const status = accountUsageToStatus(
      account([
        usageWindow({ usedPct: 95, expired: true }),
        usageWindow({ key: 'seven_day', label: 'Weekly', usedPct: 30, resetsAt: null }),
        // Its reset passed a minute ago; the server's `expired` has not caught up.
        usageWindow({
          key: 'seven_day_opus',
          label: 'Weekly Opus',
          usedPct: 99,
          resetsAt: '2026-09-28T11:59:00.000Z',
        }),
      ]),
      NOW
    );
    expect(status?.utilization).toBe(0.3);
    expect(status?.windowLabel).toBe('Weekly');
  });

  it('reads the state again from the windows in force once one has reset', () => {
    // The 5-hour window hit 100% and was limited, then reset; the week is at 30%.
    const afterReset = account(
      [
        usageWindow({ usedPct: 100, status: 'rejected', resetsAt: '2026-09-28T11:30:00.000Z' }),
        usageWindow({ key: 'seven_day', label: 'Weekly', usedPct: 30, resetsAt: null }),
      ],
      'limited'
    );
    expect(accountUsageToStatus(afterReset, NOW)?.state).toBe('ok');
    const nearOnWeek = account(
      [
        usageWindow({ usedPct: 100, expired: true }),
        usageWindow({ key: 'seven_day', label: 'Weekly', usedPct: 92, resetsAt: null }),
      ],
      'limited'
    );
    expect(accountUsageToStatus(nearOnWeek, NOW)?.state).toBe('warning');
  });

  it("reads out when the account's limit names a window still in force", () => {
    // The 5-hour window reset, but the account is limited on the week at 60%.
    const limitedOnWeek = createMockAccountUsage({
      state: 'limited',
      limit: { window: 'seven_day', resetsAt: '2026-10-01T09:00:00.000Z' },
      windows: [
        usageWindow({ usedPct: 100, expired: true }),
        usageWindow({ key: 'seven_day', label: 'Weekly', usedPct: 60, resetsAt: null }),
      ],
    });
    expect(accountUsageToStatus(limitedOnWeek, NOW)?.state).toBe('exhausted');
  });

  it('returns null for a spend-only record, so pay-as-you-go keeps showing', () => {
    const spendOnly = createMockAccountUsage({
      runtime: 'opencode',
      accountId: 'default',
      windows: [],
      spend: {
        periodStart: '2026-09-01T00:00:00.000Z',
        costUsd: 4.2,
        limitUsd: null,
        observedAt: '2026-09-28T11:00:00.000Z',
        source: 'sidecar',
      },
    });
    expect(accountUsageToStatus(spendOnly, NOW)).toBeNull();
  });

  it('returns null with no reading, never a 0%', () => {
    expect(accountUsageToStatus(null, NOW)).toBeNull();
    expect(accountUsageToStatus(account([usageWindow({ usedPct: null })], 'unknown'), NOW)).toBe(
      null
    );
  });
});

describe('withExpiredWindows', () => {
  it('marks a window past its reset the way the server does, so every surface agrees', () => {
    const past = account([
      usageWindow({ usedPct: 95, status: 'allowed_warning', resetsAt: '2026-09-28T11:00:00.000Z' }),
      usageWindow({ key: 'seven_day', usedPct: 30, resetsAt: null }),
    ]);
    const [fiveHour, week] = withExpiredWindows(past, NOW)!.windows;
    expect(fiveHour).toMatchObject({ expired: true, usedPct: 0, status: null });
    expect(week).toMatchObject({ expired: false, usedPct: 30 });
  });

  it("reads the account's state and limit again from the windows still in force", () => {
    const limitedOnFiveHour = createMockAccountUsage({
      state: 'limited',
      limit: { window: 'five_hour', resetsAt: '2026-09-28T11:00:00.000Z' },
      windows: [
        usageWindow({ usedPct: 100, status: 'rejected', resetsAt: '2026-09-28T11:00:00.000Z' }),
        usageWindow({ key: 'seven_day', usedPct: 30, resetsAt: null }),
      ],
    });
    const read = withExpiredWindows(limitedOnFiveHour, NOW)!;
    expect(read.state).toBe('ok');
    expect(read.limit).toBeNull();
  });

  it('returns the same record when nothing has reset', () => {
    const fresh = account([usageWindow({ resetsAt: null })]);
    expect(withExpiredWindows(fresh, NOW)).toBe(fresh);
    expect(withExpiredWindows(null, NOW)).toBeNull();
  });
});

describe('readableWindows, newestObservedAt and isWindowExpired', () => {
  it('keeps windows with a reading and expired ones, and dates them by the newest', () => {
    const windows = readableWindows(
      account([
        usageWindow({ observedAt: '2026-09-28T11:00:00.000Z' }),
        usageWindow({ key: 'seven_day', usedPct: null, observedAt: '2026-09-28T11:59:00.000Z' }),
        usageWindow({
          key: 'seven_day_opus',
          usedPct: 0,
          expired: true,
          observedAt: '2026-09-28T11:30:00.000Z',
        }),
      ])
    );
    expect(windows.map((w) => w.key)).toEqual(['five_hour', 'seven_day_opus']);
    expect(newestObservedAt(windows)).toBe('2026-09-28T11:30:00.000Z');
    expect(newestObservedAt([])).toBeNull();
  });

  it('reads a window as expired once its reset has passed', () => {
    expect(isWindowExpired(usageWindow({ resetsAt: '2026-09-28T12:00:00.000Z' }), NOW)).toBe(true);
    expect(isWindowExpired(usageWindow({ resetsAt: '2026-09-28T12:00:01.000Z' }), NOW)).toBe(false);
    expect(isWindowExpired(usageWindow({ resetsAt: null }), NOW)).toBe(false);
  });
});

describe('pickUsage — which usage wins', () => {
  const ACCOUNT: UsageStatus = { kind: 'subscription', utilization: 0.4, state: 'ok' };
  const TURN: UsageStatus = { kind: 'subscription', utilization: 0.55, costUsd: 1.2 };
  const ACCOUNT_AT = '2026-09-28T11:48:00.000Z';
  const before = Date.parse(ACCOUNT_AT) - 60_000;
  const after = Date.parse(ACCOUNT_AT) + 60_000;

  it.each([
    // [what, liveTurnUsage, liveTurnAt, accountStatus, expected source, expected utilization]
    ['a live frame after the account reading', TURN, after, ACCOUNT, 'live', 0.55],
    ['a live frame before the account reading', TURN, before, ACCOUNT, 'account', 0.4],
    ['a snapshot copy (no time) beside an account reading', TURN, null, ACCOUNT, 'account', 0.4],
    ['a snapshot copy with no account reading', TURN, null, null, 'snapshot', 0.55],
    ['a live frame with no account reading', TURN, after, null, 'live', 0.55],
    ['an account reading and no turn usage at all', null, null, ACCOUNT, 'account', 0.4],
  ] as const)('%s', (_what, liveTurnUsage, liveTurnAt, accountStatus, source, utilization) => {
    const picked = pickUsage({
      liveTurnUsage,
      liveTurnAt,
      accountStatus,
      accountObservedAt: accountStatus ? ACCOUNT_AT : null,
    });
    expect(picked.source).toBe(source);
    expect(picked.usage?.utilization).toBe(utilization);
  });

  it('dates each choice honestly: a snapshot copy is never "just now"', () => {
    expect(
      pickUsage({
        liveTurnUsage: TURN,
        liveTurnAt: null,
        accountStatus: null,
        accountObservedAt: null,
      }).observedAt
    ).toBeNull();
    expect(
      pickUsage({
        liveTurnUsage: TURN,
        liveTurnAt: null,
        accountStatus: ACCOUNT,
        accountObservedAt: ACCOUNT_AT,
      }).observedAt
    ).toBe(ACCOUNT_AT);
    expect(
      pickUsage({
        liveTurnUsage: TURN,
        liveTurnAt: after,
        accountStatus: ACCOUNT,
        accountObservedAt: ACCOUNT_AT,
      }).observedAt
    ).toBe(new Date(after).toISOString());
  });

  it("keeps the session's own cost beside the account's reading", () => {
    const picked = pickUsage({
      liveTurnUsage: TURN,
      liveTurnAt: null,
      accountStatus: ACCOUNT,
      accountObservedAt: ACCOUNT_AT,
    });
    expect(picked.usage).toEqual({ ...ACCOUNT, costUsd: 1.2 });
  });

  it('leaves a per-token (pay-as-you-go) session on its own cost', () => {
    const payg: UsageStatus = { kind: 'pay-as-you-go', costUsd: 0.42 };
    const picked = pickUsage({
      liveTurnUsage: payg,
      liveTurnAt: null,
      accountStatus: ACCOUNT,
      accountObservedAt: ACCOUNT_AT,
    });
    expect(picked.usage).toEqual(payg);
    expect(picked.source).toBe('snapshot');
  });

  it('has nothing to show with nothing on either side', () => {
    expect(
      pickUsage({
        liveTurnUsage: null,
        liveTurnAt: null,
        accountStatus: null,
        accountObservedAt: null,
      })
    ).toEqual({ usage: null, source: null, observedAt: null });
  });
});

describe('staleNumberClass', () => {
  it('mutes a stale number in the full muted color and leaves a fresh one alone', () => {
    expect(staleNumberClass(true)).toBe('text-muted-foreground');
    expect(staleNumberClass(false)).toBe('');
  });
});

describe('showsStaleMark', () => {
  const NOW = new Date('2026-09-28T12:00:00.000Z');
  const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
  const sub = { kind: 'subscription', utilization: 0.4 } as const;

  it('is true for a utilization number older than an hour', () => {
    expect(showsStaleMark(sub, ago(61), NOW)).toBe(true);
  });

  it('is false when fresh, when the time is unknown, or when no percent is drawn', () => {
    expect(showsStaleMark(sub, ago(59), NOW)).toBe(false);
    expect(showsStaleMark(sub, null, NOW)).toBe(false);
    expect(showsStaleMark({ kind: 'pay-as-you-go', costUsd: 1 }, ago(120), NOW)).toBe(false);
    expect(showsStaleMark(null, ago(120), NOW)).toBe(false);
  });
});
