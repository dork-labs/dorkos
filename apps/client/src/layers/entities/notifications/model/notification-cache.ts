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
  NotificationKind,
  NotificationReadEvent,
} from '@dorkos/shared/notification-schemas';

/** The lens a surface reads the Inbox through. Every field narrows. */
export interface NotificationLens {
  /** Only notifications about this agent — the agent profile's section. */
  agentId?: string;
  /** Only notifications about this session — the session menu's view. */
  sessionId?: string;
  /**
   * Only these kinds — home's activity group asks for the three that mean
   * something broke.
   *
   * A lens key, so the rows come off their OWN paged query rather than being
   * sieved out of the bell's first page: a working morning puts 25 finished
   * turns above the one run that failed, and a group that narrowed in the client
   * would show nothing until somebody pressed "Load more".
   */
  kinds?: readonly NotificationKind[];
  /** Only unread ones. */
  unread?: boolean;
}

/** Root of every Inbox query key, so one filter reaches all the lenses. */
export const NOTIFICATIONS_QUERY_KEY = ['notifications'] as const;

/**
 * How many live arrivals one lens will hold on its newest page.
 *
 * A cockpit left open overnight prepends a row per event forever, and nothing
 * else trims it: TanStack keeps the pages it has, and the rows arriving over SSE
 * were never paged in. Two pages' worth is more than any popover shows and more
 * than anybody scrolls without paging, so the tail past it is dropped.
 *
 * **Dropping is safe because the server still has it.** The rows fall off the
 * BOTTOM of the newest page, which is exactly where "Load more" fetches from —
 * so a person who scrolls that far gets them back off `GET /api/notifications`,
 * cursored, rather than out of a cache that grew all night.
 */
export const MAX_LIVE_PAGE_ROWS = 50;

/**
 * How many arrivals the double-bump guard remembers.
 *
 * It only has to outlive one event's fan-out across the mounted hooks, which is
 * a handful of synchronous calls. Two hundred is far more than that and still a
 * few kilobytes of ids.
 */
const BUMPED_MEMORY = 200;

/**
 * Ids whose unread bump has already been counted.
 *
 * **Module-level because the double-count is too.** Every mounted
 * `useNotifications` subscribes to the `notification` event separately, so one
 * arrival calls {@link upsertNotification} once per hook. Cache membership
 * usually absorbs that — the second call finds the row the first one wrote — but
 * not when the row matches no cached lens: two hooks reading narrow lenses the
 * notification does not belong to will each see "new" and each add one to a
 * count that should have moved by one in total.
 *
 * A `Set` rather than a counter or a timestamp: the question is exactly "have we
 * counted THIS id", and it must answer the same way however many hooks ask.
 */
const bumpedIds = new Set<string>();

/**
 * Whether this arrival still owes the unread count a bump, claiming it if so.
 *
 * @param id - The notification's id.
 */
function claimBump(id: string): boolean {
  if (bumpedIds.has(id)) return false;
  bumpedIds.add(id);
  // Bounded, oldest out first. `Set` iterates in insertion order, so the first
  // key is the oldest one.
  if (bumpedIds.size > BUMPED_MEMORY) {
    const oldest = bumpedIds.values().next().value;
    if (oldest !== undefined) bumpedIds.delete(oldest);
  }
  return true;
}

/**
 * Forget every claimed bump.
 *
 * @internal Exported for testing only.
 */
export function clearBumpedNotifications(): void {
  bumpedIds.clear();
}

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
      // Joined rather than left as an array: TanStack hashes keys structurally,
      // and `['run.completed','agent.note']` and its reverse are the same lens
      // asked for in a different order.
      ...(lens?.kinds === undefined || lens.kinds.length === 0
        ? {}
        : { kinds: [...lens.kinds].sort().join(',') }),
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
  if (lens.kinds !== undefined && lens.kinds.length > 0 && !lens.kinds.includes(notification.kind))
    return false;
  if (lens.unread === true && notification.readAt !== undefined) return false;
  return true;
}

/**
 * Trim the newest page back under {@link MAX_LIVE_PAGE_ROWS}, moving the cursor
 * with it.
 *
 * **The cursor has to move, or the cap eats a row.** `nextCursor` is the id of
 * the last row ON the page, and `before: <cursor>` is exclusive — so if the trim
 * drops the row the cursor names, "Load more" asks for everything older than a
 * row that is no longer anywhere, and that row is silently skipped. Pointing the
 * cursor at the last row we KEEP makes the dropped tail exactly what the next
 * page fetches.
 *
 * A page that was the last one (`nextCursor: null`) and then got trimmed grows a
 * cursor for the same reason: there is now something older to go and get.
 *
 * @param rows - The page's rows after the prepend, newest first.
 * @param cursor - The page's current cursor.
 */
function capNewestPage(
  rows: NotificationDTO[],
  cursor: string | null
): { notifications: NotificationDTO[]; nextCursor: string | null } {
  if (rows.length <= MAX_LIVE_PAGE_ROWS) return { notifications: rows, nextCursor: cursor };
  const kept = rows.slice(0, MAX_LIVE_PAGE_ROWS);
  return { notifications: kept, nextCursor: kept[kept.length - 1]?.id ?? cursor };
}

/**
 * Read the lens back off a cached query key.
 *
 * `kinds` is stored in the key as a sorted, comma-joined STRING (so two callers
 * naming the same kinds in a different order share one cache entry), and it has
 * to be split back into an array here. Handing the raw string to
 * {@link matchesLens} would leave `includes` doing substring matching — which
 * happens to answer correctly often enough to hide the bug.
 */
function lensOfKey(key: readonly unknown[]): NotificationLens {
  const filters = key[1];
  if (typeof filters !== 'object' || filters === null) return {};
  const { kinds, ...rest } = filters as Omit<NotificationLens, 'kinds'> & { kinds?: string };
  return {
    ...rest,
    ...(kinds === undefined ? {} : { kinds: kinds.split(',') as NotificationKind[] }),
  };
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
 * **Upsert, never append, and the reason is a race rather than a re-broadcast.**
 * The server writes one row per event and broadcasts each id exactly once — a
 * standing condition stores nothing while it stands and produces a single row
 * when it resolves, already carrying its outcome. What DOES arrive twice is one
 * row down two paths: the `notification` event and a `GET /api/notifications`
 * refetch that was already in flight when it fired. Appending would draw that
 * row twice, which a person reads as "it happened again". Replacing by id also
 * leaves the door open for a future kind that does revise a row in place,
 * without that becoming a second code path.
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
  const bump =
    !knownAlready && notification.readAt === undefined && claimBump(notification.id) ? 1 : 0;

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
    const grown = [notification, ...first.notifications];
    return {
      ...pages,
      pages: [
        { ...withCount(first), ...capNewestPage(grown, first.nextCursor) },
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
