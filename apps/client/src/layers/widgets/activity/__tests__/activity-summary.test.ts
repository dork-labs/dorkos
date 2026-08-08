import { describe, it, expect } from 'vitest';
import { sessionActivitySummary } from '../lib/activity-summary';

describe('sessionActivitySummary', () => {
  it('says nothing ran at zero', () => {
    expect(sessionActivitySummary([0, 0, 0, 0, 0, 0, 0])).toBe('No runs in this project this week');
  });

  it('is singular for one run', () => {
    expect(sessionActivitySummary([0, 0, 0, 0, 0, 0, 1])).toBe('1 run in this project this week');
  });

  it('totals every day in the window', () => {
    expect(sessionActivitySummary([1, 2, 3, 0, 0, 4, 2])).toBe('12 runs in this project this week');
  });

  it('names its scope in every branch — the feed below it is machine-wide', () => {
    const weeks = [
      [0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 1],
      [3, 0, 0, 0, 0, 0, 2],
    ];
    for (const counts of weeks) {
      expect(sessionActivitySummary(counts)).toContain('in this project');
    }
  });
});
