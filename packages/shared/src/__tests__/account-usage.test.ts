import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_ID_PATTERN,
  DEFAULT_ACCOUNT_COLORS,
  FLOW_FLEET_SETTINGS_TAB_ID,
  IMPLICIT_ACCOUNT_ID,
  SPEND_LIMIT_WINDOW,
  UsageLedgerSchema,
  codexObservations,
  ledgerSlug,
  mergeLedger,
  modelWindowKey,
  nextAccountColor,
  readWindow,
  resolveAccountColor,
  toAccountUsage,
  type LedgerEntry,
  type LedgerObservation,
  type MergeLedgerResult,
  type UsageLedger,
} from '../account-usage.js';

const NOW = new Date('2026-09-26T12:00:00.000Z');
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    usedPct: 40,
    resetsAt: null,
    status: null,
    observedAt: at(-MIN),
    source: 'statusline',
    ...overrides,
  };
}

function ledger(windows: Record<string, LedgerEntry>, extra: Record<string, unknown> = {}) {
  return {
    v: 1 as const,
    runtime: 'claude-code' as const,
    accountId: 'claude3',
    updatedAt: at(-HOUR),
    windows,
    ...extra,
  } satisfies UsageLedger;
}

const OWNER = { runtime: 'claude-code', accountId: 'claude3' } as const;
const CODEX = { runtime: 'codex', accountId: IMPLICIT_ACCOUNT_ID } as const;
const OPENCODE = { runtime: 'opencode', accountId: IMPLICIT_ACCOUNT_ID } as const;

const obs = (key: string, overrides: Partial<LedgerEntry> = {}): LedgerObservation => ({
  key,
  ...entry(overrides),
});

/** The ledger a merge wrote, failing the test when it wrote nothing. */
function written(out: MergeLedgerResult): UsageLedger {
  if (!out.changed) throw new Error('expected the merge to write the ledger');
  return out.ledger;
}

const identity = {
  accountId: 'claude3',
  path: '/home/u/.claude3',
  label: 'Three',
  color: '#123456',
};

describe('readWindow', () => {
  it('reads an expired window as reset to 0 and allowed', () => {
    const e = entry({ usedPct: 97, status: 'rejected', resetsAt: at(-1) });
    expect(readWindow(e, NOW, 'five_hour')).toEqual({
      ...e,
      usedPct: 0,
      status: 'allowed',
      expired: true,
    });
  });

  it('treats now exactly at resetsAt as expired', () => {
    expect(readWindow(entry({ resetsAt: at(0) }), NOW, 'seven_day')?.expired).toBe(true);
  });

  it('reads a window before its reset as stored, however old', () => {
    const e = entry({ resetsAt: at(HOUR), observedAt: at(-30 * DAY), status: 'allowed_warning' });
    expect(readWindow(e, NOW, 'five_hour')).toEqual({ ...e, expired: false });
  });

  it('reads five_hour with no reset as stale only after 5 hours', () => {
    expect(readWindow(entry({ observedAt: at(-5 * HOUR) }), NOW, 'five_hour')).not.toBeNull();
    expect(readWindow(entry({ observedAt: at(-5 * HOUR - 1) }), NOW, 'five_hour')).toBeNull();
  });

  it('reads every other key with no reset as stale only after 7 days', () => {
    const sixHours = entry({ observedAt: at(-6 * HOUR) });
    expect(readWindow(sixHours, NOW, 'seven_day')).toEqual({ ...sixHours, expired: false });
    expect(readWindow(entry({ observedAt: at(-7 * DAY) }), NOW, 'model:opus')).not.toBeNull();
    expect(readWindow(entry({ observedAt: at(-7 * DAY - 1) }), NOW, 'model:opus')).toBeNull();
  });

  it('uses windowMinutes, then the window:<minutes> length, for the stale age', () => {
    const e = (age: number, extra: Partial<LedgerEntry> = {}) =>
      entry({ observedAt: at(-age), ...extra });
    expect(readWindow(e(HOUR, { windowMinutes: 60 }), NOW, 'model:x')).not.toBeNull();
    expect(readWindow(e(HOUR + 1, { windowMinutes: 60 }), NOW, 'model:x')).toBeNull();
    expect(readWindow(e(HOUR), NOW, 'window:60')).not.toBeNull();
    expect(readWindow(e(HOUR + 1), NOW, 'window:60')).toBeNull();
  });

  it('makes credits:* and rate_limit:* error signals stale after an hour', () => {
    const signal = (age: number) =>
      entry({ usedPct: null, status: 'rejected', source: 'error', observedAt: at(-age) });
    expect(readWindow(signal(HOUR), NOW, 'credits:openrouter')).not.toBeNull();
    expect(readWindow(signal(HOUR + 1), NOW, 'credits:openrouter')).toBeNull();
    expect(readWindow(signal(HOUR + 1), NOW, 'rate_limit:openrouter')).toBeNull();
  });

  it('reads no entry, or an invalid one, as no reading, and times back in UTC', () => {
    expect(readWindow(undefined, NOW, 'five_hour')).toBeNull();
    expect(readWindow(entry({ windowMinutes: 0 }), NOW, 'five_hour')).toBeNull();
    expect(
      readWindow({ ...entry(), observedAt: '2026-09-26T11:59:00' }, NOW, 'five_hour')
    ).toBeNull();
    const offset = entry({ observedAt: '2026-09-26T13:59:00+02:00' });
    expect(readWindow(offset, NOW, 'five_hour')?.observedAt).toBe('2026-09-26T11:59:00.000Z');
  });
});

describe('mergeLedger', () => {
  it('creates a ledger from nothing, naming the runtime', () => {
    const out = mergeLedger(null, [obs('five_hour')], NOW, OWNER);
    expect(out.warnings).toEqual([]);
    expect(written(out)).toEqual({
      v: 1,
      runtime: 'claude-code',
      accountId: 'claude3',
      updatedAt: NOW.toISOString(),
      windows: { five_hour: entry() },
    });
    expect(UsageLedgerSchema.safeParse(out.ledger).success).toBe(true);
  });

  it('replaces a window only with a strictly later observation', () => {
    const stored = ledger({ five_hour: entry({ usedPct: 40, observedAt: at(-10 * MIN) }) });
    const newer = mergeLedger(
      stored,
      [obs('five_hour', { usedPct: 50, observedAt: at(-5 * MIN) })],
      NOW,
      OWNER
    );
    expect(written(newer).windows.five_hour!.usedPct).toBe(50);
    expect(written(newer).updatedAt).toBe(NOW.toISOString());

    const older = mergeLedger(
      stored,
      [obs('five_hour', { usedPct: 60, observedAt: at(-20 * MIN) })],
      NOW,
      OWNER
    );
    expect(older).toEqual({ changed: false, ledger: stored, warnings: [] });
  });

  it('keeps the stored entry on an equal observedAt, so a replay is a no-op', () => {
    const stored = ledger({ five_hour: entry({ usedPct: 40, observedAt: at(-10 * MIN) }) });
    const out = mergeLedger(
      stored,
      [obs('five_hour', { usedPct: 70, observedAt: at(-10 * MIN) })],
      NOW,
      OWNER
    );
    expect(out.changed).toBe(false);
    expect(out.ledger).toBe(stored);
  });

  it('lets a newer observation win even with a lower usedPct (the window reset)', () => {
    const stored = ledger({ seven_day: entry({ usedPct: 95, observedAt: at(-HOUR) }) });
    const out = mergeLedger(stored, [obs('seven_day', { usedPct: 3 })], NOW, OWNER);
    expect(written(out).windows.seven_day!.usedPct).toBe(3);
  });

  it('drops an observation more than 5 minutes ahead; exactly 5 minutes is kept', () => {
    const out = mergeLedger(
      null,
      [
        obs('five_hour', { observedAt: at(5 * MIN + 1000) }),
        obs('seven_day', { observedAt: at(5 * MIN - 1000) }),
        obs('seven_day_opus', { observedAt: at(5 * MIN) }),
      ],
      NOW,
      OWNER
    );
    expect(out.warnings).toEqual([{ code: 'observation-future', key: 'five_hour' }]);
    expect(Object.keys(written(out).windows)).toEqual(['seven_day', 'seven_day_opus']);
  });

  it('drops invalid observations while the rest still merge', () => {
    const out = mergeLedger(
      null,
      [
        obs('Bad Key'),
        obs('five_hour', { usedPct: null, status: null }),
        { ...obs('seven_day'), observedAt: 'yesterday' },
        obs('window:0'),
        'not an object' as unknown as LedgerObservation,
        obs('seven_day_opus', { usedPct: 12 }),
      ],
      NOW,
      OWNER
    );
    expect(out.warnings.map((w) => w.code)).toEqual(Array(5).fill('observation-invalid'));
    expect(Object.keys(written(out).windows)).toEqual(['seven_day_opus']);
  });

  it('clamps usedPct and stores times in UTC; omitted fields read as null', () => {
    const out = mergeLedger(
      null,
      [
        obs('five_hour', { usedPct: 104.2, observedAt: '2026-09-26T13:58:00+02:00' }),
        obs('seven_day', { usedPct: -3 }),
        { key: 'credits:openrouter', status: 'rejected', observedAt: at(-MIN), source: 'error' },
      ],
      NOW,
      OPENCODE
    );
    const windows = written(out).windows;
    expect(windows.five_hour).toEqual(
      entry({ usedPct: 100, observedAt: '2026-09-26T11:58:00.000Z' })
    );
    expect(windows.seven_day!.usedPct).toBe(0);
    expect(windows['credits:openrouter']).toEqual(
      entry({ usedPct: null, status: 'rejected', source: 'error' })
    );
  });

  it('leaves a missing ledger missing when nothing valid arrives', () => {
    expect(mergeLedger(null, [obs('five_hour', { usedPct: null })], NOW, OWNER)).toEqual({
      changed: false,
      ledger: null,
      warnings: [{ code: 'observation-invalid', key: 'five_hour' }],
    });
  });

  it('leaves a ledger of another version alone, and starts over on a non-ledger', () => {
    const v2 = { v: 2, accountId: 'claude3', updatedAt: at(0), windows: {} };
    expect(mergeLedger(v2, [obs('five_hour')], NOW, OWNER)).toEqual({
      changed: false,
      ledger: v2,
      warnings: [{ code: 'ledger-version-unknown' }],
    });
    const out = mergeLedger(['nope'], [obs('five_hour')], NOW, OWNER);
    expect(out.warnings).toEqual([{ code: 'ledger-invalid' }]);
    expect(Object.keys(written(out).windows)).toEqual(['five_hour']);
  });

  it("rewrites a ledger whose runtime or account is not the path's, even with no new reading", () => {
    const legacy = {
      v: 1,
      accountId: 'claude3',
      updatedAt: at(-HOUR),
      windows: { five_hour: entry() },
    };
    const out = mergeLedger(legacy, [], NOW, OWNER);
    expect(written(out)).toMatchObject({ runtime: 'claude-code', windows: { five_hour: entry() } });
    expect(written(mergeLedger(ledger({}), [], NOW, CODEX))).toMatchObject({
      runtime: 'codex',
      accountId: 'default',
    });
    expect(mergeLedger(ledger({}), [], NOW, OWNER).changed).toBe(false);
  });

  it('replaces a stored entry that is not valid with any valid observation', () => {
    const stored = {
      ...ledger({}),
      windows: { five_hour: { usedPct: 10, observedAt: 'yesterday' } },
    };
    const out = mergeLedger(stored, [obs('five_hour', { observedAt: at(-DAY) })], NOW, OWNER);
    expect(written(out).windows.five_hour).toEqual(entry({ observedAt: at(-DAY) }));
  });

  it('keeps unknown window keys and unknown top-level fields', () => {
    const stored = ledger(
      { future_window: entry({ usedPct: 7 }), 'model:opus': entry({ usedPct: 8 }) },
      { writer: 'flow 1.2' }
    );
    const out = written(mergeLedger(stored, [obs('five_hour', { observedAt: at(0) })], NOW, OWNER));
    expect(out.windows.future_window!.usedPct).toBe(7);
    expect(out.windows['model:opus']!.usedPct).toBe(8);
    expect(UsageLedgerSchema.parse(out)).toMatchObject({ writer: 'flow 1.2' });
  });

  describe('facts', () => {
    const spend = (overrides: Record<string, unknown> = {}) => ({
      kind: 'spend' as const,
      periodStart: '2026-09-01T00:00:00.000Z',
      costUsd: 4.2,
      observedAt: at(-MIN),
      source: 'sidecar' as const,
      ...overrides,
    });

    it('stores plan, credits and spend like windows: newest observedAt wins', () => {
      const stored = {
        ...ledger({}),
        runtime: 'codex' as const,
        accountId: 'default',
        plan: { name: 'plus', observedAt: at(-HOUR), source: 'rollout' as const },
        spend: { ...spend({ observedAt: at(-30 * MIN) }), kind: undefined, limitUsd: null },
      };
      delete (stored.spend as Record<string, unknown>).kind;
      const out = written(
        mergeLedger(
          stored,
          [
            { kind: 'plan', name: 'pro', observedAt: at(-MIN), source: 'rollout' },
            {
              kind: 'credits',
              hasCredits: true,
              unlimited: false,
              observedAt: at(-MIN),
              source: 'rollout',
            },
            spend({ costUsd: 3, observedAt: at(-40 * MIN) }),
          ],
          NOW,
          CODEX
        )
      );
      expect(out.plan).toEqual({ name: 'pro', observedAt: at(-MIN), source: 'rollout' });
      // A missing balance is stored as null.
      expect(out.credits).toEqual({
        hasCredits: true,
        unlimited: false,
        balance: null,
        observedAt: at(-MIN),
        source: 'rollout',
      });
      expect(out.spend?.costUsd).toBe(4.2);
    });

    it('stores a spend with no cap as limitUsd null, and keeps a cap', () => {
      const first = written(mergeLedger(null, [spend()], NOW, OPENCODE));
      expect(first.spend).toMatchObject({ costUsd: 4.2, limitUsd: null });
      const capped = written(mergeLedger(null, [spend({ limitUsd: 25 })], NOW, OPENCODE));
      expect(capped.spend?.limitUsd).toBe(25);
    });

    it('drops an invalid fact, an unknown kind and a fact from the future', () => {
      const out = mergeLedger(
        null,
        [
          spend({ costUsd: -1 }),
          spend({ limitUsd: 0 }),
          { kind: 'plan', name: '', observedAt: at(0), source: 'rollout' },
          { kind: 'mood', observedAt: at(0), source: 'sidecar' } as unknown as LedgerObservation,
          spend({ observedAt: at(5 * MIN + 1000) }),
        ],
        NOW,
        OPENCODE
      );
      expect(out.changed).toBe(false);
      expect(out.warnings.map((w) => w.code)).toEqual([
        'observation-invalid',
        'observation-invalid',
        'observation-invalid',
        'observation-invalid',
        'observation-future',
      ]);
    });
  });
});

describe('ledgerSlug and modelWindowKey', () => {
  it.each([
    ['Fable', 'model:fable'],
    ['Claude Opus 4.1', 'model:claude-opus-4.1'],
    ['GPT-5.3-Codex-Spark', 'model:gpt-5.3-codex-spark'],
    ['  --Sonnet!!  ', 'model:sonnet'],
    ['.hidden', 'model:hidden'],
    ['_x', 'model:x'],
    ['  ', null],
    ['', null],
    ['!!!', null],
  ])('%j → %j', (name, key) => {
    expect(modelWindowKey(name)).toBe(key);
  });

  it('slugs a provider id for credits:<slug> keys', () => {
    expect(ledgerSlug('Open Router')).toBe('open-router');
  });
});

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

  it('keys by length, not slot: a weekly primary is seven_day', () => {
    const [first] = codexObservations({ primary: window(5, 10080) }, OBSERVED, 'rollout');
    expect(first).toMatchObject({ key: 'seven_day', windowMinutes: 10080 });
  });

  it('turns another limit into one model bucket with its tightest window, a tie to the longer', () => {
    const spark = codexObservations(
      {
        limit_id: 'codex_bengalfox',
        limit_name: 'GPT-5.3-Codex-Spark',
        primary: window(30, 300),
        secondary: window(64, 10080),
      },
      OBSERVED,
      'rollout'
    );
    expect(spark).toEqual([
      expect.objectContaining({
        key: 'model:gpt-5.3-codex-spark',
        usedPct: 64,
        windowMinutes: 10080,
      }),
    ]);
    const tie = codexObservations(
      { limit_id: 'premium', primary: window(50, 300), secondary: window(50, 10080) },
      OBSERVED,
      'rollout'
    );
    expect(tie).toEqual([expect.objectContaining({ key: 'model:premium', windowMinutes: 10080 })]);
  });

  it('marks a reached limit rejected and skips unusable windows and bad facts', () => {
    const reached = codexObservations(
      { primary: window(100, 300), rate_limit_reached_type: 'rate_limit_reached' },
      OBSERVED,
      'rollout'
    );
    expect(reached).toEqual([expect.objectContaining({ key: 'five_hour', status: 'rejected' })]);
    expect(
      codexObservations(
        {
          primary: { used_percent: 20, window_minutes: null },
          secondary: { used_percent: 'high', window_minutes: 10080 },
          plan_type: '',
          credits: { has_credits: true },
        },
        OBSERVED,
        'rollout'
      )
    ).toEqual([]);
    expect(codexObservations(null, OBSERVED, 'rollout')).toEqual([]);
  });

  it('produces observations mergeLedger accepts', () => {
    const observations = codexObservations(
      { primary: window(10, 300), plan_type: 'plus' },
      at(-MIN),
      'rollout'
    );
    const out = mergeLedger(null, observations, NOW, CODEX);
    expect(out.warnings).toEqual([]);
    expect(written(out)).toMatchObject({
      plan: { name: 'plus' },
      windows: { five_hour: { usedPct: 10 } },
    });
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

  it('is unknown when every window is stale, and leaves stale windows out', () => {
    const out = usage({ five_hour: entry({ observedAt: at(-6 * HOUR) }) });
    expect(out.windows).toEqual([]);
    expect(out.state).toBe('unknown');
  });

  it('is ok below 90 and warning at 90', () => {
    expect(usage({ seven_day: entry({ usedPct: 89.9 }) }).state).toBe('ok');
    expect(usage({ seven_day: entry({ usedPct: 90 }) }).state).toBe('warning');
  });

  it('is warning on allowed_warning at a low usedPct', () => {
    expect(usage({ five_hour: entry({ usedPct: 10, status: 'allowed_warning' }) }).state).toBe(
      'warning'
    );
  });

  it('is limited on a rejected window, naming the first one in display order', () => {
    const out = usage({
      seven_day: entry({ usedPct: null, status: 'rejected', resetsAt: at(DAY) }),
      five_hour: entry({ usedPct: null, status: 'rejected', resetsAt: at(HOUR) }),
    });
    expect(out.state).toBe('limited');
    expect(out.limit).toEqual({ window: 'five_hour', resetsAt: at(HOUR) });
  });

  it('is limited by a credits:<slug> error signal', () => {
    const out = usage({
      five_hour: entry({ usedPct: 10 }),
      'credits:openai': entry({ usedPct: null, status: 'rejected', source: 'error' }),
    });
    expect(out.limit).toEqual({ window: 'credits:openai', resetsAt: null });
  });

  it('reads an expired rejected window as ok again', () => {
    const out = usage({ five_hour: entry({ usedPct: 100, status: 'rejected', resetsAt: at(-1) }) });
    expect(out.state).toBe('ok');
    expect(out.limit).toBeNull();
    expect(out.windows[0]).toMatchObject({ usedPct: 0, status: 'allowed', expired: true });
  });

  it('orders windows known first, then other keys, then model buckets, with labels', () => {
    const out = usage({
      'model:sonnet': entry(),
      overage: entry(),
      seven_day_sonnet: entry(),
      'model:fable': entry(),
      seven_day_oauth_apps: entry(),
      seven_day: entry(),
      seven_day_opus: entry(),
      five_hour: entry(),
      brand_new: entry(),
    });
    expect(out.windows.map((w) => [w.key, w.label])).toEqual([
      ['five_hour', '5-hour window'],
      ['seven_day', 'Weekly'],
      ['seven_day_opus', 'Weekly Opus'],
      ['seven_day_sonnet', 'Weekly Sonnet'],
      ['brand_new', 'brand_new'],
      ['overage', 'Extra usage'],
      ['seven_day_oauth_apps', 'Weekly OAuth apps'],
      ['model:fable', 'Weekly fable'],
      ['model:sonnet', 'Weekly sonnet'],
    ]);
  });

  it('carries identity, subscription type and the ledger updatedAt', () => {
    const out = toAccountUsage(ledger({ five_hour: entry() }), identity, NOW, 'max');
    expect(out).toMatchObject({ ...identity, subscriptionType: 'max', updatedAt: at(-HOUR) });
    expect(out.windows[0]).toEqual({
      key: 'five_hour',
      label: '5-hour window',
      usedPct: 40,
      resetsAt: null,
      status: null,
      expired: false,
      observedAt: at(-MIN),
      source: 'statusline',
    });
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

    it('never treats an old spend reading as stale or reset', () => {
      const old = {
        ...spend(25, 25),
        periodStart: '2026-01-01T00:00:00.000Z',
        observedAt: '2026-01-31T00:00:00.000Z',
      };
      expect(toAccountUsage(opencode({ spend: old }), who, NOW)).toMatchObject({
        state: 'limited',
        spend: old,
      });
    });

    it('is ok with nothing to report on OpenCode (a local model), unknown elsewhere', () => {
      expect(toAccountUsage(opencode(), who, NOW).state).toBe('ok');
      expect(toAccountUsage(null, { ...who, runtime: 'opencode' }, NOW).state).toBe('ok');
      expect(toAccountUsage(null, { ...who, runtime: 'codex' }, NOW).state).toBe('unknown');
      expect(toAccountUsage({ ...opencode(), runtime: 'codex' }, who, NOW).state).toBe('unknown');
    });

    it("takes the runtime from the identity (the ledger's folder) over the ledger's own field", () => {
      const misfiled = { ...ledger({ five_hour: entry() }), runtime: 'codex' as const };
      expect(toAccountUsage(misfiled, { ...who, runtime: 'claude-code' }, NOW).runtime).toBe(
        'claude-code'
      );
    });

    it('carries plan and credits facts', () => {
      const plan = { name: 'pro', observedAt: at(-MIN), source: 'rollout' as const };
      const credits = {
        hasCredits: true,
        unlimited: true,
        balance: null,
        observedAt: at(-MIN),
        source: 'rollout' as const,
      };
      expect(toAccountUsage(opencode({ plan, credits }), who, NOW)).toMatchObject({
        plan,
        credits,
      });
    });
  });
});

describe('account colors and ids', () => {
  it('has eight lowercase #rrggbb defaults', () => {
    expect(DEFAULT_ACCOUNT_COLORS).toHaveLength(8);
    for (const c of DEFAULT_ACCOUNT_COLORS) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(DEFAULT_ACCOUNT_COLORS).size).toBe(8);
  });

  it('resolves a valid stored color, else the default by position with wrap-around', () => {
    expect(resolveAccountColor('#abcdef', 3)).toBe('#abcdef');
    expect(resolveAccountColor(null, 2)).toBe(DEFAULT_ACCOUNT_COLORS[2]);
    expect(resolveAccountColor(undefined, 0)).toBe(DEFAULT_ACCOUNT_COLORS[0]);
    expect(resolveAccountColor('#ABCDEF', 1)).toBe(DEFAULT_ACCOUNT_COLORS[1]);
    expect(resolveAccountColor('red', 1)).toBe(DEFAULT_ACCOUNT_COLORS[1]);
    expect(resolveAccountColor(null, 9)).toBe(DEFAULT_ACCOUNT_COLORS[1]);
    expect(resolveAccountColor(null, -1)).toBe(DEFAULT_ACCOUNT_COLORS[7]);
  });

  it('picks the first palette color not taken, else the positional default', () => {
    expect(nextAccountColor([], 5)).toBe(DEFAULT_ACCOUNT_COLORS[0]);
    expect(nextAccountColor([DEFAULT_ACCOUNT_COLORS[0]!, '#000000'], 5)).toBe(
      DEFAULT_ACCOUNT_COLORS[1]
    );
    expect(nextAccountColor(DEFAULT_ACCOUNT_COLORS, 10)).toBe(DEFAULT_ACCOUNT_COLORS[2]);
  });

  it('pins the id pattern, the implicit id and the fleet tab id', () => {
    expect(ACCOUNT_ID_PATTERN.test('claude3')).toBe(true);
    expect(ACCOUNT_ID_PATTERN.test('work-2')).toBe(true);
    for (const bad of ['', 'Claude', '-a', 'a-', 'a--b', '../x', 'a_b']) {
      expect(ACCOUNT_ID_PATTERN.test(bad)).toBe(false);
    }
    expect(IMPLICIT_ACCOUNT_ID).toBe('default');
    expect(ACCOUNT_ID_PATTERN.test(IMPLICIT_ACCOUNT_ID)).toBe(true);
    expect(FLOW_FLEET_SETTINGS_TAB_ID).toBe('flow:fleet');
  });
});
