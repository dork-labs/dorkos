/**
 * The Inbox itself — one page-able list, kept live, read through a lens.
 *
 * Seeded from `GET /api/notifications` and then kept current by the global
 * stream, the same shape `usePendingInteractions` next door uses: a query for
 * the history that existed before this window opened, and SSE for everything
 * after. There is no poll — a notification that arrives while somebody is
 * looking at the bell is written straight into the cache.
 *
 * @module entities/notifications/model/use-notifications
 */
import { useCallback, useMemo } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import {
  NotificationEventSchema,
  NotificationReadEventSchema,
  type NotificationDTO,
  type NotificationKind,
} from '@dorkos/shared/notification-schemas';
import { useEventSubscription, useTransport } from '@/layers/shared/model';
import {
  applyNotificationRead,
  notificationsQueryKey,
  upsertNotification,
  type NotificationLens,
} from './notification-cache';

/** How many rows one page holds. Matches the spec's cursor page size. */
const PAGE_SIZE = 25;

/** Shared empty, so a quiet Inbox never mints a fresh array identity. */
const NO_NOTIFICATIONS: readonly NotificationDTO[] = [];

/** What {@link useNotifications} hands its consumers. */
export interface NotificationsState {
  /** Every row fetched so far, newest first. */
  notifications: readonly NotificationDTO[];
  /**
   * How many stored notifications are unread across the WHOLE Inbox.
   *
   * Deliberately not scoped to the lens: it is the number the bell draws, and a
   * bell that counted only the open lens would go quiet the moment somebody
   * opened one agent's page.
   */
  unreadCount: number;
  /** True only on the very first load, before any page has arrived. */
  isLoading: boolean;
  /** True when the list could not be read at all. */
  isError: boolean;
  /** Whether there is an older page to fetch. */
  hasMore: boolean;
  /** Fetch the next older page. */
  loadMore: () => void;
  /** True while an older page is on its way. */
  isLoadingMore: boolean;
}

/**
 * The Inbox, through one lens.
 *
 * ## One store, several lenses
 *
 * Each distinct lens is its own cache entry, so the bell (no lens), an agent's
 * profile (`agentId`) and a session's menu (`sessionId`) each hold their own
 * pages — and a live event is written into every one of them it belongs to, by
 * `notification-cache`. Two callers passing the same lens share one entry and
 * one request.
 *
 * ## Filtering by kind is the caller's job
 *
 * The route takes a single `kind`, and the one surface that wants several —
 * home's activity group — reads the unfiltered list and narrows it in place.
 * That deliberately shares the bell's cache rather than opening a second
 * request for rows the bell already fetched.
 *
 * @param lens - Which slice of the Inbox to read. Omit for all of it.
 */
export function useNotifications(lens?: NotificationLens): NotificationsState {
  const transport = useTransport();
  const queryClient = useQueryClient();

  // Rebuilt from the fields rather than held by reference, so a caller passing
  // a fresh object literal every render does not remount the query.
  const queryKey = notificationsQueryKey(lens);
  const agentId = lens?.agentId;
  const sessionId = lens?.sessionId;
  const unread = lens?.unread;
  // Joined for the dependency the query key already carries, so a caller
  // passing a fresh array literal every render does not refetch.
  const kinds = lens?.kinds === undefined ? undefined : [...lens.kinds].sort().join(',');

  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) =>
      transport.listNotifications({
        limit: PAGE_SIZE,
        ...(pageParam === undefined ? {} : { before: pageParam }),
        ...(agentId === undefined ? {} : { agentId }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(kinds === undefined || kinds === ''
          ? {}
          : { kind: kinds.split(',') as NotificationKind[] }),
        ...(unread === true ? { unread: true } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  useEventSubscription('notification', (raw) => {
    const parsed = NotificationEventSchema.safeParse(raw);
    if (!parsed.success) return;
    upsertNotification(queryClient, parsed.data.notification);
  });

  useEventSubscription('notification_read', (raw) => {
    const parsed = NotificationReadEventSchema.safeParse(raw);
    if (!parsed.success) return;
    applyNotificationRead(queryClient, parsed.data);
  });

  const pages = query.data?.pages;
  const notifications = useMemo(() => {
    if (pages === undefined || pages.length === 0) return NO_NOTIFICATIONS;
    return pages.flatMap((page) => page.notifications);
  }, [pages]);

  const { fetchNextPage } = query;
  const loadMore = useCallback(() => void fetchNextPage(), [fetchNextPage]);

  return {
    notifications,
    unreadCount: pages?.[0]?.unreadCount ?? 0,
    isLoading: query.isLoading,
    isError: query.isError,
    hasMore: query.hasNextPage,
    loadMore,
    isLoadingMore: query.isFetchingNextPage,
  };
}

/**
 * How many notifications are unread, for a surface that draws only the number.
 *
 * Reads the same unfiltered cache entry the bell's list uses, so asking for the
 * count costs no second request.
 */
export function useUnreadCount(): number {
  return useNotifications().unreadCount;
}
