import { describe, it, expect } from 'vitest';
import {
  UsageLedgerSchema,
  ledgerSlug,
  mergeLedger,
  modelWindowKey,
  readWindow,
  toAccountUsage,
  type LedgerEntry,
  type LedgerObservation,
  type MergeLedgerResult,
  type UsageLedger,
} from '../../account-usage.js';
import {
  OPENCODE,
  NOW,
  at,
  MIN,
  HOUR,
  DAY,
  entry,
  ledger,
  OWNER,
  CODEX,
  obs,
  written,
  identity,
  spend,
} from './account-usage.fixtures.js';

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

  it('makes credits:* and rate_limit:* error signals stale after an hour', () => {
    const signal = (age: number) =>
      entry({ usedPct: null, status: 'rejected', source: 'error', observedAt: at(-age) });
    expect(readWindow(signal(HOUR), NOW, 'credits:openrouter')).not.toBeNull();
    expect(readWindow(signal(HOUR + 1), NOW, 'credits:openrouter')).toBeNull();
    expect(readWindow(signal(HOUR + 1), NOW, 'rate_limit:openrouter')).toBeNull();
  });
});

describe('mergeLedger', () => {
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

  describe('a tie on observedAt (contract 4.0.0)', () => {
    const T = at(-10 * MIN);
    /** Merge `b` onto a ledger holding `a`, and `a` onto one holding `b`: the same entry must win. */
    function winnerBothWays(a: Partial<LedgerEntry>, b: Partial<LedgerEntry>) {
      const one = mergeLedger(
        ledger({ five_hour: entry({ observedAt: T, ...a }) }),
        [obs('five_hour', { observedAt: T, ...b })],
        NOW,
        OWNER
      );
      const other = mergeLedger(
        ledger({ five_hour: entry({ observedAt: T, ...b }) }),
        [obs('five_hour', { observedAt: T, ...a })],
        NOW,
        OWNER
      );
      const pick = (out: MergeLedgerResult) => (out.ledger as UsageLedger).windows.five_hour;
      expect(pick(one)).toEqual(pick(other));
      return pick(one)!;
    }

    it('keeps a same-millisecond rejected reading, whichever arrives first', () => {
      expect(
        winnerBothWays({ status: 'rejected', usedPct: 10 }, { status: 'allowed', usedPct: 90 })
      ).toMatchObject({ status: 'rejected', usedPct: 10 });
    });

    it('ranks rejected over allowed_warning over allowed over no status', () => {
      expect(winnerBothWays({ status: 'allowed_warning' }, { status: 'rejected' }).status).toBe(
        'rejected'
      );
      expect(winnerBothWays({ status: 'allowed' }, { status: 'allowed_warning' }).status).toBe(
        'allowed_warning'
      );
      expect(winnerBothWays({ status: null }, { status: 'allowed' }).status).toBe('allowed');
    });

    it('keeps a fact on an equal observedAt: only windows break ties', () => {
      const stored = ledger({}, { plan: { name: 'pro', observedAt: T, source: 'rollout' } });
      const out = mergeLedger(
        stored,
        [{ kind: 'plan', name: 'plus', observedAt: T, source: 'statusline' }],
        NOW,
        OWNER
      );
      expect(out.changed).toBe(false);
    });
  });

  describe('a reading with no usedPct keeps the stored number (DOR-3589)', () => {
    const PROBE_AT = at(-30 * MIN);
    const EVENT_AT = at(-5 * MIN);
    const RESETS = at(3 * DAY);
    const probe = obs('seven_day', {
      usedPct: 10,
      resetsAt: RESETS,
      status: null,
      observedAt: PROBE_AT,
      source: 'sdk_usage',
    });
    const notice = (overrides: Partial<LedgerEntry> = {}) =>
      obs('seven_day', {
        usedPct: null,
        resetsAt: null,
        status: 'allowed_warning',
        observedAt: EVENT_AT,
        source: 'sdk_event',
        ...overrides,
      });

    it('a probe reads 10%, then a limit notice with no number: the 10% stays', () => {
      const afterProbe = written(mergeLedger(null, [probe], NOW, OWNER));
      const out = written(mergeLedger(afterProbe, [notice()], NOW, OWNER));
      expect(out.windows.seven_day).toEqual({
        usedPct: 10,
        resetsAt: RESETS,
        status: 'allowed_warning',
        observedAt: PROBE_AT,
        statusObservedAt: EVENT_AT,
        source: 'sdk_event',
      });
      expect(UsageLedgerSchema.safeParse(out).success).toBe(true);
      expect(toAccountUsage(out, identity, NOW).windows[0]).toMatchObject({
        key: 'seven_day',
        usedPct: 10,
        status: 'allowed_warning',
        observedAt: PROBE_AT,
      });
    });

    it('gives the same ledger in any order, one batch or one call each', () => {
      const between = obs('seven_day', {
        usedPct: 20,
        resetsAt: RESETS,
        observedAt: at(-20 * MIN),
        source: 'sdk_usage',
      });
      const rejected = notice({ status: 'rejected', observedAt: at(-2 * MIN) });
      const readings = [probe, notice(), between, rejected];
      const orders = [
        [0, 1, 2, 3],
        [3, 2, 1, 0],
        [1, 3, 0, 2],
        [2, 0, 3, 1],
      ];
      const results = orders.flatMap((order) => {
        const batch = written(
          mergeLedger(
            null,
            order.map((i) => readings[i]!),
            NOW,
            OWNER
          )
        );
        let oneByOne: unknown = null;
        for (const i of order) {
          const out = mergeLedger(oneByOne, [readings[i]!], NOW, OWNER);
          oneByOne = out.ledger;
        }
        return [batch.windows.seven_day, (oneByOne as UsageLedger).windows.seven_day];
      });
      for (const result of results) expect(result).toEqual(results[0]);
      expect(results[0]).toEqual({
        usedPct: 20,
        resetsAt: RESETS,
        status: 'rejected',
        observedAt: at(-20 * MIN),
        statusObservedAt: at(-2 * MIN),
        source: 'sdk_event',
      });
    });

    it('drops the number when the notice names a later reset: a new window', () => {
      const later = at(10 * DAY);
      const out = written(mergeLedger(null, [probe, notice({ resetsAt: later })], NOW, OWNER));
      expect(out.windows.seven_day).toEqual({
        usedPct: null,
        resetsAt: later,
        status: 'allowed_warning',
        observedAt: EVENT_AT,
        source: 'sdk_event',
      });
    });

    it('drops the number when its window had already reset when the notice came', () => {
      const expired = obs('five_hour', {
        usedPct: 80,
        resetsAt: at(-10 * MIN),
        observedAt: at(-2 * HOUR),
      });
      const after = obs('five_hour', { usedPct: null, status: 'allowed', observedAt: EVENT_AT });
      const out = written(mergeLedger(null, [expired, after], NOW, OWNER));
      expect(out.windows.five_hour).toMatchObject({ usedPct: null, status: 'allowed' });
      expect(out.windows.five_hour).not.toHaveProperty('statusObservedAt');
    });

    it('a kept entry fed back in as a reading keeps both times', () => {
      const kept = written(mergeLedger(null, [probe, notice()], NOW, OWNER)).windows.seven_day!;
      const again = written(mergeLedger(null, [{ key: 'seven_day', ...kept }], NOW, OWNER));
      expect(again.windows.seven_day).toEqual(kept);
      // An older status-only reading fed in after it still loses to the kept status.
      const older = notice({ status: 'rejected', observedAt: at(-10 * MIN) });
      expect(mergeLedger(again, [older], NOW, OWNER).changed).toBe(false);
    });
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

  it('keeps the stored entry when a reading replays it exactly', () => {
    const stored = ledger({ five_hour: entry({ usedPct: 40, observedAt: at(-10 * MIN) }) });
    const out = mergeLedger(
      stored,
      [obs('five_hour', { usedPct: 40, observedAt: at(-10 * MIN) })],
      NOW,
      OWNER
    );
    expect(out.changed).toBe(false);
    expect(out.ledger).toBe(stored);
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

  it('stores a spend with no cap as limitUsd null, and keeps a cap', () => {
    const first = written(mergeLedger(null, [spend()], NOW, OPENCODE));
    expect(first.spend).toMatchObject({ costUsd: 4.2, limitUsd: null });
    const capped = written(mergeLedger(null, [spend({ limitUsd: 25 })], NOW, OPENCODE));
    expect(capped.spend?.limitUsd).toBe(25);
    // The contract's schema allows a cap of 0 (minimum 0), so flow's files read.
    const zero = written(mergeLedger(null, [spend({ limitUsd: 0 })], NOW, OPENCODE));
    expect(zero.spend?.limitUsd).toBe(0);
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

  it('trims every trailing dash, and stays linear on a long run of them mid-name', () => {
    expect(ledgerSlug('model---')).toBe('model');
    expect(ledgerSlug('---')).toBeNull();
    // `/-+$/` backtracked quadratically here: a run of dashes that is not at
    // the end fails `$` once per starting position (CodeQL js/polynomial-redos).
    const name = `a${'-'.repeat(100_000)}b`;
    const started = performance.now();
    expect(ledgerSlug(name)).toBe(name);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
