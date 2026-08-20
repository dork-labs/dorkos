/**
 * Moving read state — optimistically here, authoritatively on the server.
 *
 * Read state is shared, not per-window: the server answers the new count and
 * broadcasts `notification_read`, so a badge cleared on the laptop clears on the
 * phone. The optimism is only about latency — clicking a row must dim it in the
 * same frame, because a row that stays bold for a round trip reads as a click
 * that missed.
 *
 * @module entities/notifications/model/use-mark-read
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MarkNotificationsReadResponse } from '@dorkos/shared/notification-schemas';
import { useTransport } from '@/layers/shared/model';
import {
  applyNotificationRead,
  restoreNotifications,
  snapshotNotifications,
  NOTIFICATIONS_QUERY_KEY,
  type NotificationPages,
} from './notification-cache';

/** What the caller of a read mutation gets back. */
export interface MarkReadMutation {
  /** Mark it read. */
  mutate: (id: string) => void;
  /** True while the write is in flight. */
  isPending: boolean;
}

/** What the caller of the mark-all mutation gets back. */
export interface MarkAllReadMutation {
  /** Mark every unread notification read. */
  mutate: () => void;
  /** True while the write is in flight. */
  isPending: boolean;
}

/** How many rows in the cache are still unread — the count an optimistic mark predicts. */
function unreadInCache(snapshot: [readonly unknown[], NotificationPages | undefined][]): number {
  const pages = snapshot.find(([, data]) => data !== undefined)?.[1];
  return pages?.pages[0]?.unreadCount ?? 0;
}

/**
 * Mark one notification read.
 *
 * The optimistic count is the held count minus one, floored at zero, because the
 * held count is what the bell is drawing right now and the server's real answer
 * lands a moment later over the same code path (`notification_read`) that a
 * second window would have taken. A failed write puts every lens back exactly as
 * it was — the alternative, a row silently un-dimming later, is worse than one
 * that never dimmed.
 */
export function useMarkRead(): MarkReadMutation {
  const transport = useTransport();
  const queryClient = useQueryClient();

  const mutation = useMutation<
    MarkNotificationsReadResponse,
    Error,
    string,
    [readonly unknown[], NotificationPages | undefined][]
  >({
    mutationFn: (id) => transport.markNotificationRead(id),
    onMutate: async (id) => {
      // Before the snapshot, always. An in-flight refetch that lands after this
      // writes the server's pre-mark page straight over the optimistic one, and
      // a snapshot taken while one is in the air is a snapshot of a page that no
      // longer exists — so a rollback would restore the wrong thing.
      await queryClient.cancelQueries({ queryKey: NOTIFICATIONS_QUERY_KEY });
      const snapshot = snapshotNotifications(queryClient);
      applyNotificationRead(queryClient, {
        ids: [id],
        all: false,
        readAt: new Date().toISOString(),
        unreadCount: Math.max(0, unreadInCache(snapshot) - 1),
      });
      return snapshot;
    },
    onError: (_error, _id, snapshot) => {
      if (snapshot) restoreNotifications(queryClient, snapshot);
    },
    onSuccess: (result, id) => {
      applyNotificationRead(queryClient, {
        ids: [id],
        all: false,
        readAt: new Date().toISOString(),
        unreadCount: result.unreadCount,
      });
    },
    // Clicking a row is not an action a person needs told about, and the one
    // global failure toast would fire on a mark that failed while they were
    // already reading the thing it was about.
    meta: { suppressErrorToast: true },
  });

  return { mutate: mutation.mutate, isPending: mutation.isPending };
}

/** Mark everything read, with the same optimism and the same rollback. */
export function useMarkAllRead(): MarkAllReadMutation {
  const transport = useTransport();
  const queryClient = useQueryClient();

  const mutation = useMutation<
    MarkNotificationsReadResponse,
    Error,
    void,
    [readonly unknown[], NotificationPages | undefined][]
  >({
    mutationFn: () => transport.markAllNotificationsRead(),
    onMutate: async () => {
      // See `useMarkRead` above: cancel first, or an in-flight refetch clobbers
      // the optimistic write and the snapshot rolls back to a stale page.
      await queryClient.cancelQueries({ queryKey: NOTIFICATIONS_QUERY_KEY });
      const snapshot = snapshotNotifications(queryClient);
      applyNotificationRead(queryClient, {
        ids: [],
        all: true,
        readAt: new Date().toISOString(),
        unreadCount: 0,
      });
      return snapshot;
    },
    onError: (_error, _vars, snapshot) => {
      if (snapshot) restoreNotifications(queryClient, snapshot);
    },
    meta: { errorLabel: "Couldn't mark everything read" },
  });

  return { mutate: () => mutation.mutate(), isPending: mutation.isPending };
}
