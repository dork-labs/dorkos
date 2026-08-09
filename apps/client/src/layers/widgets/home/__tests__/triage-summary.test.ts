import { describe, it, expect } from 'vitest';
import { triageSummary } from '../lib/triage-summary';
import { triageSwapDuration } from '../ui/PinnedTriageHeaderView';

describe('triageSummary', () => {
  it('says nothing at all when the header is holding nothing', () => {
    expect(triageSummary({ approvals: 0, approvalsUnavailable: false, attention: 0 })).toEqual({
      spoken: '',
      compact: '',
    });
  });

  it('counts both groups, in both registers', () => {
    expect(triageSummary({ approvals: 2, approvalsUnavailable: false, attention: 1 })).toEqual({
      spoken: '2 approvals are waiting on you. 1 thing needs attention.',
      compact: '2 waiting · 1 needs attention',
    });
  });

  it('reads one of each as one, not as "1 approvals"', () => {
    expect(triageSummary({ approvals: 1, approvalsUnavailable: false, attention: 3 })).toEqual({
      spoken: '1 approval is waiting on you. 3 things need attention.',
      compact: '1 waiting · 3 need attention',
    });
  });

  it('says a list it could not read, rather than counting it as nothing', () => {
    // The failure that must never look like silence, in the register a
    // condensed bar can carry.
    expect(triageSummary({ approvals: 0, approvalsUnavailable: true, attention: 0 })).toEqual({
      spoken: 'Approvals could not be read.',
      compact: 'Approvals unreadable',
    });
  });

  it('lets real cards speak over a stale read failure', () => {
    expect(triageSummary({ approvals: 2, approvalsUnavailable: true, attention: 0 }).compact).toBe(
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
