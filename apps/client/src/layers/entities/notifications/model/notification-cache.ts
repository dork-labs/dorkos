/**
 * The Inbox's cache rules — how a live event, and an optimistic read, land in
 * every lens at once (spec `notification-system` §Client).
 *
 * One store, N lenses. The bell reads the whole history, an agent's profile
 * reads the same history filtered to that agent, a session's menu to that
 * session — and each of those is its own TanStack Query entry keyed by the lens.
 * So a notification arriving over SSE has to be written into every cached lens
 * it belongs to, not just the one that happens to be mounted. These helpers walk
 * the cache doing exactly that, which is also what makes them testable without a
 * component.
 *
 * @module entities/notifications/model/notification-cache
 */
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type {
  ListNotificationsResponse,
  NotificationDTO,
  NotificationReadEvent,
} from '@dorkos/shared/notification-schemas';

/** The lens a surface reads the Inbox through. Every field narrows. */
export interface NotificationLens {
  /** Only notifications about this agent — the agent profile's section. */
  agentId?: string;
  /** Only notifications about this session — the session menu's view. */
  sessionId?: string;
  /** Only unread ones. */
  unread?: boolean;
}

/** Root of every Inbox query key, so one filter reaches all the lenses. */
export const NOTIFICATIONS_QUERY_KEY = ['notifications'] as const;

/** The cache shape one lens holds: the pages `useInfiniteQuery` has fetched. */
export type NotificationPages = InfiniteData<ListNotificationsResponse, string | undefined>;

/**
 * The query key for one lens.
 *
 * The lens is rebuilt field by field rather than spread, so two callers passing
 * the same filters in a different object order share one cache entry —
 * TanStack Query hashes keys structurally and an object literal's key order is
 * part of that hash.
 *
 * @param lens - The filters, or nothing for the whole history.
 */
export function notificationsQueryKey(lens?: NotificationLens) {
  return [
    ...NOTIFICATIONS_QUERY_KEY,
    {
      ...(lens?.agentId === undefined ? {} : { agentId: lens.agentId }),
      ...(lens?.sessionId === undefined ? {} : { sessionId: lens.sessionId }),
      ...(lens?.unread === true ? { unread: true } : {}),
    },
  ] as const;
}

/**
 * Whether a notification belongs in a lens.
 *
 * The same predicate the server's `WHERE` clause applies, restated here because
 * a live event never goes through the route — an upsert that ignored the lens
 * would put another agent's rows into the agent page somebody is reading.
 *
 * @param notification - The row that just arrived.
 * @param lens - The lens being written into.
 */
export function matchesLens(notification: NotificationDTO, lens: NotificationLens): boolean {
  if (lens.agentId !== undefined && notification.agentId !== lens.agentId) return false;
  if (lens.sessionId !== undefined && notification.sessionId !== lens.sessionId) return false;
  if (lens.unread === true && notification.readAt !== undefined) return false;
  return true;
}

/** Read the lens back off a cached query key. */
function lensOfKey(key: readonly unknown[]): NotificationLens {
  const filters = key[1];
  return typeof filters === 'object' && filters !== null ? (filters as NotificationLens) : {};
}

/**
 * Apply one change to every cached lens.
 *
 * @param queryClient - The client holding the Inbox caches.
 * @param apply - Given a lens and its pages, the pages that replace them.
 */
function updateEveryLens(
  queryClient: QueryClient,
  apply: (pages: NotificationPages, lens: NotificationLens) => NotificationPages
): void {
  const queries = queryClient.getQueryCache().findAll({ queryKey: NOTIFICATIONS_QUERY_KEY });
  for (const query of queries) {
    const pages = query.state.data as NotificationPages | undefined;
    if (pages === undefined) continue;
    queryClient.setQueryData(query.queryKey, apply(pages, lensOfKey(query.queryKey)));
  }
}

/**
 * Put a notification into the cache, or replace the one already there.
 *
 * **Upsert, never append.** A standing condition that resolves is broadcast a
 * second time under the SAME id, now carrying `resolvedAt` and its outcome, so a
 * surface holding the row has to replace it rather than draw the ending twice.
 * The same rule covers the ordinary race where a refetch and the event deliver
 * one row at once.
 *
 * A row that is genuinely new goes to the FRONT of the first page: the list is
 * ordered by id descending and a ULID minted now sorts above everything already
 * held. A row that no longer matches a lens (an unread lens, after it was read
 * elsewhere) is dropped from that lens instead.
 *
 * **It moves the unread count too, and that has to be decided once.** The count
 * is fleet-wide — the same number in every lens — so "have we seen this id
 * before?" is asked across the WHOLE cache before any lens is touched. Asking it
 * per lens would answer differently in a lens the row does not belong to, and
 * the bell would then draw a count that depended on which page happened to be
 * mounted. Without the bump at all, a notification arriving over SSE lands in
 * the list while the bell stays quiet until something else refetches.
 *
 * @param queryClient - The client holding the Inbox caches.
 * @param notification - The row from the `notification` event.
 */
export function upsertNotification(queryClient: QueryClient, notification: NotificationDTO): void {
  const knownAlready = queryClient
    .getQueryCache()
    .findAll({ queryKey: NOTIFICATIONS_QUERY_KEY })
    .some((query) =>
      (query.state.data as NotificationPages | undefined)?.pages.some((page) =>
        page.notifications.some((entry) => entry.id === notification.id)
      )
    );
  const bump = !knownAlready && notification.readAt === undefined ? 1 : 0;

  updateEveryLens(queryClient, (pages, lens) => {
    const held = pages.pages.some((page) =>
      page.notifications.some((entry) => entry.id === notification.id)
    );
    const belongs = matchesLens(notification, lens);

    const withCount = (page: ListNotificationsResponse): ListNotificationsResponse =>
      bump === 0 ? page : { ...page, unreadCount: page.unreadCount + bump };

    if (held) {
      return {
        ...pages,
        pages: pages.pages.map((page) => ({
          ...withCount(page),
          notifications: belongs
            ? page.notifications.map((entry) =>
                entry.id === notification.id ? notification : entry
              )
            : page.notifications.filter((entry) => entry.id !== notification.id),
        })),
      };
    }

    if (pages.pages.length === 0) return pages;
    const [first, ...rest] = pages.pages;
    // The count still moves in a lens the row does not belong to: it is the
    // whole Inbox's number, not this lens's.
    if (!belongs) return { ...pages, pages: pages.pages.map(withCount) };
    return {
      ...pages,
      pages: [
        { ...withCount(first), notifications: [notification, ...first.notifications] },
        ...rest.map(withCount),
      ],
    };
  });
}

/**
 * Move read state, from a `notification_read` event or an optimistic write.
 *
 * `all` is what "Mark all read" broadcasts, and it is applied without the ids
 * because the server marked rows this window may never have fetched.
 *
 * Every page's `unreadCount` is rewritten, not only the first: a later page is
 * refetched independently, and one stale copy of the number is enough to make
 * the bell disagree with itself after a scroll.
 *
 * @param queryClient - The client holding the Inbox caches.
 * @param event - Which rows were marked, when, and the count that follows.
 */
export function applyNotificationRead(
  queryClient: QueryClient,
  event: NotificationReadEvent
): void {
  const marked = new Set(event.ids);
  updateEveryLens(queryClient, (pages, lens) => ({
    ...pages,
    pages: pages.pages.map((page) => {
      const next = page.notifications.map((entry) =>
        (event.all || marked.has(entry.id)) && entry.readAt === undefined
          ? { ...entry, readAt: event.readAt }
          : entry
      );
      return {
        ...page,
        unreadCount: event.unreadCount,
        // An unread lens is a list of things still unread. Marking one read
        // takes it out of that list rather than leaving a row there wearing a
        // read mark, which is the one thing the lens promises never to hold.
        notifications: lens.unread === true ? next.filter((e) => e.readAt === undefined) : next,
      };
    }),
  }));
}

/**
 * Every cached lens exactly as it stands, for rolling an optimistic write back.
 *
 * @param queryClient - The client holding the Inbox caches.
 */
export function snapshotNotifications(
  queryClient: QueryClient
): [readonly unknown[], NotificationPages | undefined][] {
  return queryClient
    .getQueryCache()
    .findAll({ queryKey: NOTIFICATIONS_QUERY_KEY })
    .map((query) => [query.queryKey, query.state.data as NotificationPages | undefined]);
}

/**
 * Put every lens back as {@link snapshotNotifications} found it.
 *
 * @param queryClient - The client holding the Inbox caches.
 * @param snapshot - What the caches held before the optimistic write.
 */
export function restoreNotifications(
  queryClient: QueryClient,
  snapshot: [readonly unknown[], NotificationPages | undefined][]
): void {
  for (const [key, pages] of snapshot) queryClient.setQueryData(key, pages);
}
