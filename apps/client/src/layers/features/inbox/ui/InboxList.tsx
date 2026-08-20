/**
 * The Inbox list — the one component every lens draws.
 *
 * The bell's Activity section, an agent's Notifications page and (later) a
 * session's are the same list over a different lens, so they are the same
 * component over a different lens. Anything a surface wants to add — a
 * "Mark all read" header, a title — it puts around this, not inside it.
 *
 * @module features/inbox/ui/InboxList
 */
import { motion } from 'motion/react';
import { Button } from '@/layers/shared/ui';
import { useNotifications, type NotificationLens } from '@/layers/entities/notifications';
import { useOpenNotification } from '../model/use-open-notification';
import { InboxRow } from './InboxRow';

/** The stagger the rows inherit — each row declares the child half. */
const staggerContainer = {
  animate: { transition: { staggerChildren: 0.03 } },
} as const;

export interface InboxListProps {
  /** Which slice of the Inbox to draw. Omit for all of it. */
  lens?: NotificationLens;
  /** What to say when there is nothing. */
  emptyLabel?: string;
  /**
   * Called after a row has been opened, so a host can get out of the way.
   *
   * The popover uses it to close itself; a page passes nothing.
   */
  onOpened?: () => void;
}

/**
 * Everything that has happened, newest first.
 *
 * **Clicking a row does two things, in this order.** It marks the row read — the
 * click IS the reading, and waiting for the destination to load before dimming
 * it would leave a bold row behind on the way out — and then it navigates. A row
 * with nowhere to go still marks itself read; it just does not move.
 *
 * Paging is a button rather than a scroll sentinel: the list lives inside a
 * popover barely taller than a phone, and an infinite scroller in a 30rem panel
 * fetches the whole history for anybody who flicks it.
 *
 * @param props - The {@link InboxListProps.lens} and what happens after a row opens.
 */
export function InboxList({ lens, emptyLabel = 'Nothing yet', onOpened }: InboxListProps) {
  const { notifications, isLoading, isError, hasMore, loadMore, isLoadingMore } =
    useNotifications(lens);
  const openNotification = useOpenNotification();

  if (isLoading) {
    return <p className="text-muted-foreground px-2 py-1 text-xs">Loading…</p>;
  }

  if (isError && notifications.length === 0) {
    return (
      <p className="text-muted-foreground px-2 py-1 text-xs">
        DorkOS could not read your notifications.
      </p>
    );
  }

  if (notifications.length === 0) {
    return <p className="text-muted-foreground px-2 py-1 text-xs">{emptyLabel}</p>;
  }

  return (
    <div className="min-w-0">
      <motion.div variants={staggerContainer} initial="initial" animate="animate">
        {notifications.map((notification) => (
          <InboxRow
            key={notification.id}
            notification={notification}
            onOpen={() => {
              openNotification(notification);
              onOpened?.();
            }}
          />
        ))}
      </motion.div>

      {hasMore && (
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground mt-1 h-7 w-full text-xs"
          onClick={loadMore}
          disabled={isLoadingMore}
        >
          {isLoadingMore ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  );
}
