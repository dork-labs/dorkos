/**
 * "While you were away · 5": decisions an extension made without the person,
 * folded into one row of Activity (spec `flow-multiproject` §7.9, V10).
 *
 * @module features/inbox/ui/InboxAwayGroupRow
 */
import { useId } from 'react';
import { ChevronDown, ChevronRight, MessageCircleQuestion } from 'lucide-react';
import { motion } from 'motion/react';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { cn, formatCompactAge } from '@/layers/shared/lib';
import type { InboxAwayItem } from '../lib/group-activity-rows';
import { GLYPH_SLOT_CLASS, staggerVariantsFor } from './InboxRow';
import { ExtensionDecisionHistoryRow } from './ExtensionDecisionHistoryRow';

/** Props for {@link InboxAwayGroupRow}. */
export interface InboxAwayGroupRowProps {
  /** The run it folds. */
  group: InboxAwayItem;
  /** Whether the rows are showing (owned by the list, like `InboxGroupRow`). */
  expanded: boolean;
  /** Toggle {@link expanded}. Marks nothing read: opening the group is a look. */
  onToggleExpanded: () => void;
  /** What opening one member does (marks it read). */
  onOpenNotification: (notification: NotificationDTO) => void;
  /** Called after a member's "Watch" opened a chat. */
  onOpened?: () => void;
  /** Drawn inside the bell (see `ExtensionDecisionHistoryRow`). */
  inBell?: boolean;
  /** Where the row sits in its list, so the entrance can stop staggering. */
  index?: number;
}

/**
 * One row that says how many decisions were made while the person was away,
 * and expands to them. These are history, never asks: an agent, a rule of the
 * person's, or a deadline decided each one. The dot is lit while any of them
 * the person asked to be told about ("Tell me after") is still unread.
 *
 * @param props - The run, whether it is open, and what opening a member does.
 */
export function InboxAwayGroupRow({
  group,
  expanded,
  onToggleExpanded,
  onOpenNotification,
  onOpened,
  index,
  inBell = false,
}: InboxAwayGroupRowProps) {
  const membersId = useId();
  const unread = group.notifications.some((notification) => notification.readAt === undefined);
  const newest = group.notifications[0];
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <motion.div variants={staggerVariantsFor(index)} className="min-w-0">
      <button
        type="button"
        data-slot="inbox-row"
        data-inbox-away
        data-expanded={expanded ? 'true' : 'false'}
        data-unread={unread ? 'true' : 'false'}
        aria-expanded={expanded}
        aria-controls={expanded ? membersId : undefined}
        onClick={onToggleExpanded}
        className="hover:bg-accent/50 focus-visible:ring-ring flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1 text-left transition-colors outline-none focus-visible:ring-2"
      >
        <span
          aria-hidden
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            unread ? 'bg-status-info' : 'bg-transparent'
          )}
        />
        {unread && <span className="sr-only">Unread. </span>}
        <span className={GLYPH_SLOT_CLASS}>
          <MessageCircleQuestion aria-hidden className="text-muted-foreground size-3.5" />
        </span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-xs',
            unread ? 'text-foreground font-medium' : 'text-foreground/90'
          )}
        >
          While you were away · {group.notifications.length}
        </span>
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {formatCompactAge(newest.createdAt)}
        </span>
        <Chevron aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
      </button>

      {expanded && (
        <div id={membersId} className="border-border/60 ml-[13px] border-l pl-2">
          {group.notifications.map((notification) => (
            <ExtensionDecisionHistoryRow
              key={notification.id}
              notification={notification}
              onOpen={() => onOpenNotification(notification)}
              onOpened={onOpened}
              inBell={inBell}
            />
          ))}
        </div>
      )}
    </motion.div>
  );
}
