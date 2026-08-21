/**
 * One line of the Inbox: what happened, when, and whether you have seen it.
 *
 * @module features/inbox/ui/InboxRow
 */
import { motion } from 'motion/react';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { cn, formatCompactAge } from '@/layers/shared/lib';
import { NOTIFICATION_ICONS, notificationRowTone } from '@/layers/entities/notifications';
import { AgentAvatar, resolveAgentVisual, type AgentVisualSource } from '@/layers/entities/agent';

/** The entrance each row inherits from its list's stagger container. */
export const staggerItem = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
} as const;

export interface InboxRowProps {
  /** The notification this row draws. */
  notification: NotificationDTO;
  /**
   * The agent behind `notification.agentId`, when the caller holds the roster.
   *
   * Three states, not two. `undefined` — the default — means the caller never
   * looked it up (or the row has no `agentId` at all): draws the kind glyph,
   * same as before this prop existed. `null` means the caller looked and the
   * roster does not know this id — an agent since removed, say — and draws the
   * same glyph rather than guessing. Only a resolved manifest draws a face.
   *
   * The row never fetches this itself — see the class doc's "holds no query".
   */
  agent?: AgentVisualSource | null;
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
 * **A face when there is a "who" and a colour when there is a "how bad".** A row
 * whose `agent` resolved draws that agent's own avatar in the glyph slot —
 * `xs`, the disc the sidebar already uses, so the slot's width never moves
 * between an icon and a face. A row drawn in the error tone keeps the coloured
 * kind glyph regardless: tone answers "did anything break?", which is the
 * question a list gets scanned for, and it must never lose that argument to a
 * second colour painted onto the avatar's own tint. Warning-tone rows (most
 * ordinary activity — a turn finishing, a DM arriving — carries the `notable`
 * tier, not bad news) still get a face; only `error` keeps the glyph.
 *
 * Presentational: it holds no query and marks nothing read. Whoever renders it
 * decides what clicking means and who the agent is, which is what lets home's
 * activity group and the bell's list share one row.
 *
 * @param props - The {@link InboxRowProps.notification}, its resolved
 *   {@link InboxRowProps.agent}, and what opening it does.
 */
export function InboxRow({ notification, agent, onOpen }: InboxRowProps) {
  const Icon = NOTIFICATION_ICONS[notification.kind];
  const tone = notificationRowTone(notification);
  const unread = notification.readAt === undefined;
  const visual = tone !== 'error' && agent != null ? resolveAgentVisual(agent) : null;

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
      {/* The dot is the only thing that says "unread", and a dot is nothing at
          all to a screen reader. Read rows say nothing rather than "Read":
          every row would then start with a word carrying no news. */}
      {unread && <span className="sr-only">Unread. </span>}
      {visual ? (
        <AgentAvatar
          color={visual.color}
          emoji={visual.emoji}
          size="xs"
          // No Bot badge: the square shape already says "agent", and a badge
          // repeating that on every row in a list that is ALREADY agent rows
          // is a column of identical marks saying nothing (the same call
          // `AskCard.Face` makes at this size).
          badge={null}
          className="shrink-0"
        />
      ) : (
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
      )}
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
      {/* The compact form ("5m", "2h", "3d"), not the sentence form ("45m ago").
          Two reasons, and they point the same way: these rows sit beside
          `AttentionSignalRow` in the Pulse panel and in home's header, and two
          spellings of the same fact one line apart reads as two different
          facts; and the popover is 30rem wide with a title, a body line and
          this on one row, where four extra characters cost the title its
          last word. `formatCompactAge` is the shared one both now use. */}
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
        {formatCompactAge(notification.createdAt)}
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
