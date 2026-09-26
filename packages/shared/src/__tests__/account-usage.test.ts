import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_ID_PATTERN,
  DEFAULT_ACCOUNT_COLORS,
  IMPLICIT_ACCOUNT_ID,
  SPEND_LIMIT_WINDOW,
  FLOW_FLEET_SETTINGS_TAB_ID,
  UsageLedgerSchema,
  mergeLedger,
  modelWindowKey,
  readSpend,
  nextAccountColor,
  readWindow,
  resolveAccountColor,
  toAccountUsage,
  type LedgerEntry,
  type LedgerObservation,
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

const OWNER = { accountId: 'claude3', runtime: 'claude-code' } as const;

const identity = {
  accountId: 'claude3',
  path: '/home/u/.claude3',
  label: 'Three',
  color: '#123456',
};

describe('readWindow', () => {
  it('reads an expired window as reset to 0 and allowed', () => {
    const e = entry({ usedPct: 97, status: 'rejected', resetsAt: at(-1) });
    expect(readWindow('five_hour', e, NOW)).toEqual({
      ...e,
      usedPct: 0,
      status: 'allowed',
      expired: true,
    });
  });

  it('treats now exactly at resetsAt as expired', () => {
    const e = entry({ resetsAt: at(0) });
    expect(readWindow('seven_day', e, NOW)?.expired).toBe(true);
  });

  it('reads a window before its reset as stored', () => {
    const e = entry({ resetsAt: at(HOUR), usedPct: 55, status: 'allowed_warning' });
    expect(readWindow('five_hour', e, NOW)).toEqual({ ...e, expired: false });
  });

  it('keeps a reading with a reset time as stored however old it is', () => {
    const e = entry({ resetsAt: at(HOUR), observedAt: at(-30 * DAY) });
    expect(readWindow('five_hour', e, NOW)).toEqual({ ...e, expired: false });
  });

  it('reads five_hour with no reset as stale only after 5 hours', () => {
    expect(readWindow('five_hour', entry({ observedAt: at(-5 * HOUR) }), NOW)).not.toBeNull();
    expect(readWindow('five_hour', entry({ observedAt: at(-5 * HOUR - 1) }), NOW)).toBeNull();
  });

  it('reads every other key with no reset as stale only after 7 days', () => {
    const sixHours = entry({ observedAt: at(-6 * HOUR) });
    expect(readWindow('seven_day', sixHours, NOW)).toEqual({ ...sixHours, expired: false });
    expect(readWindow('model:opus', entry({ observedAt: at(-7 * DAY) }), NOW)).not.toBeNull();
    expect(readWindow('model:opus', entry({ observedAt: at(-7 * DAY - 1) }), NOW)).toBeNull();
    expect(readWindow('overage', entry({ observedAt: at(-7 * DAY - 1) }), NOW)).toBeNull();
  });
});

describe('mergeLedger', () => {
  const obs = (key: string, overrides: Partial<LedgerEntry> = {}): LedgerObservation => ({
    key,
    ...entry(overrides),
  });

  it('creates a ledger from nothing', () => {
    const { ledger: out, changed, dropped } = mergeLedger(null, [obs('five_hour')], NOW, OWNER);
    expect(changed).toBe(true);
    expect(dropped).toEqual([]);
    expect(out).toEqual({
      v: 1,
      runtime: 'claude-code',
      accountId: 'claude3',
      updatedAt: NOW.toISOString(),
      windows: { five_hour: entry() },
    });
    expect(UsageLedgerSchema.safeParse(out).success).toBe(true);
  });

  it('replaces a window only with a strictly later observation', () => {
    const stored = ledger({ five_hour: entry({ usedPct: 40, observedAt: at(-10 * MIN) }) });
    const newer = mergeLedger(
      stored,
      [obs('five_hour', { usedPct: 50, observedAt: at(-5 * MIN) })],
      NOW,
      OWNER
    );
    expect(newer.changed).toBe(true);
    expect(newer.ledger.windows.five_hour!.usedPct).toBe(50);
    expect(newer.ledger.updatedAt).toBe(NOW.toISOString());

    const older = mergeLedger(
      stored,
      [obs('five_hour', { usedPct: 60, observedAt: at(-20 * MIN) })],
      NOW,
      OWNER
    );
    expect(older.changed).toBe(false);
    expect(older.ledger.windows.five_hour!.usedPct).toBe(40);
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
    expect(out.ledger).toEqual(stored);
    expect(out.ledger.updatedAt).toBe(stored.updatedAt);
  });

  it('lets a newer observation win even with a lower usedPct (the window reset)', () => {
    const stored = ledger({ seven_day: entry({ usedPct: 95, observedAt: at(-HOUR) }) });
    const out = mergeLedger(
      stored,
      [obs('seven_day', { usedPct: 3, observedAt: at(-MIN) })],
      NOW,
      OWNER
    );
    expect(out.ledger.windows.seven_day!.usedPct).toBe(3);
  });

  it('drops an observation more than 5 minutes in the future and keeps one just inside', () => {
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
    expect(out.dropped).toEqual([{ key: 'five_hour', reason: expect.any(String) }]);
    // Exactly +5:00 is kept: only MORE than 5 minutes ahead is dropped.
    expect(Object.keys(out.ledger.windows)).toEqual(['seven_day', 'seven_day_opus']);
  });

  it('drops invalid observations while the rest still merge', () => {
    const out = mergeLedger(
      null,
      [
        obs('Bad Key'),
        obs('five_hour', { usedPct: null, status: null }),
        { ...obs('seven_day'), observedAt: 'yesterday' },
        obs('seven_day_opus', { usedPct: 12 }),
      ],
      NOW,
      OWNER
    );
    expect(out.dropped.map((d) => d.key)).toEqual(['Bad Key', 'five_hour', 'seven_day']);
    expect(Object.keys(out.ledger.windows)).toEqual(['seven_day_opus']);
    expect(out.changed).toBe(true);
  });

  it('clamps usedPct to 0..100 before validating', () => {
    const out = mergeLedger(
      null,
      [obs('five_hour', { usedPct: 104.2 }), obs('seven_day', { usedPct: -3 })],
      NOW,
      OWNER
    );
    expect(out.dropped).toEqual([]);
    expect(out.ledger.windows.five_hour!.usedPct).toBe(100);
    expect(out.ledger.windows.seven_day!.usedPct).toBe(0);
  });

  it('leaves updatedAt and the ledger untouched when nothing changed', () => {
    const stored = ledger({ five_hour: entry() });
    const out = mergeLedger(stored, [], NOW, OWNER);
    expect(out.changed).toBe(false);
    expect(out.ledger).toBe(stored);
  });

  it('keeps unknown window keys and unknown top-level fields', () => {
    const stored = ledger(
      { future_window: entry({ usedPct: 7 }), 'model:opus': entry({ usedPct: 8 }) },
      { writer: 'flow 1.2' }
    );
    const out = mergeLedger(stored, [obs('five_hour', { observedAt: at(0) })], NOW, OWNER);
    expect(out.changed).toBe(true);
    expect(out.ledger.windows.future_window!.usedPct).toBe(7);
    expect(out.ledger.windows['model:opus']!.usedPct).toBe(8);
    expect((out.ledger as Record<string, unknown>).writer).toBe('flow 1.2');
    expect(UsageLedgerSchema.parse(out.ledger)).toMatchObject({ writer: 'flow 1.2' });
  });
});

describe('modelWindowKey', () => {
  it.each([
    ['Fable', 'model:fable'],
    ['Claude Opus 4.1', 'model:claude-opus-4.1'],
    ['  --Sonnet!!  ', 'model:sonnet'],
    ['  ', null],
    ['', null],
    ['!!!', null],
    ['.hidden', null],
    ['_x', null],
  ])('%j → %j', (name, key) => {
    expect(modelWindowKey(name)).toBe(key);
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

  it('pins the id pattern and the fleet tab id', () => {
    expect(ACCOUNT_ID_PATTERN.test('claude3')).toBe(true);
    expect(ACCOUNT_ID_PATTERN.test('work-2')).toBe(true);
    for (const bad of ['', 'Claude', '-a', 'a-', 'a--b', '../x', 'a_b']) {
      expect(ACCOUNT_ID_PATTERN.test(bad)).toBe(false);
    }
    expect(FLOW_FLEET_SETTINGS_TAB_ID).toBe('flow:fleet');
  });
});

describe('runtime-neutral ledger', () => {
  const CODEX = { accountId: IMPLICIT_ACCOUNT_ID, runtime: 'codex' } as const;
  const spend = (overrides: Record<string, unknown> = {}) => ({
    periodStart: '2026-09-01T00:00:00.000Z',
    costUsd: 4.2,
    observedAt: at(-MIN),
    source: 'error' as const,
    ...overrides,
  });

  it('names the implicit account default, a valid ledger id', () => {
    expect(IMPLICIT_ACCOUNT_ID).toBe('default');
    expect(ACCOUNT_ID_PATTERN.test(IMPLICIT_ACCOUNT_ID)).toBe(true);
  });

  it('accepts a Codex ledger with a length-keyed window, plan and credits', () => {
    const codex = {
      v: 1,
      runtime: 'codex',
      accountId: 'default',
      updatedAt: at(0),
      windows: {
        five_hour: entry({ source: 'rollout', windowMinutes: 300 }),
        'window:60': entry({ source: 'rollout', windowMinutes: 60 }),
      },
      plan: 'pro',
      credits: { hasCredits: true, unlimited: false, balance: '12.50' },
    };
    expect(UsageLedgerSchema.parse(codex)).toEqual(codex);
  });

  it('parses a v1 ledger with no runtime (the folder names it), refuses an unknown one', () => {
    const base = { v: 1, accountId: 'default', updatedAt: at(0), windows: {} };
    expect(UsageLedgerSchema.safeParse(base).success).toBe(true);
    expect(UsageLedgerSchema.safeParse({ ...base, runtime: 'gemini' }).success).toBe(false);
    expect(UsageLedgerSchema.safeParse({ ...base, runtime: 'opencode' }).success).toBe(true);
  });

  it('reads a window with no reset as stale after its own windowMinutes', () => {
    const e = (ms: number) => entry({ windowMinutes: 60, observedAt: at(-ms) });
    expect(readWindow('window:60', e(HOUR), NOW)).not.toBeNull();
    expect(readWindow('window:60', e(HOUR + 1), NOW)).toBeNull();
  });

  it('writes the runtime into a ledger that predates the field', () => {
    const legacy = UsageLedgerSchema.parse({
      v: 1,
      accountId: 'claude3',
      updatedAt: at(-HOUR),
      windows: { five_hour: entry() },
    });
    const out = mergeLedger(legacy, [{ key: 'seven_day', ...entry() }], NOW, OWNER);
    expect(out.ledger.runtime).toBe('claude-code');
    expect(out.ledger.windows.five_hour).toEqual(entry());
  });

  it('starts a new ledger for the given runtime and accepts the new sources', () => {
    const out = mergeLedger(
      null,
      [{ key: 'window:60', ...entry({ source: 'rollout', windowMinutes: 60 }) }],
      NOW,
      CODEX
    );
    expect(out.dropped).toEqual([]);
    expect(out.ledger).toMatchObject({ runtime: 'codex', accountId: 'default' });
    expect(UsageLedgerSchema.safeParse(out.ledger).success).toBe(true);
  });

  it('replaces plan and credits only when they differ', () => {
    const credits = { hasCredits: true, unlimited: false, balance: '3' };
    const stored = { ...ledger({}), runtime: 'codex' as const, plan: 'pro', credits };
    expect(mergeLedger(stored, [], NOW, CODEX, { plan: 'pro', credits }).changed).toBe(false);
    const out = mergeLedger(stored, [], NOW, CODEX, {
      plan: 'plus',
      credits: { ...credits, balance: '2' },
    });
    expect(out.changed).toBe(true);
    expect(out.ledger).toMatchObject({ plan: 'plus', credits: { balance: '2' } });
    expect(out.ledger.updatedAt).toBe(NOW.toISOString());
  });

  it('merges spend like a window: strictly later wins, equal keeps, future and invalid dropped', () => {
    const stored = { ...ledger({}), runtime: 'opencode' as const, spend: spend() };
    const later = mergeLedger(stored, [], NOW, CODEX, {
      spend: spend({ costUsd: 5, observedAt: at(0) }),
    });
    expect(later.ledger.spend?.costUsd).toBe(5);
    expect(mergeLedger(stored, [], NOW, CODEX, { spend: spend({ costUsd: 9 }) }).changed).toBe(
      false
    );
    const future = mergeLedger(stored, [], NOW, CODEX, {
      spend: spend({ observedAt: at(5 * MIN + 1000) }),
    });
    expect(future.changed).toBe(false);
    expect(future.dropped).toEqual([{ key: 'spend', reason: expect.any(String) }]);
    const invalid = mergeLedger(stored, [], NOW, CODEX, { spend: spend({ costUsd: -1 }) });
    expect(invalid.dropped).toEqual([{ key: 'spend', reason: 'invalid spend' }]);
  });

  describe('toAccountUsage for metered and local accounts', () => {
    const opencode = (
      extra: Record<string, unknown>,
      windows: Record<string, LedgerEntry> = {}
    ) => ({ ...ledger(windows), runtime: 'opencode' as const, accountId: 'default', ...extra });
    const who = { accountId: 'default', path: '', label: null, color: '#123456' };

    it('is limited when spend reaches its budget, and ok below it', () => {
      const reached = toAccountUsage(
        opencode({ spend: spend({ costUsd: 10, limitUsd: 10 }) }),
        who,
        NOW
      );
      expect(reached.state).toBe('limited');
      expect(reached.limit).toEqual({ window: SPEND_LIMIT_WINDOW, resetsAt: null });
      const below = toAccountUsage(
        opencode({ spend: spend({ costUsd: 9.99, limitUsd: 10 }) }),
        who,
        NOW
      );
      expect(below.state).toBe('ok');
      expect(below.limit).toBeNull();
      expect(below.spend).toMatchObject({ costUsd: 9.99, limitUsd: 10 });
    });

    it('reads spend from an earlier month as reset, so a reached budget no longer limits', () => {
      const lastMonth = spend({
        periodStart: '2026-08-01T00:00:00.000Z',
        costUsd: 12,
        limitUsd: 10,
        observedAt: '2026-08-31T23:00:00.000Z',
      });
      const out = toAccountUsage(opencode({ spend: lastMonth }), who, NOW);
      expect(out.state).toBe('ok');
      expect(out.limit).toBeNull();
      expect(out.spend).toMatchObject({
        periodStart: '2026-09-01T00:00:00.000Z',
        costUsd: 0,
        limitUsd: 10,
      });
      expect(readSpend(lastMonth, NOW).costUsd).toBe(0);
      const thisMonth = spend({ costUsd: 12, limitUsd: 10 });
      expect(readSpend(thisMonth, NOW)).toBe(thisMonth);
    });

    it('refuses a zero budget', () => {
      const stored = { ...ledger({}), runtime: 'opencode' as const };
      const out = mergeLedger(stored, [], NOW, CODEX, { spend: spend({ limitUsd: 0 }) });
      expect(out.dropped).toEqual([{ key: 'spend', reason: 'invalid spend' }]);
    });

    it('is ok for spend with no budget', () => {
      expect(toAccountUsage(opencode({ spend: spend() }), who, NOW).state).toBe('ok');
    });

    it('is ok with neither windows nor spend (a local model)', () => {
      const out = toAccountUsage(opencode({}), who, NOW);
      expect(out.state).toBe('ok');
      expect(out.runtime).toBe('opencode');
    });

    it('is unknown when every window is stale and there is no spend, ok with spend', () => {
      const stale = { five_hour: entry({ observedAt: at(-6 * HOUR) }) };
      expect(toAccountUsage(opencode({}, stale), who, NOW).state).toBe('unknown');
      expect(toAccountUsage(opencode({ spend: spend() }, stale), who, NOW).state).toBe('ok');
    });

    it("takes the runtime from the identity (the ledger's folder) over the ledger's own field", () => {
      const misfiled = { ...ledger({ five_hour: entry() }), runtime: 'codex' as const };
      expect(toAccountUsage(misfiled, { ...who, runtime: 'claude-code' }, NOW).runtime).toBe(
        'claude-code'
      );
    });

    it('carries plan and credits, and takes the runtime from the identity with no ledger', () => {
      const credits = { hasCredits: true, unlimited: true, balance: null };
      const out = toAccountUsage(opencode({ plan: 'pro', credits }), who, NOW);
      expect(out).toMatchObject({ plan: 'pro', credits });
      expect(toAccountUsage(null, { ...who, runtime: 'codex' }, NOW).runtime).toBe('codex');
    });
  });
});
