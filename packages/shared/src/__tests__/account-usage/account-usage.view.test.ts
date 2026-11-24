import { describe, it, expect } from 'vitest';
import {
  SPEND_LIMIT_WINDOW,
  UsageLedgerSchema,
  codexObservations,
  parseStoredLedger,
  toAccountUsage,
  type LedgerEntry,
} from '../../account-usage.js';
import { NOW, at, MIN, HOUR, DAY, entry, ledger, identity } from './account-usage.fixtures.js';

describe('codexObservations', () => {
  const OBSERVED = '2026-09-26T16:00:00.000Z';
  const window = (used: number, minutes: number, resets: number | null = null) => ({
    used_percent: used,
    window_minutes: minutes,
    resets_at: resets,
  });

  it('maps the main limit by length, then plan and credits', () => {
    expect(
      codexObservations(
        {
          limit_id: 'codex',
          primary: window(41.5, 300, 1790449200),
          secondary: window(12, 60),
          plan_type: 'pro',
          credits: { has_credits: true, unlimited: false, balance: '12.50' },
          rate_limit_reached_type: null,
        },
        OBSERVED,
        'rollout'
      )
    ).toEqual([
      {
        key: 'five_hour',
        usedPct: 41.5,
        resetsAt: '2026-09-26T19:00:00.000Z',
        windowMinutes: 300,
        status: null,
        observedAt: OBSERVED,
        source: 'rollout',
      },
      {
        key: 'window:60',
        usedPct: 12,
        resetsAt: null,
        windowMinutes: 60,
        status: null,
        observedAt: OBSERVED,
        source: 'rollout',
      },
      { kind: 'plan', name: 'pro', observedAt: OBSERVED, source: 'rollout' },
      {
        kind: 'credits',
        hasCredits: true,
        unlimited: false,
        balance: '12.50',
        observedAt: OBSERVED,
        source: 'rollout',
      },
    ]);
  });

  it('rejects only the windows that hit a reached limit', () => {
    const statuses = (rateLimits: Record<string, unknown>) =>
      codexObservations(
        { rate_limit_reached_type: 'rate_limit_reached', ...rateLimits },
        OBSERVED,
        'rollout'
      ).map((o) => ('key' in o ? [o.key, o.status] : null));
    // Every window at 100% or more.
    expect(statuses({ primary: window(100, 300), secondary: window(40, 10080) })).toEqual([
      ['five_hour', 'rejected'],
      ['seven_day', null],
    ]);
    // Both at 100%: both hit the limit, so both are rejected.
    expect(statuses({ primary: window(100, 300), secondary: window(100, 10080) })).toEqual([
      ['five_hour', 'rejected'],
      ['seven_day', 'rejected'],
    ]);
    // None at 100%: the single tightest, a tie going to the shorter window.
    expect(statuses({ primary: window(70, 300), secondary: window(90, 10080) })).toEqual([
      ['five_hour', null],
      ['seven_day', 'rejected'],
    ]);
    expect(statuses({ primary: window(80, 300), secondary: window(80, 10080) })).toEqual([
      ['five_hour', 'rejected'],
      ['seven_day', null],
    ]);
    // A model bucket's one window.
    expect(
      statuses({ limit_id: 'premium', primary: window(10, 300), secondary: window(20, 10080) })
    ).toEqual([['model:premium', 'rejected']]);
  });
});

describe('toAccountUsage', () => {
  const usage = (windows: Record<string, LedgerEntry>) =>
    toAccountUsage(ledger(windows), identity, NOW);

  it('is unknown with no ledger', () => {
    expect(toAccountUsage(null, identity, NOW)).toEqual({
      ...identity,
      runtime: 'claude-code',
      subscriptionType: null,
      plan: null,
      credits: null,
      spend: null,
      windows: [],
      state: 'unknown',
      limit: null,
      updatedAt: null,
    });
  });

  // DOR-4620. Red when: a plan window with no readable share is left unnamed, so it reads as fine.
  describe('names plan windows whose share cannot be read, with since when', () => {
    it('a reading with no share: unknown from its own time', () => {
      const out = usage({
        five_hour: entry({ usedPct: 20 }),
        seven_day: entry({ usedPct: null, status: 'allowed', observedAt: at(-2 * HOUR) }),
      });
      expect(out.state).toBe('ok');
      expect(out.unknown).toEqual([{ key: 'seven_day', label: 'Weekly', since: at(-2 * HOUR) }]);
    });
  });

  it('is ok below 90 and warning at 90', () => {
    expect(usage({ seven_day: entry({ usedPct: 89.9 }) }).state).toBe('ok');
    expect(usage({ seven_day: entry({ usedPct: 90 }) }).state).toBe('warning');
  });

  it('is limited on a rejected window, naming the first one in display order', () => {
    const out = usage({
      seven_day: entry({ usedPct: null, status: 'rejected', resetsAt: at(DAY) }),
      five_hour: entry({ usedPct: null, status: 'rejected', resetsAt: at(HOUR) }),
    });
    expect(out.state).toBe('limited');
    expect(out.limit).toEqual({ window: 'five_hour', resetsAt: at(HOUR) });
  });

  describe('metered and local accounts', () => {
    const spend = (costUsd: number, limitUsd: number | null) => ({
      periodStart: '2026-09-01T00:00:00.000Z',
      costUsd,
      limitUsd,
      observedAt: at(-MIN),
      source: 'sidecar' as const,
    });
    const opencode = (
      extra: Record<string, unknown> = {},
      windows: Record<string, LedgerEntry> = {}
    ) => ({
      ...ledger(windows),
      runtime: 'opencode' as const,
      accountId: 'default',
      ...extra,
    });
    const who = { accountId: 'default', path: '', label: null, color: '#123456' };

    it('is limited at its cap and ok under it or with no cap', () => {
      const reached = toAccountUsage(opencode({ spend: spend(25, 25) }), who, NOW);
      expect(reached.state).toBe('limited');
      expect(reached.limit).toEqual({ window: SPEND_LIMIT_WINDOW, resetsAt: null });
      expect(toAccountUsage(opencode({ spend: spend(20, 25) }), who, NOW).state).toBe('ok');
      expect(toAccountUsage(opencode({ spend: spend(310, null) }), who, NOW).state).toBe('ok');
    });
  });
});

describe('parseStoredLedger (DOR-2471)', () => {
  const good = { usedPct: 12, observedAt: '2026-09-26T11:00:00.000Z', source: 'sdk_event' };
  const file = (extra: Record<string, unknown>) => ({
    v: 1,
    runtime: 'claude-code',
    accountId: 'work',
    updatedAt: '2026-09-26T11:00:00.000Z',
    windows: { seven_day: good },
    ...extra,
  });

  // Purpose: one entry a newer writer adds never blanks the account.
  it('sets aside a bad window, key, fact or runtime and reads the rest', () => {
    const read = parseStoredLedger(
      file({
        runtime: 'a-future-runtime',
        windows: {
          seven_day: good,
          five_hour: { ...good, source: 'a-future-source' },
          'Not-A-Key': good,
        },
        plan: { name: 'pro', observedAt: good.observedAt, source: 'rollout' },
        credits: { hasCredits: 'yes' },
      })
    );
    expect(read.ledger).not.toBeNull();
    expect(Object.keys(read.ledger!.windows)).toEqual(['seven_day']);
    expect(read.ledger).not.toHaveProperty('runtime');
    expect(read.ledger).not.toHaveProperty('credits');
    expect(read.ledger!.plan?.name).toBe('pro');
    expect(read.dropped.sort()).toEqual(
      ['credits', 'runtime', 'windows.Not-A-Key', 'windows.five_hour'].sort()
    );
  });

  it('reads anything that is not a version-1 ledger as no ledger', () => {
    for (const value of [
      null,
      [],
      'x',
      file({ v: 2 }),
      file({ windows: [] }),
      file({ accountId: '../x' }),
    ]) {
      expect(parseStoredLedger(value).ledger).toBeNull();
    }
  });

  it('keeps unknown top-level fields and reads a clean file unchanged', () => {
    const clean = file({ writer: 'flow 9.9' });
    const read = parseStoredLedger(clean);
    expect(read).toEqual({ ledger: UsageLedgerSchema.parse(clean), dropped: [] });
    expect(read.ledger).toMatchObject({ writer: 'flow 9.9' });
  });
});
