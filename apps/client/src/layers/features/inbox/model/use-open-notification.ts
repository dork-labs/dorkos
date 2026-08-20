/**
 * What clicking a notification means, wherever it is drawn.
 *
 * Four surfaces draw Inbox rows — the bell's Activity list, an agent's profile,
 * home's activity group and the Pulse panel's teaser — and clicking one has to
 * mean the same thing in all four, or the same row behaves differently depending
 * on which side of the screen you found it.
 *
 * @module features/inbox/model/use-open-notification
 */
import { useCallback } from 'react';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { useSafeNavigate } from '@/layers/shared/model';
import { notificationLink, useMarkRead } from '@/layers/entities/notifications';

/**
 * Open a notification: mark it read, then go where it points.
 *
 * **In that order, and it matters.** The click IS the reading, so waiting for
 * the destination to load before dimming the row would leave a bold row behind
 * on the way out. A row with nowhere to go — an update record — still marks
 * itself read; it just does not move.
 *
 * @returns A stable callback taking the notification that was clicked.
 */
export function useOpenNotification(): (notification: NotificationDTO) => void {
  const markRead = useMarkRead();
  const navigate = useSafeNavigate();
  const { mutate } = markRead;

  return useCallback(
    (notification: NotificationDTO) => {
      if (notification.readAt === undefined) mutate(notification.id);
      const link = notificationLink(notification);
      // No router in the Obsidian embed, and a row there is still worth marking
      // read even though it cannot travel.
      if (link !== null && navigate !== null) {
        void navigate({ to: link.to, search: link.search });
      }
    },
    [mutate, navigate]
  );
}
