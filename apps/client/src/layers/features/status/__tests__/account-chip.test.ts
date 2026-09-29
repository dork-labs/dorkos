/**
 * The account chip's display rules (spec `claude-account-ui` §6.1): its tone,
 * its words, and when the popover may offer to continue on another account.
 */
import { describe, it, expect } from 'vitest';
import { createMockAccountUsage, createMockSessionLimit } from '@dorkos/test-utils';
import type { LimitState, SessionLimitView } from '@/layers/shared/lib';
import {
  accountChipText,
  canOfferContinue,
  chipToneFor,
  popoverWindowLabel,
} from '../lib/account-chip';

/** A limit whose server sends `state` and `scope` (S4 5.1). */
function limitIn(state: LimitState, overrides: Partial<SessionLimitView> = {}): SessionLimitView {
  return { ...createMockSessionLimit('ask'), state, scope: 'account', ...overrides };
}

/** Sunday 27 Sep 2026, 12:13 local time. */
const NOW = new Date('2026-09-27T12:13:00');

describe('chipToneFor', () => {
  it.each([
    ['ok', null],
    ['unknown', null],
    ['near', 'warning'],
    ['model-out', 'warning'],
    ['out', 'error'],
  ] as const)('%s wears %s', (state, tone) => {
    expect(chipToneFor(state)).toBe(tone);
  });
});

describe('canOfferContinue', () => {
  it.each(['limited', 'handing-off', 'model-limited'] as const)(
    'offers the move while the limit is %s',
    (state) => {
      expect(canOfferContinue(limitIn(state), 'idle', false)).toBe(true);
    }
  );

  it.each(['wait-only', 'all-accounts-out', 'moved', 'waiting-reset', 'reset-ready'] as const)(
    'never offers it while the limit is %s',
    (state) => {
      expect(canOfferContinue(limitIn(state), 'idle', false)).toBe(false);
    }
  );

  it('never offers it on a healthy session', () => {
    expect(canOfferContinue(null, 'idle', false)).toBe(false);
  });

  it('never offers it when the plan says the work cannot carry over', () => {
    const limit = limitIn('limited', {
      plan: { mode: 'ask', carryOver: false } as SessionLimitView['plan'],
    });
    expect(canOfferContinue(limit, 'idle', false)).toBe(false);
  });

  it.each(['streaming', 'blocked'] as const)('never offers it during a live turn (%s)', (lc) => {
    expect(canOfferContinue(limitIn('limited'), lc, false)).toBe(false);
  });

  it('never offers it before launch', () => {
    expect(canOfferContinue(limitIn('limited'), null, true)).toBe(false);
  });

  it('reads an older server’s ask plan as limited', () => {
    expect(canOfferContinue(createMockSessionLimit('ask'), 'idle', false)).toBe(true);
    expect(canOfferContinue(createMockSessionLimit('waiting'), 'idle', false)).toBe(false);
  });
});

describe('accountChipText', () => {
  it('draws bars, not words, for ok and unknown', () => {
    const usage = createMockAccountUsage();
    expect(accountChipText({ chipState: 'ok', usage, limit: null, now: NOW })).toBeNull();
    expect(
      accountChipText({ chipState: 'unknown', usage: null, limit: null, now: NOW })
    ).toBeNull();
  });

  it('says the account is out with no reset when nothing names one', () => {
    expect(accountChipText({ chipState: 'out', usage: null, limit: null, now: NOW })).toBe('out');
  });

  it('reads the account’s rejected window when the session has no limit', () => {
    const usage = createMockAccountUsage({
      state: 'limited',
      limit: { window: 'five_hour', resetsAt: '2026-09-27T13:00:00' },
    });
    expect(accountChipText({ chipState: 'out', usage, limit: null, now: NOW })).toBe(
      'back in 47 min'
    );
  });
});

describe('popoverWindowLabel', () => {
  it('names the two main windows and keeps the server label for the rest', () => {
    expect(popoverWindowLabel('five_hour', '5-hour window')).toBe('5-hour');
    expect(popoverWindowLabel('seven_day', 'Weekly')).toBe('This week');
    expect(popoverWindowLabel('seven_day_opus', 'Weekly Opus')).toBe('Weekly Opus');
  });
});
