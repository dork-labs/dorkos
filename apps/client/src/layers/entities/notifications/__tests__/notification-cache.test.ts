/**
 * One store, N lenses: a live notification has to land in every cached lens it
 * belongs to and in none that it does not, and read state has to move the same
 * way in all of them at once.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import type {
  ListNotificationsResponse,
  NotificationDTO,
} from '@dorkos/shared/notification-schemas';
import {
  applyNotificationRead,
  matchesLens,
  notificationsQueryKey,
  restoreNotifications,
  snapshotNotifications,
  upsertNotification,
  type NotificationLens,
  type NotificationPages,
} from '../model/notification-cache';

/** Build a notification, overriding only what a test cares about. */
function build(overrides: Partial<NotificationDTO> = {}): NotificationDTO {
  return {
    id: '01JZC0000000000000000005',
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

/** One page of a cached lens. */
function page(
  notifications: NotificationDTO[],
  unreadCount = notifications.filter((n) => n.readAt === undefined).length
): ListNotificationsResponse {
  return { notifications, nextCursor: null, unreadCount };
}

/** Seed a lens with pages. */
function seed(client: QueryClient, lens: NotificationLens | undefined, pages: NotificationPages) {
  client.setQueryData(notificationsQueryKey(lens), pages);
}

/** Read a lens back. */
function read(client: QueryClient, lens?: NotificationLens): NotificationDTO[] {
  const data = client.getQueryData<NotificationPages>(notificationsQueryKey(lens));
  return data?.pages.flatMap((p) => p.notifications) ?? [];
}

/** Wrap pages the way `useInfiniteQuery` stores them. */
function infinite(...pages: ListNotificationsResponse[]): NotificationPages {
  return {
    pages,
    pageParams: pages.map((_, i) => (i === 0 ? undefined : `cursor-${i}`)),
  } as InfiniteData<ListNotificationsResponse, string | undefined>;
}

describe('notification lens matching', () => {
  it('keeps a notification out of an agent lens it does not belong to', () => {
    expect(matchesLens(build({ agentId: 'alpha' }), { agentId: 'beta' })).toBe(false);
    expect(matchesLens(build({ agentId: 'alpha' }), { agentId: 'alpha' })).toBe(true);
  });

  it('keeps a notification out of a session lens it does not belong to', () => {
    expect(matchesLens(build({ sessionId: 'ses-1' }), { sessionId: 'ses-2' })).toBe(false);
    expect(matchesLens(build({ sessionId: 'ses-1' }), { sessionId: 'ses-1' })).toBe(true);
  });

  it('refuses a read notification for an unread lens', () => {
    const readRow = build({ readAt: '2026-08-19T09:05:00.000Z' });
    expect(matchesLens(readRow, { unread: true })).toBe(false);
    expect(matchesLens(build(), { unread: true })).toBe(true);
  });

  it('admits everything through no lens at all', () => {
    expect(matchesLens(build({ agentId: undefined, sessionId: undefined }), {})).toBe(true);
  });
});

describe('upsertNotification', () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient();
  });

  it('puts a new notification at the front of the newest page', () => {
    seed(client, undefined, infinite(page([build({ id: '01JZC0000000000000000001' })])));

    upsertNotification(client, build({ id: '01JZC0000000000000000009' }));

    // Newest first: the list is ordered by ULID descending and a ULID minted
    // now sorts above everything already held.
    expect(read(client).map((n) => n.id)).toEqual([
      '01JZC0000000000000000009',
      '01JZC0000000000000000001',
    ]);
  });

  it('replaces in place rather than appending a second copy', () => {
    // The exact shape a resolving standing condition takes: the same id
    // broadcast again, now carrying its outcome.
    seed(client, undefined, infinite(page([build({ id: 'a', title: 'alpha is waiting' })])));

    upsertNotification(
      client,
      build({
        id: 'a',
        title: 'alpha is waiting',
        resolvedAt: '2026-08-19T09:10:00.000Z',
        outcome: 'answered',
      })
    );

    const rows = read(client);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('answered');
  });

  it('writes into every lens it belongs to, and no others', () => {
    seed(client, undefined, infinite(page([])));
    seed(client, { agentId: 'alpha' }, infinite(page([])));
    seed(client, { agentId: 'beta' }, infinite(page([])));

    upsertNotification(client, build({ id: 'n1', agentId: 'alpha' }));

    expect(read(client)).toHaveLength(1);
    expect(read(client, { agentId: 'alpha' })).toHaveLength(1);
    // The discriminating half: without the lens check this row would land in
    // beta's page too, and an agent's profile would show another agent's news.
    expect(read(client, { agentId: 'beta' })).toHaveLength(0);
  });

  it('drops a row from an unread lens once the upsert says it was read', () => {
    seed(client, { unread: true }, infinite(page([build({ id: 'n1' })])));

    upsertNotification(client, build({ id: 'n1', readAt: '2026-08-19T09:05:00.000Z' }));

    expect(read(client, { unread: true })).toHaveLength(0);
  });

  it('leaves a lens that has never been read alone', () => {
    // Nothing seeded: an unmounted lens must not be conjured into existence by
    // an event, or the next mount would replay a cache nobody fetched.
    upsertNotification(client, build({ id: 'n1' }));
    expect(client.getQueryData(notificationsQueryKey())).toBeUndefined();
  });
});

describe('applyNotificationRead', () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient();
  });

  it('marks named ids and rewrites the count on every page', () => {
    seed(
      client,
      undefined,
      infinite(page([build({ id: 'a' }), build({ id: 'b' })], 5), page([build({ id: 'c' })], 5))
    );

    applyNotificationRead(client, {
      ids: ['a', 'c'],
      all: false,
      readAt: '2026-08-19T10:00:00.000Z',
      unreadCount: 3,
    });

    const rows = read(client);
    expect(rows.find((n) => n.id === 'a')?.readAt).toBe('2026-08-19T10:00:00.000Z');
    expect(rows.find((n) => n.id === 'b')?.readAt).toBeUndefined();
    expect(rows.find((n) => n.id === 'c')?.readAt).toBe('2026-08-19T10:00:00.000Z');
    // Both pages, not only the first: a later page is refetched independently,
    // and one stale copy is enough to make the bell disagree with itself.
    const data = client.getQueryData<NotificationPages>(notificationsQueryKey());
    expect(data?.pages.map((p) => p.unreadCount)).toEqual([3, 3]);
  });

  it('marks everything when `all` is set, without being told the ids', () => {
    seed(client, undefined, infinite(page([build({ id: 'a' }), build({ id: 'b' })])));

    applyNotificationRead(client, {
      ids: [],
      all: true,
      readAt: '2026-08-19T10:00:00.000Z',
      unreadCount: 0,
    });

    expect(read(client).every((n) => n.readAt !== undefined)).toBe(true);
  });

  it('does not move a readAt that was already set', () => {
    seed(
      client,
      undefined,
      infinite(page([build({ id: 'a', readAt: '2026-08-19T08:00:00.000Z' })]))
    );

    applyNotificationRead(client, {
      ids: ['a'],
      all: false,
      readAt: '2026-08-19T10:00:00.000Z',
      unreadCount: 0,
    });

    expect(read(client)[0]?.readAt).toBe('2026-08-19T08:00:00.000Z');
  });

  it('empties an unread lens rather than leaving read rows in it', () => {
    seed(client, { unread: true }, infinite(page([build({ id: 'a' }), build({ id: 'b' })])));

    applyNotificationRead(client, {
      ids: ['a'],
      all: false,
      readAt: '2026-08-19T10:00:00.000Z',
      unreadCount: 1,
    });

    expect(read(client, { unread: true }).map((n) => n.id)).toEqual(['b']);
  });
});

describe('snapshot and restore', () => {
  it('puts every lens back exactly as it was', () => {
    const client = new QueryClient();
    seed(client, undefined, infinite(page([build({ id: 'a' })])));
    seed(client, { agentId: 'alpha' }, infinite(page([build({ id: 'a' })])));

    const snapshot = snapshotNotifications(client);
    applyNotificationRead(client, {
      ids: [],
      all: true,
      readAt: '2026-08-19T10:00:00.000Z',
      unreadCount: 0,
    });
    expect(read(client)[0]?.readAt).toBeDefined();

    restoreNotifications(client, snapshot);

    expect(read(client)[0]?.readAt).toBeUndefined();
    expect(read(client, { agentId: 'alpha' })[0]?.readAt).toBeUndefined();
  });
});

describe('notificationsQueryKey', () => {
  it('hashes the same for the same lens whatever order the fields were written in', () => {
    // TanStack Query hashes keys structurally, so a caller building the object
    // the other way round must not open a second cache entry and a second
    // request for the list already on screen.
    expect(JSON.stringify(notificationsQueryKey({ agentId: 'a', sessionId: 's' }))).toBe(
      JSON.stringify(notificationsQueryKey({ sessionId: 's', agentId: 'a' }))
    );
  });

  it('leaves an absent filter out of the key entirely', () => {
    expect(notificationsQueryKey()).toEqual(notificationsQueryKey({}));
  });
});

describe('upsertNotification and the unread count', () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient();
  });

  it('bumps the count when a new unread notification arrives', () => {
    // Without this the row lands in the list and the bell stays quiet until
    // something else refetches — the defect this test was written against.
    seed(client, undefined, infinite(page([], 2)));

    upsertNotification(client, build({ id: 'new-1' }));

    const data = client.getQueryData<NotificationPages>(notificationsQueryKey());
    expect(data?.pages[0]?.unreadCount).toBe(3);
  });

  it('bumps the count in a lens the row does not belong to', () => {
    // The count is the whole Inbox's, not the lens's: a bell drawn beside an
    // agent's page must still say how many are unread everywhere.
    seed(client, { agentId: 'beta' }, infinite(page([], 2)));

    upsertNotification(client, build({ id: 'new-1', agentId: 'alpha' }));

    const data = client.getQueryData<NotificationPages>(notificationsQueryKey({ agentId: 'beta' }));
    expect(data?.pages[0]?.notifications).toHaveLength(0);
    expect(data?.pages[0]?.unreadCount).toBe(3);
  });

  it('does not bump twice when the same id is broadcast again', () => {
    // A standing condition resolving is the SAME id carrying its outcome.
    seed(client, undefined, infinite(page([build({ id: 'a' })], 1)));

    upsertNotification(client, build({ id: 'a', resolvedAt: '2026-08-19T09:10:00.000Z' }));

    const data = client.getQueryData<NotificationPages>(notificationsQueryKey());
    expect(data?.pages[0]?.unreadCount).toBe(1);
  });

  it('does not bump for a notification that arrives already read', () => {
    seed(client, undefined, infinite(page([], 2)));

    upsertNotification(client, build({ id: 'new-1', readAt: '2026-08-19T09:05:00.000Z' }));

    const data = client.getQueryData<NotificationPages>(notificationsQueryKey());
    expect(data?.pages[0]?.unreadCount).toBe(2);
  });

  it('agrees across every lens about how much to bump', () => {
    // The count is decided once, before any lens is touched. Deciding it per
    // lens would answer differently in a lens that already held the row, and
    // the bell would then depend on which page happened to be mounted.
    seed(client, undefined, infinite(page([build({ id: 'a', agentId: 'alpha' })], 4)));
    seed(client, { agentId: 'alpha' }, infinite(page([], 4)));

    upsertNotification(client, build({ id: 'a', agentId: 'alpha' }));

    expect(
      client.getQueryData<NotificationPages>(notificationsQueryKey())?.pages[0]?.unreadCount
    ).toBe(4);
    expect(
      client.getQueryData<NotificationPages>(notificationsQueryKey({ agentId: 'alpha' }))?.pages[0]
        ?.unreadCount
    ).toBe(4);
  });
});
