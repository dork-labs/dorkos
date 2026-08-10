import { describe, it, expect } from 'vitest';
import { sessionActivitySummary } from '../lib/activity-summary';

describe('sessionActivitySummary', () => {
  it('says nothing started at zero', () => {
    expect(sessionActivitySummary([0, 0, 0, 0, 0, 0, 0], false)).toBe(
      'Your agents started no sessions this week'
    );
  });

  it('is singular for one session', () => {
    expect(sessionActivitySummary([0, 0, 0, 0, 0, 0, 1], false)).toBe(
      'Your agents started 1 session this week'
    );
  });

  it('totals every day in the window', () => {
    expect(sessionActivitySummary([1, 2, 3, 0, 0, 4, 2], false)).toBe(
      'Your agents started 12 sessions this week'
    );
  });

  it('names what it counts — sessions started, not turns or sessions worked in', () => {
    // The number buckets each session by the day it was CREATED, so a session
    // opened last month and resumed today is not in it. The copy has to say
    // "started" or it describes a week nobody measured.
    const weeks = [
      [0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 1],
      [3, 0, 0, 0, 0, 0, 2],
    ];
    for (const counts of weeks) {
      expect(sessionActivitySummary(counts, false)).toContain('Your agents started');
    }
  });

  it('says "at least" when a runtime could not be read — the count is a floor', () => {
    expect(sessionActivitySummary([1, 2, 3, 0, 0, 4, 2], true)).toBe(
      'Your agents started at least 12 sessions this week'
    );
  });

  it('claims nothing at all when zero is the only thing an unread runtime left us', () => {
    // Zero + a degraded runtime could be a genuinely quiet week or a busy one
    // behind a dead backend. Saying either would be a guess, including the
    // sympathetic-sounding "some sessions couldn't be counted".
    expect(sessionActivitySummary([0, 0, 0, 0, 0, 0, 0], true)).toBe(
      "This week's count is incomplete"
    );
  });
});
