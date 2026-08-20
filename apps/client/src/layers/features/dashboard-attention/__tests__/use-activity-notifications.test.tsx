/**
 * Home's "Recent activity" group reads the Inbox now — through its OWN lens, so
 * a working morning cannot bury the one thing that broke, and bounded to a day,
 * so a row does not sit there all week.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import type { NotificationLens } from '@/layers/entities/notifications';

/** Frozen "now", so the 24-hour window is a fact rather than a race. */
const NOW = new Date('2026-08-20T12:00:00.000Z').getTime();

/** Lenses the hook asked for, so a test can assert it filtered server-side. */
const lensesSeen: (NotificationLens | undefined)[] = [];

const mockInbox = vi.fn<() => { notifications: NotificationDTO[]; isLoading: boolean }>(() => ({
  notifications: [],
  isLoading: false,
}));

vi.mock('@/layers/entities/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/notifications')>();
  return {
    ...actual,
    useNotifications: (lens?: NotificationLens) => {
      lensesSeen.push(lens);
      return mockInbox();
    },
  };
});

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useNow: () => NOW };
});

import { useActivityNotifications } from '../model/use-activity-notifications';

/** Build a notification, overriding only what a test cares about. */
function build(overrides: Partial<NotificationDTO> = {}): NotificationDTO {
  return {
    id: '01JZF0000000000000000001',
    kind: 'run.completed',
    tier: 'notable',
    subject: { type: 'run', id: 'run-1' },
    title: 'Nightly sweep failed',
    createdAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

/** A timestamp `hours` before the frozen now. */
function hoursAgo(hours: number): string {
  return new Date(NOW - hours * 60 * 60 * 1000).toISOString();
}

describe('useActivityNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lensesSeen.length = 0;
    mockInbox.mockReturnValue({ notifications: [], isLoading: false });
  });

  it('asks the server for the three kinds rather than sieving the bell page', () => {
    // The whole point of the lens. Seeded defect: call `useNotifications()`
    // unfiltered and this records `undefined`, which is the arrangement where a
    // morning of finished turns hides a failed run behind "Load more".
    renderHook(() => useActivityNotifications());

    expect(lensesSeen[0]?.kinds).toEqual([
      'run.completed',
      'dead-letter.created',
      'agent.unreachable',
    ]);
  });

  it('keeps the three kinds that mean something broke', () => {
    mockInbox.mockReturnValue({
      notifications: [
        build({ id: 'run', kind: 'run.completed', tier: 'notable' }),
        build({ id: 'dead', kind: 'dead-letter.created', tier: 'quiet' }),
        build({ id: 'offline', kind: 'agent.unreachable', tier: 'quiet' }),
      ],
      isLoading: false,
    });

    const { result } = renderHook(() => useActivityNotifications());

    expect(result.current.items.map((n) => n.id)).toEqual(['run', 'dead', 'offline']);
  });

  it('leaves a successful run out, and keeps the failed one', () => {
    // `run.completed` carries both outcomes under one kind, and `quiet` is
    // exactly how the registry spells "it worked". Seeded defect: drop the tier
    // check and every nightly success fills the group that exists for failures.
    mockInbox.mockReturnValue({
      notifications: [
        build({ id: 'ok', kind: 'run.completed', tier: 'quiet' }),
        build({ id: 'failed', kind: 'run.completed', tier: 'notable' }),
      ],
      isLoading: false,
    });

    const { result } = renderHook(() => useActivityNotifications());

    expect(result.current.items.map((n) => n.id)).toEqual(['failed']);
  });

  it('drops a row older than a day, however long the Inbox keeps it', () => {
    // The Inbox keeps 30 days — that is where you go to find out about last
    // week. This group sits above a conversation and answers "what is wrong
    // right now", and an agent that went quiet on Tuesday is not that. Seeded
    // defect: remove the window and the stale row never leaves the header.
    mockInbox.mockReturnValue({
      notifications: [
        build({ id: 'fresh', kind: 'agent.unreachable', tier: 'quiet', createdAt: hoursAgo(3) }),
        build({ id: 'stale', kind: 'agent.unreachable', tier: 'quiet', createdAt: hoursAgo(30) }),
      ],
      isLoading: false,
    });

    const { result } = renderHook(() => useActivityNotifications());

    expect(result.current.items.map((n) => n.id)).toEqual(['fresh']);
  });

  it('keeps a row that is just inside the day', () => {
    mockInbox.mockReturnValue({
      notifications: [build({ id: 'edge', createdAt: hoursAgo(23) })],
      isLoading: false,
    });

    expect(renderHook(() => useActivityNotifications()).result.current.items).toHaveLength(1);
  });

  it('caps the group at eight rows', () => {
    mockInbox.mockReturnValue({
      notifications: Array.from({ length: 12 }, (_, i) =>
        build({ id: `d${i}`, kind: 'dead-letter.created', tier: 'quiet' })
      ),
      isLoading: false,
    });

    expect(renderHook(() => useActivityNotifications()).result.current.items).toHaveLength(8);
  });

  it('reports the Inbox still loading, so nothing claims all-clear too early', () => {
    mockInbox.mockReturnValue({ notifications: [], isLoading: true });

    expect(renderHook(() => useActivityNotifications()).result.current.isLoading).toBe(true);
  });

  it('holds one array identity while nothing changes', () => {
    const { result, rerender } = renderHook(() => useActivityNotifications());
    const first = result.current.items;
    rerender();
    expect(result.current.items).toBe(first);
  });
});
