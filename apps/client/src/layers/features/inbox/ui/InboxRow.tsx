/**
 * One line of the Inbox: what happened, when, and whether you have seen it.
 *
 * @module features/inbox/ui/InboxRow
 */
import { motion } from 'motion/react';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { cn, formatRelativeTime } from '@/layers/shared/lib';
import { NOTIFICATION_ICONS, notificationTone, isFailedRun } from '@/layers/entities/notifications';

/** The entrance each row inherits from its list's stagger container. */
const staggerItem = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
} as const;

export interface InboxRowProps {
  /** The notification this row draws. */
  notification: NotificationDTO;
  /**
   * What clicking the row does — mark it read, and go wherever it points.
   *
   * Absent only where the row is a picture of one: a playground showcase, or a
   * digest that lists what happened without offering to act on it. The row then
   * draws as text rather than as a button that does nothing.
   */
  onOpen?: () => void;
}

/**
 * One notification, drawn.
 *
 * **Unread is a dot, not a colour.** The row's tone already carries how loud the
 * event was, and painting unread rows a second colour would leave two scales
 * fighting for the same line. The dot goes where a dot can be scanned down a
 * column, and a read row simply loses it — nothing greys out, because a
 * notification you have already seen is still true.
 *
 * Presentational: it holds no query and marks nothing read. Whoever renders it
 * decides what clicking means, which is what lets home's activity group and the
 * bell's list share one row.
 *
 * @param props - The {@link InboxRowProps.notification} and what opening it does.
 */
export function InboxRow({ notification, onOpen }: InboxRowProps) {
  const Icon = NOTIFICATION_ICONS[notification.kind];
  const tone = isFailedRun(notification) ? 'error' : notificationTone(notification);
  const unread = notification.readAt === undefined;

  const body = (
    <>
      {/* The unread mark keeps its column whether or not it is drawn, so a list
          where some rows are read does not zig-zag down the left edge. */}
      <span
        aria-hidden
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          unread ? 'bg-status-info' : 'bg-transparent'
        )}
      />
      <Icon
        aria-hidden
        className={cn(
          'size-3.5 shrink-0',
          tone === 'error'
            ? 'text-status-error/70'
            : tone === 'warning'
              ? 'text-status-warning/70'
              : 'text-muted-foreground'
        )}
      />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate text-xs',
            unread ? 'text-foreground font-medium' : 'text-foreground/90'
          )}
        >
          {notification.title}
        </span>
        {notification.body !== undefined && (
          <span className="text-muted-foreground block truncate text-xs">{notification.body}</span>
        )}
      </span>
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
        {formatRelativeTime(notification.createdAt)}
      </span>
    </>
  );

  return (
    <motion.div variants={staggerItem} className="min-w-0">
      {onOpen ? (
        <button
          type="button"
          data-slot="inbox-row"
          data-unread={unread ? 'true' : 'false'}
          onClick={onOpen}
          className="hover:bg-accent/50 focus-visible:ring-ring/60 flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1 text-left transition-colors outline-none focus-visible:ring-2"
        >
          {body}
        </button>
      ) : (
        <div
          data-slot="inbox-row"
          data-unread={unread ? 'true' : 'false'}
          className="flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1"
        >
          {body}
        </div>
      )}
    </motion.div>
  );
}
