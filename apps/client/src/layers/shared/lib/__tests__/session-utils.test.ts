import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { groupSessionsByTime, formatRelativeTime } from '../session-utils';
import type { Session } from '@dorkos/shared/types';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: overrides.id ?? 'test-id',
    title: overrides.title ?? 'Test session',
    createdAt: overrides.createdAt ?? '2026-02-07T10:00:00Z',
    updatedAt: overrides.updatedAt ?? '2026-02-07T10:00:00Z',
    permissionMode: overrides.permissionMode ?? 'default',
    runtime: overrides.runtime ?? 'claude-code',
    ...overrides,
  };
}

// Pin "now" to 2026-02-07 15:00:00 UTC for deterministic tests
const NOW = new Date('2026-02-07T15:00:00Z');

describe('groupSessionsByTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('returns empty array for no sessions', () => {
    expect(groupSessionsByTime([])).toEqual([]);
  });

  it('groups a session updated today into "Today"', () => {
    const sessions = [makeSession({ updatedAt: '2026-02-07T12:00:00Z' })];
    const groups = groupSessionsByTime(sessions);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Today');
    expect(groups[0].sessions).toHaveLength(1);
  });

  it('groups a session updated yesterday into "Yesterday"', () => {
    const sessions = [makeSession({ updatedAt: '2026-02-06T18:00:00Z' })];
    const groups = groupSessionsByTime(sessions);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Yesterday');
  });

  it('groups sessions into "Previous 7 Days"', () => {
    const sessions = [makeSession({ updatedAt: '2026-02-03T10:00:00Z' })];
    const groups = groupSessionsByTime(sessions);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Previous 7 Days');
  });

  it('groups sessions into "Previous 30 Days"', () => {
    const sessions = [makeSession({ updatedAt: '2026-01-15T10:00:00Z' })];
    const groups = groupSessionsByTime(sessions);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Previous 30 Days');
  });

  it('groups old sessions into "Older"', () => {
    const sessions = [makeSession({ updatedAt: '2025-06-01T10:00:00Z' })];
    const groups = groupSessionsByTime(sessions);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Older');
  });

  it('distributes sessions across multiple groups in order', () => {
    const sessions = [
      makeSession({ id: 'today', updatedAt: '2026-02-07T14:00:00Z' }),
      makeSession({ id: 'yesterday', updatedAt: '2026-02-06T10:00:00Z' }),
      makeSession({ id: 'old', updatedAt: '2025-01-01T10:00:00Z' }),
    ];
    const groups = groupSessionsByTime(sessions);
    const labels = groups.map((g) => g.label);
    expect(labels).toEqual(['Today', 'Yesterday', 'Older']);
  });

  it('omits empty groups', () => {
    const sessions = [
      makeSession({ id: 'today', updatedAt: '2026-02-07T14:00:00Z' }),
      makeSession({ id: 'old', updatedAt: '2025-01-01T10:00:00Z' }),
    ];
    const groups = groupSessionsByTime(sessions);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Older']);
  });

  it('preserves input order within each group', () => {
    const sessions = [
      makeSession({ id: 'first', updatedAt: '2026-02-07T14:00:00Z' }),
      makeSession({ id: 'second', updatedAt: '2026-02-07T12:00:00Z' }),
      makeSession({ id: 'third', updatedAt: '2026-02-07T10:00:00Z' }),
    ];
    const groups = groupSessionsByTime(sessions);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['first', 'second', 'third']);
  });
});

describe('formatRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('returns "Just now" for less than a minute ago', () => {
    expect(formatRelativeTime('2026-02-07T14:59:30Z')).toBe('Just now');
  });

  it('returns minutes for recent times', () => {
    expect(formatRelativeTime('2026-02-07T14:15:00Z')).toBe('45m ago');
  });

  it('returns hours for today', () => {
    expect(formatRelativeTime('2026-02-07T12:00:00Z')).toBe('3h ago');
  });

  it('returns "Yesterday" with time for yesterday', () => {
    const result = formatRelativeTime('2026-02-06T20:00:00Z');
    expect(result).toMatch(/^Yesterday, \d{1,2}\s?(am|pm)$/i);
  });

  it('returns day name with time for this week', () => {
    const result = formatRelativeTime('2026-02-03T10:00:00Z');
    expect(result).toMatch(/^Tue, \d{1,2}\s?(am|pm)$/i);
  });

  it('returns month + day with time for older dates', () => {
    const result = formatRelativeTime('2026-01-15T10:00:00Z');
    expect(result).toMatch(/^Jan 15, \d{1,2}\s?(am|pm)$/i);
  });

  it('returns month + day with time for previous year', () => {
    const result = formatRelativeTime('2025-12-25T10:00:00Z');
    expect(result).toMatch(/^Dec 25, \d{1,2}\s?(am|pm)$/i);
  });

  it('reads a future timestamp as "Just now" rather than a negative age', () => {
    expect(formatRelativeTime('2026-02-07T18:00:00Z')).toBe('Just now');
    expect(formatRelativeTime('2026-02-09T18:00:00Z')).toBe('Just now');
  });
});

/*
 * Every clock below is built from LOCAL date parts, so "just after midnight"
 * is just after midnight in whatever time zone the suite runs in. Pinning ISO
 * `Z` strings instead would put midnight somewhere else on every machine that
 * is not on UTC, and the case this guards would silently stop being tested.
 * February 8 is weeks from any daylight-saving switch in either hemisphere's
 * common zones, so every day here is 24 hours long.
 */
describe('formatRelativeTime across midnight', () => {
  const localTime = (day: number, hour: number, minute = 0) =>
    new Date(2026, 1, day, hour, minute).toISOString();

  beforeEach(() => {
    vi.useFakeTimers();
    // 00:03 local on Sunday, February 8.
    vi.setSystemTime(new Date(2026, 1, 8, 0, 3));
  });
  afterEach(() => vi.useRealTimers());

  it('reads five minutes ago as "5m ago", not "Yesterday", just after midnight', () => {
    expect(formatRelativeTime(localTime(7, 23, 58))).toBe('5m ago');
  });

  it('reads under a minute ago as "Just now" across midnight', () => {
    vi.setSystemTime(new Date(2026, 1, 8, 0, 0, 10));
    expect(formatRelativeTime(new Date(2026, 1, 7, 23, 59, 50).toISOString())).toBe('Just now');
  });

  it('keeps counting hours for the first few hours before midnight', () => {
    expect(formatRelativeTime(localTime(7, 21, 3))).toBe('3h ago');
    expect(formatRelativeTime(localTime(7, 18, 4))).toBe('5h ago');
  });

  it('names the time once yesterday is more than six hours back', () => {
    expect(formatRelativeTime(localTime(7, 18, 3))).toMatch(/^Yesterday, 6\s?pm$/i);
    expect(formatRelativeTime(localTime(7, 9))).toMatch(/^Yesterday, 9\s?am$/i);
  });

  it('still counts hours for anything earlier today, late in the day', () => {
    vi.setSystemTime(new Date(2026, 1, 8, 23, 30));
    expect(formatRelativeTime(localTime(8, 0, 10))).toBe('23h ago');
  });
});
