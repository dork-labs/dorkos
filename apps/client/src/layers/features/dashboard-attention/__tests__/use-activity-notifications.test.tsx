/**
 * Home's "Recent activity" group reads the Inbox now, and it reads exactly three
 * kinds of it: what broke. Everything else the Inbox holds stays in the Inbox.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';

const mockInbox = vi.fn<() => { notifications: NotificationDTO[]; isLoading: boolean }>(() => ({
  notifications: [],
  isLoading: false,
}));

vi.mock('@/layers/entities/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/notifications')>();
  return { ...actual, useNotifications: () => mockInbox() };
});

import { useActivityNotifications } from '../model/use-activity-notifications';

/** Build a notification, overriding only what a test cares about. */
function build(overrides: Partial<NotificationDTO> = {}): NotificationDTO {
  return {
    id: '01JZF0000000000000000001',
    kind: 'turn.completed',
    tier: 'notable',
    subject: { type: 'session', id: 'ses-1' },
    title: 'alpha finished',
    createdAt: '2026-08-19T09:00:00.000Z',
    ...overrides,
  };
}

describe('useActivityNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInbox.mockReturnValue({ notifications: [], isLoading: false });
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

  it('leaves a finished turn out — nothing went wrong', () => {
    mockInbox.mockReturnValue({
      notifications: [build({ id: 'turn', kind: 'turn.completed' })],
      isLoading: false,
    });

    expect(renderHook(() => useActivityNotifications()).result.current.items).toHaveLength(0);
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

  it('leaves an agent note out — the Inbox holds it, this group does not', () => {
    mockInbox.mockReturnValue({
      notifications: [build({ id: 'note', kind: 'agent.note', tier: 'notable' })],
      isLoading: false,
    });

    expect(renderHook(() => useActivityNotifications()).result.current.items).toHaveLength(0);
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
