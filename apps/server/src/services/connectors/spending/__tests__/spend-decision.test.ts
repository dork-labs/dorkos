/**
 * What one paid run does before it runs (DOR-4204 PR 2, spec §4.1 and 1.1):
 * run quietly, ask a person, or refuse with no card.
 */
import { describe, expect, it } from 'vitest';
import { decideSpend } from '../spend-decision.js';

const DOLLAR = 1_000_000;
const base = {
  paid: true,
  outsider: false,
  limitMicro: 40 * DOLLAR,
  priceMicro: 300_000,
  usedMicro: 12 * DOLLAR,
} as const;

describe('a paid run before it runs', () => {
  it('runs quietly when a known price fits under the limit', () => {
    expect(decideSpend(base)).toMatchObject({ kind: 'run', priceMicro: 300_000 });
  });

  it('is not a spend at all when the action costs nothing', () => {
    expect(decideSpend({ ...base, paid: false })).toEqual({ kind: 'free' });
  });

  it('asks every time when no limit is set (the default)', () => {
    expect(decideSpend({ ...base, limitMicro: null })).toMatchObject({
      kind: 'ask',
      reason: 'no-limit',
    });
  });

  it('asks when the price is unknown, even with plenty left', () => {
    expect(decideSpend({ ...base, priceMicro: null })).toMatchObject({
      kind: 'ask',
      reason: 'unknown-price',
    });
  });

  it('refuses with no card when this run would pass the limit', () => {
    expect(decideSpend({ ...base, usedMicro: 39_800_000 })).toMatchObject({
      kind: 'refuse',
      code: 'SPEND_LIMIT',
      reason: 'would-pass',
    });
  });

  it('refuses with no card once the limit is reached', () => {
    expect(decideSpend({ ...base, usedMicro: 40 * DOLLAR, priceMicro: null })).toMatchObject({
      kind: 'refuse',
      code: 'SPEND_LIMIT',
      reason: 'reached',
    });
  });

  it('never spends on an outsider-marked turn, even under the limit (Security Must 1)', () => {
    for (const limitMicro of [40 * DOLLAR, null]) {
      expect(decideSpend({ ...base, limitMicro, outsider: true })).toMatchObject({
        kind: 'refuse',
        code: 'SPEND_OUTSIDER',
      });
    }
  });

  it('fails closed into a card when the meter cannot be read (Security Q8)', () => {
    expect(decideSpend({ ...base, usedMicro: 'unreadable' })).toMatchObject({
      kind: 'ask',
      reason: 'meter-unreadable',
    });
  });
});
