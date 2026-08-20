/**
 * The Inbox hook: a page from the server, then the live stream on top of it, and
 * read state that can be taken back when the write fails.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { createMockTransport } from '@dorkos/test-utils';

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useEventSubscription: vi.fn() };
});

import { TransportProvider, useEventSubscription } from '@/layers/shared/model';
import { useNotifications, useUnreadCount } from '../model/use-notifications';
import { useMarkAllRead, useMarkRead } from '../model/use-mark-read';

/** Build a notification, overriding only what a test cares about. */
function build(overrides: Partial<NotificationDTO> = {}): NotificationDTO {
  return {
    id: '01JZD0000000000000000001',
    kind: 'turn.completed',
    tier: 'notable',
    subject: { type: 'session', id: 'ses-1' },
    sessionId: 'ses-1',
    agentId: 'alpha',
    title: 'alpha finished',
    createdAt: '2026-08-19T09:00:00.000Z',
    ...overrides,
  };
}

/** Handlers the hook registered, keyed by event name. */
let handlers: Map<string, (raw: unknown) => void>;

/** Render a hook over a mock transport. */
function renderInbox<T>(hook: () => T, overrides: Partial<Transport> = {}) {
  const transport = createMockTransport(overrides);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  return { transport, queryClient, ...renderHook(hook, { wrapper: Wrapper }) };
}

describe('useNotifications', () => {
  beforeEach(() => {
    handlers = new Map();
    vi.mocked(useEventSubscription).mockImplementation((event, handler) => {
      handlers.set(event, handler as (raw: unknown) => void);
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('reads the first page and the fleet-wide unread count', async () => {
    const { result, transport } = renderInbox(() => useNotifications(), {
      listNotifications: vi.fn().mockResolvedValue({
        notifications: [build({ id: 'a' }), build({ id: 'b' })],
        nextCursor: null,
        unreadCount: 7,
      }),
    });

    await waitFor(() => expect(result.current.notifications).toHaveLength(2));
    expect(result.current.unreadCount).toBe(7);
    expect(transport.listNotifications).toHaveBeenCalledWith({ limit: 25 });
  });

  it('passes an agent lens to the server', async () => {
    const { result, transport } = renderInbox(() => useNotifications({ agentId: 'alpha' }));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(transport.listNotifications).toHaveBeenCalledWith({ limit: 25, agentId: 'alpha' });
  });

  it('passes a session lens to the server, and the unread flag only when asked', async () => {
    const { result, transport } = renderInbox(() =>
      useNotifications({ sessionId: 'ses-9', unread: true })
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(transport.listNotifications).toHaveBeenCalledWith({
      limit: 25,
      sessionId: 'ses-9',
      unread: true,
    });
  });

  it('takes a notification off the stream without refetching', async () => {
    const listNotifications = vi
      .fn()
      .mockResolvedValue({ notifications: [], nextCursor: null, unreadCount: 0 });
    const { result } = renderInbox(() => useNotifications(), { listNotifications });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.notifications).toHaveLength(0);

    act(() => handlers.get('notification')?.({ notification: build({ id: 'live-1' }) }));

    await waitFor(() => expect(result.current.notifications).toHaveLength(1));
    expect(result.current.notifications[0]?.id).toBe('live-1');
    // The whole point of the stream: one read, and everything after it arrives
    // rather than being polled for.
    expect(listNotifications).toHaveBeenCalledTimes(1);
  });

  it('ignores a `notification` frame that is not a notification', async () => {
    const { result } = renderInbox(() => useNotifications());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => handlers.get('notification')?.({ nonsense: true }));

    expect(result.current.notifications).toHaveLength(0);
  });

  it('applies a read event raised by another window', async () => {
    const { result } = renderInbox(() => useNotifications(), {
      listNotifications: vi.fn().mockResolvedValue({
        notifications: [build({ id: 'a' })],
        nextCursor: null,
        unreadCount: 1,
      }),
    });
    await waitFor(() => expect(result.current.unreadCount).toBe(1));

    act(() =>
      handlers.get('notification_read')?.({
        ids: ['a'],
        all: false,
        readAt: '2026-08-19T10:00:00.000Z',
        unreadCount: 0,
      })
    );

    await waitFor(() => expect(result.current.unreadCount).toBe(0));
    expect(result.current.notifications[0]?.readAt).toBe('2026-08-19T10:00:00.000Z');
  });

  it('pages with the cursor the server handed back', async () => {
    const listNotifications = vi
      .fn()
      .mockResolvedValueOnce({
        notifications: [build({ id: 'a' })],
        nextCursor: 'a',
        unreadCount: 2,
      })
      .mockResolvedValueOnce({
        notifications: [build({ id: 'b' })],
        nextCursor: null,
        unreadCount: 2,
      });
    const { result } = renderInbox(() => useNotifications(), { listNotifications });

    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.loadMore());

    await waitFor(() => expect(result.current.notifications).toHaveLength(2));
    expect(listNotifications).toHaveBeenLastCalledWith({ limit: 25, before: 'a' });
    expect(result.current.hasMore).toBe(false);
  });

  it('says so when the list cannot be read', async () => {
    const { result } = renderInbox(() => useNotifications(), {
      listNotifications: vi.fn().mockRejectedValue(new Error('offline')),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.notifications).toHaveLength(0);
  });
});

describe('useUnreadCount', () => {
  beforeEach(() => {
    handlers = new Map();
    vi.mocked(useEventSubscription).mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('reads the same unfiltered page the bell list uses', async () => {
    const { result, transport } = renderInbox(() => useUnreadCount(), {
      listNotifications: vi
        .fn()
        .mockResolvedValue({ notifications: [], nextCursor: null, unreadCount: 4 }),
    });

    await waitFor(() => expect(result.current).toBe(4));
    // Unfiltered: a count scoped to the open lens would go quiet the moment
    // somebody opened one agent.
    expect(transport.listNotifications).toHaveBeenCalledWith({ limit: 25 });
  });
});

describe('useMarkRead', () => {
  beforeEach(() => {
    handlers = new Map();
    vi.mocked(useEventSubscription).mockImplementation((event, handler) => {
      handlers.set(event, handler as (raw: unknown) => void);
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('dims the row and drops the count before the server answers', async () => {
    let resolveWrite: (value: unknown) => void = () => {};
    const markNotificationRead = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveWrite = resolve;
      })
    );
    const { result } = renderInbox(() => ({ inbox: useNotifications(), mark: useMarkRead() }), {
      listNotifications: vi.fn().mockResolvedValue({
        notifications: [build({ id: 'a' })],
        nextCursor: null,
        unreadCount: 3,
      }),
      markNotificationRead,
    });
    await waitFor(() => expect(result.current.inbox.unreadCount).toBe(3));

    act(() => result.current.mark.mutate('a'));

    // Still in flight, and already dimmed: a row that stays bold for a round
    // trip reads as a click that missed.
    await waitFor(() => expect(result.current.inbox.notifications[0]?.readAt).toBeDefined());
    expect(result.current.inbox.unreadCount).toBe(2);

    await act(async () => {
      resolveWrite({ ok: true, marked: 1, unreadCount: 2 });
    });
  });

  it('puts the row back when the write fails', async () => {
    const { result } = renderInbox(() => ({ inbox: useNotifications(), mark: useMarkRead() }), {
      listNotifications: vi.fn().mockResolvedValue({
        notifications: [build({ id: 'a' })],
        nextCursor: null,
        unreadCount: 3,
      }),
      markNotificationRead: vi.fn().mockRejectedValue(new Error('offline')),
    });
    await waitFor(() => expect(result.current.inbox.unreadCount).toBe(3));

    act(() => result.current.mark.mutate('a'));

    // The rollback is the discriminating half: without it the row stays dimmed
    // and the count stays wrong until something else refetches.
    await waitFor(() => expect(result.current.inbox.notifications[0]?.readAt).toBeUndefined());
    expect(result.current.inbox.unreadCount).toBe(3);
  });

  it('takes the count the server answers with, not its own guess', async () => {
    const { result } = renderInbox(() => ({ inbox: useNotifications(), mark: useMarkRead() }), {
      listNotifications: vi.fn().mockResolvedValue({
        notifications: [build({ id: 'a' })],
        nextCursor: null,
        unreadCount: 3,
      }),
      // Another window marked two more between the read and this write.
      markNotificationRead: vi.fn().mockResolvedValue({ ok: true, marked: 1, unreadCount: 0 }),
    });
    await waitFor(() => expect(result.current.inbox.unreadCount).toBe(3));

    act(() => result.current.mark.mutate('a'));

    await waitFor(() => expect(result.current.inbox.unreadCount).toBe(0));
  });
});

describe('useMarkAllRead', () => {
  beforeEach(() => {
    handlers = new Map();
    vi.mocked(useEventSubscription).mockImplementation((event, handler) => {
      handlers.set(event, handler as (raw: unknown) => void);
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('clears every row and the count at once', async () => {
    const { result } = renderInbox(
      () => ({ inbox: useNotifications(), markAll: useMarkAllRead() }),
      {
        listNotifications: vi.fn().mockResolvedValue({
          notifications: [build({ id: 'a' }), build({ id: 'b' })],
          nextCursor: null,
          unreadCount: 2,
        }),
        markAllNotificationsRead: vi.fn().mockResolvedValue({
          ok: true,
          marked: 2,
          unreadCount: 0,
        }),
      }
    );
    await waitFor(() => expect(result.current.inbox.unreadCount).toBe(2));

    act(() => result.current.markAll.mutate());

    await waitFor(() => expect(result.current.inbox.unreadCount).toBe(0));
    expect(result.current.inbox.notifications.every((n) => n.readAt !== undefined)).toBe(true);
  });

  it('puts everything back when the write fails', async () => {
    const { result } = renderInbox(
      () => ({ inbox: useNotifications(), markAll: useMarkAllRead() }),
      {
        listNotifications: vi.fn().mockResolvedValue({
          notifications: [build({ id: 'a' }), build({ id: 'b' })],
          nextCursor: null,
          unreadCount: 2,
        }),
        markAllNotificationsRead: vi.fn().mockRejectedValue(new Error('offline')),
      }
    );
    await waitFor(() => expect(result.current.inbox.unreadCount).toBe(2));

    act(() => result.current.markAll.mutate());

    await waitFor(() =>
      expect(result.current.inbox.notifications.every((n) => n.readAt === undefined)).toBe(true)
    );
    expect(result.current.inbox.unreadCount).toBe(2);
  });
});
