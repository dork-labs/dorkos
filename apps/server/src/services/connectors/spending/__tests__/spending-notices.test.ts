/**
 * The 80% and limit notices (DOR-4204 PR 2, spec 1.0 §5 and §13 #9): each is
 * told once a month per limit, the limit one reaches the person's chat app,
 * and raising the limit arms both again.
 */
import { describe, expect, it } from 'vitest';
import { spendingNoticesAfter } from '../spending-notices.js';
import { SPENDING_ENTRIES } from '../spending-notifications.js';

const DOLLAR = 1_000_000;
const RESETS = new Date('2026-12-01T00:00:00.000Z');
const at = (beforeMicro: number, afterMicro: number, limitMicro: number | null = 40 * DOLLAR) =>
  spendingNoticesAfter({ beforeMicro, afterMicro, limitMicro, month: '2026-11', resetsAt: RESETS });

describe('the spending notices', () => {
  it('tells the person once when a run crosses 80% of the limit', () => {
    expect(at(31 * DOLLAR, 32.1 * DOLLAR).map((n) => n.kind)).toEqual(['spending.near-limit']);
    expect(at(32.1 * DOLLAR, 33 * DOLLAR)).toEqual([]);
  });

  it('tells the person once when a run reaches the limit', () => {
    expect(at(39.8 * DOLLAR, 40 * DOLLAR).map((n) => n.kind)).toEqual(['spending.limit-reached']);
    expect(at(40 * DOLLAR, 41 * DOLLAR)).toEqual([]);
  });

  it('says both when one run jumps past 80% and the limit together', () => {
    expect(at(30 * DOLLAR, 40 * DOLLAR).map((n) => n.kind)).toEqual([
      'spending.near-limit',
      'spending.limit-reached',
    ]);
  });

  it('says nothing with no limit set', () => {
    expect(at(0, 99 * DOLLAR, null)).toEqual([]);
  });

  it('dedupes per month and limit, so a raise arms both again (spec §5)', () => {
    const near = SPENDING_ENTRIES['spending.near-limit'];
    const payload = {
      month: '2026-11',
      limitMicro: '40000000',
      leftMicro: '7900000',
      resetsAt: RESETS.toISOString(),
    };
    expect(near.dedupeKey(payload)).not.toEqual(
      near.dedupeKey({ ...payload, limitMicro: '60000000' })
    );
    expect(near.dedupeKey(payload)).not.toEqual(near.dedupeKey({ ...payload, month: '2026-12' }));
  });

  it('says it in the spec’s words, and the limit notice reaches the chat app (Q3)', () => {
    const payload = {
      month: '2026-11',
      limitMicro: '40000000',
      leftMicro: '7900000',
      resetsAt: RESETS.toISOString(),
    };
    const near = SPENDING_ENTRIES['spending.near-limit'];
    const reached = SPENDING_ENTRIES['spending.limit-reached'];
    expect(near.title(payload)).toBe("Agents have used 80% of this month's spending");
    expect(near.body?.(payload)).toBe('$7.90 left until Dec 1.');
    expect(reached.title(payload)).toBe('Agents reached your $40.00 monthly limit');
    expect(reached.body?.(payload)).toBe('Paid actions stop until Dec 1, or a higher limit.');
    expect(reached.relay).toBe('always');
    expect(near.relay).toBe('never');
    expect(reached.actions?.(payload).map((a) => a.label)).toEqual(['Raise limit', 'Open']);
  });
});
