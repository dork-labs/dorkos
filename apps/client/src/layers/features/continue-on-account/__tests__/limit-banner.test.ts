/**
 * The banner's pure display rules (spec `claude-account-ui` §6.7): its tone
 * agrees with the sidebar row and the header badge, and its words.
 */
import { describe, it, expect } from 'vitest';
import { createMockSessionLimit } from '@dorkos/test-utils';
import { sessionLimitDisplay } from '@/layers/entities/session';
import type { LimitState } from '@/layers/shared/lib';
import {
  bannerActions,
  bannerVariantFor,
  outOfUsageSentence,
  secondsUntil,
  waitingSentence,
} from '../lib/limit-banner';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A Sunday noon in local time. */
const NOW = new Date(2026, 8, 27, 12, 0, 0);
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

const ALL: LimitState[] = [
  'limited',
  'handing-off',
  'wait-only',
  'all-accounts-out',
  'model-limited',
  'waiting-reset',
  'reset-ready',
  'moved',
];

describe('bannerVariantFor (Q13)', () => {
  it('is red only while an account is out and needs action', () => {
    expect(ALL.filter((state) => bannerVariantFor(state) === 'critical')).toEqual([
      'limited',
      'handing-off',
      'wait-only',
      'all-accounts-out',
      'model-limited',
    ]);
  });

  it.each(ALL)('agrees with the sidebar row and header badge in %s', (state) => {
    const display = sessionLimitDisplay(createMockSessionLimit('ask', { state }));
    // A row that shows the limit wears red exactly when the banner does.
    if (display) expect(display.needsAction).toBe(bannerVariantFor(state) === 'critical');
  });
});

describe('outOfUsageSentence', () => {
  it('says "back in" for the 5-hour window within a day', () => {
    expect(outOfUsageSentence('Acct 4', 'five_hour', at(47 * MINUTE), NOW)).toBe(
      'Acct 4 is out of usage · back in 47 min.'
    );
  });

  it('says "until" for the week, and for a 5-hour reset a day or more away', () => {
    const tue3pm = at(2 * DAY + 3 * HOUR);
    expect(outOfUsageSentence('Acct 4', 'seven_day', tue3pm, NOW)).toBe(
      'Acct 4 is out of usage until Tue 3pm.'
    );
    expect(outOfUsageSentence('Acct 4', 'five_hour', tue3pm, NOW)).toBe(
      'Acct 4 is out of usage until Tue 3pm.'
    );
  });

  it('says only that it is out with no known reset', () => {
    expect(outOfUsageSentence('Codex', 'five_hour', null, NOW)).toBe('Codex is out of usage.');
  });
});

describe('waitingSentence', () => {
  it('counts under a day and names the day beyond it', () => {
    expect(waitingSentence('Acct 4', at(HOUR + 12 * MINUTE), NOW)).toBe(
      'Waiting for Acct 4 · back in 1h 12m'
    );
    expect(waitingSentence('Acct 4', at(2 * DAY + 3 * HOUR), NOW)).toBe(
      'Waiting for Acct 4 · back Tue 3pm'
    );
    expect(waitingSentence('Acct 4', null, NOW)).toBe('Waiting for Acct 4');
  });
});

describe('secondsUntil', () => {
  it('rounds up and never goes below zero', () => {
    expect(secondsUntil(at(9_001), NOW)).toBe(10);
    expect(secondsUntil(at(-5_000), NOW)).toBe(0);
  });
});

describe('bannerActions', () => {
  const flags = { canPick: true, hasFallback: true, continuedHere: false };

  it('lays out each state in the spec order', () => {
    expect(bannerActions('limited', flags)).toEqual(['continue-on', 'wait']);
    expect(bannerActions('handing-off', flags)).toEqual(['move-now', 'choose', 'wait']);
    expect(bannerActions('model-limited', flags)).toEqual(['keep-going', 'continue-on', 'wait']);
    expect(bannerActions('wait-only', flags)).toEqual(['wait']);
    expect(bannerActions('all-accounts-out', flags)).toEqual(['wait']);
    expect(bannerActions('waiting-reset', flags)).toEqual([]);
    expect(bannerActions('reset-ready', flags)).toEqual(['resume']);
    expect(bannerActions('moved', flags)).toEqual(['open-moved', 'continue-here']);
  });

  it('drops the picker when it may not open, and "Continue here anyway" once chosen', () => {
    const closed = { canPick: false, hasFallback: false, continuedHere: true };
    expect(bannerActions('limited', closed)).toEqual(['wait']);
    expect(bannerActions('handing-off', closed)).toEqual(['move-now', 'wait']);
    expect(bannerActions('model-limited', closed)).toEqual(['wait']);
    expect(bannerActions('moved', closed)).toEqual(['open-moved']);
  });
});
