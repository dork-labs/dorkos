import { describe, it, expect } from 'vitest';
import { triageSummary, type TriageCounts } from '../lib/triage-summary';
import { triageSwapDuration } from '../ui/PinnedTriageHeaderView';

/** Nothing waiting and nothing wrong, so a case only states what it is about. */
function counts(overrides: Partial<TriageCounts> = {}): TriageCounts {
  return {
    questions: 0,
    requests: 0,
    schedules: 0,
    approvalsUnavailable: false,
    attention: 0,
    ...overrides,
  };
}

describe('triageSummary', () => {
  it('says nothing at all when the header is holding nothing', () => {
    expect(triageSummary(counts())).toEqual({ spoken: '', compact: '' });
  });

  it('counts both groups, in both registers', () => {
    expect(triageSummary(counts({ requests: 2, attention: 1 }))).toEqual({
      spoken: '2 requests are waiting on you. 1 thing needs attention.',
      compact: '2 waiting · 1 needs attention',
    });
  });

  it('reads one of each as one, not as "1 requests"', () => {
    expect(triageSummary(counts({ requests: 1, attention: 3 }))).toEqual({
      spoken: '1 request is waiting on you. 3 things need attention.',
      compact: '1 waiting · 3 need attention',
    });
  });

  it('names a question as a question, never as an approval', () => {
    // The mislabel this pins: the header used to fold prompts into "approvals",
    // so an agent parked on a yes/no question was announced to a screen reader
    // as an approval request. Seeded defect: sum the three kinds back into one
    // `approvals` count and this reads "1 approval is waiting on you."
    expect(triageSummary(counts({ questions: 1 })).spoken).toBe('1 question is waiting on you.');
  });

  it('names a proposed schedule as a schedule', () => {
    expect(triageSummary(counts({ schedules: 2 })).spoken).toBe('2 schedules are waiting on you.');
  });

  it('names every kind that is present, in the panel’s listing order', () => {
    // Two things a two-kind case cannot prove: the three-part Oxford join
    // (indistinguishable from a two-part `a and b` until a third part exists),
    // and that the order is questions → requests → schedules, matching what the
    // Inbox panel lists. The compact bar stays one number, because a phone line
    // has one screen-width to spend.
    expect(triageSummary(counts({ questions: 2, requests: 1, schedules: 3 }))).toEqual({
      spoken: '2 questions, 1 request, and 3 schedules are waiting on you.',
      compact: '6 waiting',
    });
  });

  it('joins exactly two kinds with "and", not with a comma', () => {
    expect(triageSummary(counts({ questions: 1, schedules: 2 })).spoken).toBe(
      '1 question and 2 schedules are waiting on you.'
    );
  });

  it('says a list it could not read, rather than counting it as nothing', () => {
    // The failure that must never look like silence, in the register a
    // condensed bar can carry.
    expect(triageSummary(counts({ approvalsUnavailable: true }))).toEqual({
      spoken: 'Approvals could not be read.',
      compact: 'Approvals unreadable',
    });
  });

  it('lets real cards speak over a stale read failure', () => {
    expect(triageSummary(counts({ requests: 2, approvalsUnavailable: true })).compact).toBe(
      '2 waiting'
    );
  });
});

describe('triageSwapDuration', () => {
  it('animates the shape change by default', () => {
    expect(triageSwapDuration(false)).toBeGreaterThan(0);
  });

  it('swaps instantly for a reader who asked for less motion', () => {
    expect(triageSwapDuration(true)).toBe(0);
  });
});
