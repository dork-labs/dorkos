/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Session } from '@dorkos/shared/types';
import type { PulseRun } from '@dorkos/shared/types';

// ---------------------------------------------------------------------------
// Mocks — must be before imports
// ---------------------------------------------------------------------------

const mockSessions = vi.fn<() => { sessions: Session[] | undefined }>(() => ({
  sessions: undefined,
}));
vi.mock('@/layers/entities/session', () => ({
  useSessions: () => mockSessions(),
}));

const mockUseRuns = vi.fn<() => { data: PulseRun[] | undefined }>(() => ({ data: undefined }));
vi.mock('@/layers/entities/pulse', () => ({
  useRuns: () => mockUseRuns(),
}));

import { useActivityFeed, formatDuration } from '../model/use-activity-feed';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    title: 'Test Session',
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago (today)
    updatedAt: new Date().toISOString(),
    permissionMode: 'default',
    cwd: '/projects/test',
    ...overrides,
  };
}

function makeRun(overrides: Partial<PulseRun> = {}): PulseRun {
  return {
    id: 'run-1',
    scheduleId: 'sched-abc123def',
    status: 'completed',
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    outputSummary: null,
    error: null,
    sessionId: null,
    trigger: 'scheduled',
    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), // 3h ago (today)
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useActivityFeed', () => {
  beforeEach(() => {
    // Pin time to noon to avoid midnight boundary issues with "Today" grouping
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-27T12:00:00'));
    vi.clearAllMocks();
    mockSessions.mockReturnValue({ sessions: undefined });
    mockUseRuns.mockReturnValue({ data: undefined });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns empty groups when no data exists', () => {
    const { result } = renderHook(() => useActivityFeed());
    expect(result.current.groups).toHaveLength(0);
    expect(result.current.totalCount).toBe(0);
  });

  it('includes session events from last 7 days', () => {
    const session = makeSession({
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    mockSessions.mockReturnValue({ sessions: [session] });

    const { result } = renderHook(() => useActivityFeed());

    expect(result.current.totalCount).toBe(1);
    const allEvents = result.current.groups.flatMap((g) => g.events);
    expect(allEvents[0].type).toBe('session');
    expect(allEvents[0].id).toBe('session-sess-1');
  });

  it('excludes session events older than 7 days', () => {
    const oldSession = makeSession({
      createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), // 8 days ago
    });
    mockSessions.mockReturnValue({ sessions: [oldSession] });

    const { result } = renderHook(() => useActivityFeed());

    expect(result.current.totalCount).toBe(0);
  });

  it('includes Pulse run events from last 7 days', () => {
    const run = makeRun({ status: 'completed' });
    mockUseRuns.mockReturnValue({ data: [run] });

    const { result } = renderHook(() => useActivityFeed());

    expect(result.current.totalCount).toBe(1);
    const allEvents = result.current.groups.flatMap((g) => g.events);
    expect(allEvents[0].type).toBe('pulse');
    expect(allEvents[0].title).toContain('ran successfully');
  });

  it('marks failed Pulse runs with "failed" in title', () => {
    const run = makeRun({ status: 'failed' });
    mockUseRuns.mockReturnValue({ data: [run] });

    const { result } = renderHook(() => useActivityFeed());

    const allEvents = result.current.groups.flatMap((g) => g.events);
    expect(allEvents[0].title).toContain('failed');
  });

  it('sorts events reverse-chronologically within groups', () => {
    const newerSession = makeSession({
      id: 'newer',
      createdAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(), // 1h ago
    });
    const olderSession = makeSession({
      id: 'older',
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), // 3h ago
    });
    mockSessions.mockReturnValue({ sessions: [olderSession, newerSession] });

    const { result } = renderHook(() => useActivityFeed());

    const allEvents = result.current.groups.flatMap((g) => g.events);
    expect(allEvents[0].id).toBe('session-newer');
    expect(allEvents[1].id).toBe('session-older');
  });

  it('caps at 20 total events', () => {
    const sessions = Array.from({ length: 15 }, (_, i) =>
      makeSession({
        id: `sess-${i}`,
        createdAt: new Date(Date.now() - (i + 1) * 60 * 60 * 1000).toISOString(),
      })
    );
    const runs = Array.from({ length: 10 }, (_, i) =>
      makeRun({
        id: `run-${i}`,
        createdAt: new Date(Date.now() - (i + 16) * 60 * 60 * 1000).toISOString(),
      })
    );
    mockSessions.mockReturnValue({ sessions });
    mockUseRuns.mockReturnValue({ data: runs });

    const { result } = renderHook(() => useActivityFeed());

    const allEvents = result.current.groups.flatMap((g) => g.events);
    expect(allEvents.length).toBeLessThanOrEqual(20);
    expect(result.current.totalCount).toBe(25); // totalCount reflects all before cap
  });

  it('groups events into Today / Yesterday / Last 7 days', () => {
    const todaySession = makeSession({
      id: 'today',
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    const yesterdaySession = makeSession({
      id: 'yesterday',
      createdAt: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
    });
    const oldSession = makeSession({
      id: 'old',
      createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    });
    mockSessions.mockReturnValue({ sessions: [todaySession, yesterdaySession, oldSession] });

    const { result } = renderHook(() => useActivityFeed());

    const labels = result.current.groups.map((g) => g.label);
    expect(labels).toContain('Today');
    expect(labels).toContain('Yesterday');
    expect(labels).toContain('Last 7 days');
  });
});

describe('formatDuration', () => {
  it('formats minutes', () => {
    expect(formatDuration(5 * 60000)).toBe('5m');
    expect(formatDuration(59 * 60000)).toBe('59m');
  });

  it('formats hours', () => {
    expect(formatDuration(2 * 60 * 60000)).toBe('2h');
    expect(formatDuration(2 * 60 * 60000 + 30 * 60000)).toBe('2h 30m');
  });

  it('formats days', () => {
    expect(formatDuration(2 * 24 * 60 * 60000)).toBe('2d');
  });
});
