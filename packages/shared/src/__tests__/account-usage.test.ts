import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_ID_PATTERN,
  DEFAULT_ACCOUNT_COLORS,
  FLOW_FLEET_SETTINGS_TAB_ID,
  UsageLedgerSchema,
  mergeLedger,
  modelWindowKey,
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
    accountId: 'claude3',
    updatedAt: at(-HOUR),
    windows,
    ...extra,
  } satisfies UsageLedger;
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
    const { ledger: out, changed, dropped } = mergeLedger(null, [obs('five_hour')], NOW, 'claude3');
    expect(changed).toBe(true);
    expect(dropped).toEqual([]);
    expect(out).toEqual({
      v: 1,
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
      'claude3'
    );
    expect(newer.changed).toBe(true);
    expect(newer.ledger.windows.five_hour!.usedPct).toBe(50);
    expect(newer.ledger.updatedAt).toBe(NOW.toISOString());

    const older = mergeLedger(
      stored,
      [obs('five_hour', { usedPct: 60, observedAt: at(-20 * MIN) })],
      NOW,
      'claude3'
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
      'claude3'
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
      'claude3'
    );
    expect(out.ledger.windows.seven_day!.usedPct).toBe(3);
  });

  it('drops an observation more than 5 minutes in the future and keeps one just inside', () => {
    const out = mergeLedger(
      null,
      [
        obs('five_hour', { observedAt: at(5 * MIN + 1000) }),
        obs('seven_day', { observedAt: at(5 * MIN - 1000) }),
      ],
      NOW,
      'claude3'
    );
    expect(out.dropped).toEqual([{ key: 'five_hour', reason: expect.any(String) }]);
    expect(Object.keys(out.ledger.windows)).toEqual(['seven_day']);
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
      'claude3'
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
      'claude3'
    );
    expect(out.dropped).toEqual([]);
    expect(out.ledger.windows.five_hour!.usedPct).toBe(100);
    expect(out.ledger.windows.seven_day!.usedPct).toBe(0);
  });

  it('leaves updatedAt and the ledger untouched when nothing changed', () => {
    const stored = ledger({ five_hour: entry() });
    const out = mergeLedger(stored, [], NOW, 'claude3');
    expect(out.changed).toBe(false);
    expect(out.ledger).toBe(stored);
  });

  it('keeps unknown window keys and unknown top-level fields', () => {
    const stored = ledger(
      { future_window: entry({ usedPct: 7 }), 'model:opus': entry({ usedPct: 8 }) },
      { writer: 'flow 1.2' }
    );
    const out = mergeLedger(stored, [obs('five_hour', { observedAt: at(0) })], NOW, 'claude3');
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
      subscriptionType: null,
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
