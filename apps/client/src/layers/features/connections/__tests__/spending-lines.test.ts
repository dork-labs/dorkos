/**
 * What the Spending block says (DOR-4204 spec 1.0 §2.3, §5, §7, §8), and the
 * fail-first case #12: `0` and `0.001` never save.
 */
import { describe, expect, it } from 'vitest';
import { emptySpendingSummary } from '@dorkos/test-utils';
import {
  barPercent,
  barValueText,
  parseSpendAmount,
  priceHelpLine,
  spendingStatus,
  whereItWent,
} from '../lib/spending-lines';

const MAX = '10000000000';
const DOLLAR = 1_000_000;
const micro = (dollars: number) => String(Math.round(dollars * DOLLAR));

describe('reading a typed amount (spec §2.3)', () => {
  it('rounds to the cent and saves micro-units', () => {
    expect(parseSpendAmount('40', MAX)).toEqual({ ok: true, micro: '40000000' });
    expect(parseSpendAmount('$0.305', MAX)).toEqual({ ok: true, micro: '310000' });
    expect(parseSpendAmount(' 1,250.5 ', MAX)).toEqual({ ok: true, micro: '1250500000' });
  });

  it('reads an empty field as no limit', () => {
    expect(parseSpendAmount('  ', MAX)).toEqual({ ok: true, micro: null });
  });

  it('never saves 0 or 0.001 (fail-first #12)', () => {
    for (const typed of ['0', '0.001', '0.00']) {
      expect(parseSpendAmount(typed, MAX)).toEqual({
        ok: false,
        error: 'Enter at least $0.01, or leave it empty.',
      });
    }
  });

  it('refuses anything that is not a number, and anything past the maximum', () => {
    expect(parseSpendAmount('forty', MAX)).toEqual({
      ok: false,
      error: 'Enter an amount, like 40.',
    });
    expect(parseSpendAmount('10000.01', MAX)).toEqual({
      ok: false,
      error: 'Enter $10,000.00 or less.',
    });
  });
});

describe('the status line (spec §5, §7)', () => {
  const resets = `resets ${new Date('2026-12-01T00:00:00.000Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

  it('says nothing was spent with no limit', () => {
    expect(spendingStatus(emptySpendingSummary())).toEqual({
      first: 'Nothing spent this month.',
      second: null,
    });
  });

  it('says what was spent with no limit', () => {
    expect(spendingStatus(emptySpendingSummary({ usedMicro: micro(4.2) }))).toEqual({
      first: '$4.20 spent this month',
      second: resets,
    });
  });

  it('says how much of the limit is used, and marks an estimate', () => {
    const summary = emptySpendingSummary({
      limitMicro: micro(40),
      usedMicro: micro(12.4),
      leftMicro: micro(27.6),
      overMicro: '0',
      approximate: true,
    });
    expect(spendingStatus(summary)).toEqual({
      first: '$12.40 of $40.00 used',
      second: `${resets}, approximate`,
    });
  });

  it('says what is left from 80%', () => {
    const summary = emptySpendingSummary({
      limitMicro: micro(40),
      usedMicro: micro(32.1),
      leftMicro: micro(7.9),
      overMicro: '0',
    });
    expect(spendingStatus(summary)).toEqual({
      first: '$32.10 of $40.00 used',
      second: '$7.90 left',
    });
  });

  it('says the limit is reached, and by how much it went over', () => {
    const at = emptySpendingSummary({
      limitMicro: micro(40),
      usedMicro: micro(40),
      leftMicro: '0',
      overMicro: '0',
    });
    expect(spendingStatus(at)).toEqual({ first: 'Limit reached', second: resets });
    const over = emptySpendingSummary({
      limitMicro: micro(40),
      usedMicro: micro(41.2),
      leftMicro: '0',
      overMicro: micro(1.2),
    });
    expect(spendingStatus(over)).toEqual({
      first: '$41.20 of $40.00 used',
      second: 'over by $1.20',
    });
  });

  it('fails closed when the meter can’t be read (spec §7.9)', () => {
    const unreadable = { ...emptySpendingSummary(), meterReadable: false };
    expect(spendingStatus(unreadable)).toEqual({
      first: 'Couldn’t read this month’s spending.',
      second: 'Paid actions ask every time.',
    });
  });
});

describe('the bar (spec §2.1, §11)', () => {
  it('draws only with a limit, and speaks amounts rather than a percent', () => {
    expect(barPercent(emptySpendingSummary())).toBeNull();
    const summary = emptySpendingSummary({ limitMicro: micro(40), usedMicro: micro(12.4) });
    expect(barPercent(summary)).toBe(31);
    expect(barValueText(summary)).toBe('$12.40 of $40.00 used');
    expect(barPercent(emptySpendingSummary({ limitMicro: micro(40), usedMicro: micro(50) }))).toBe(
      100
    );
  });
});

describe('where it went (spec §2.1, §7.8)', () => {
  const nameOf = (toolkit: string) =>
    ({ tavily: 'Acme Search', exa: 'Northwind Data' })[toolkit] ?? toolkit;

  it('lists apps largest first, marks estimates, and says when a price is unknown', () => {
    const { rows, more } = whereItWent(
      [
        { toolkit: 'exa', runs: 3, amountMicro: '0', estimated: false, unknownRuns: 3 },
        { toolkit: 'tavily', runs: 31, amountMicro: micro(9.3), estimated: true, unknownRuns: 0 },
      ],
      nameOf
    );
    expect(rows).toEqual([
      { toolkit: 'tavily', label: 'Acme Search · 31 runs', amount: 'about $9.30' },
      { toolkit: 'exa', label: 'Northwind Data · 3 runs · price unknown', amount: '—' },
    ]);
    expect(more).toBe(0);
  });

  it('caps the list at five, then counts the rest', () => {
    const lines = Array.from({ length: 7 }, (_, index) => ({
      toolkit: `app${index}`,
      runs: 1,
      amountMicro: micro(index + 1),
      estimated: false,
      unknownRuns: 0,
    }));
    const { rows, more } = whereItWent(lines, nameOf);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({ toolkit: 'app6', label: 'app6 · 1 run', amount: '$7.00' });
    expect(more).toBe(2);
  });
});

describe('the price-per-run help line (spec §3)', () => {
  it('says a run without a price asks, once a limit is on', () => {
    expect(
      priceHelpLine('Acme Search', emptySpendingSummary({ limitMicro: micro(40) }), 'tavily')
    ).toBe('Without a price, Acme Search runs ask you every time.');
    expect(priceHelpLine('Acme Search', emptySpendingSummary(), 'tavily')).toBe(
      'DorkOS can’t see what Acme Search charges. Set your best guess.'
    );
  });
});
