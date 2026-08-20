import { Sparkles, X } from 'lucide-react';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';

export interface ShiftReportCardProps {
  /** The unread `report.daily` row this card draws. */
  notification: NotificationDTO;
  /** Dismiss the card — marks the row read. */
  onDismiss: () => void;
}

/**
 * The daily Shift Report: what agents did while you were away, in one quiet
 * card above Recent Activity (spec `notification-system`,
 * design-decisions.md §7.2 "The Shift Report"; task 5.2, DOR-1389).
 *
 * **Non-interactive except for its dismiss.** `notificationLink` returns
 * `null` for `report.daily` — there is nowhere to send a click, because this
 * card is not about one thing that happened, it is the sum of everything
 * else on the page. Dismissing it is the only affordance, and it reads the
 * row: once seen, it does not come back until tomorrow's counts exist to
 * replace it.
 *
 * Title and body both came already written by the server
 * (`shift-report.ts`'s `buildShiftReportText`) — the headline picks the two
 * most useful facts, the body lists every non-zero one. Drawn plainly here
 * rather than re-derived from structured counts: `NotificationDTO` carries
 * only a title and a body for every kind, and building a second renderer
 * that reached past that contract for one kind would be the report
 * disagreeing with the same row the Inbox shows.
 *
 * @param props - The unread {@link ShiftReportCardProps.notification} and its dismiss handler.
 */
export function ShiftReportCard({ notification, onDismiss }: ShiftReportCardProps) {
  return (
    <div
      data-slot="shift-report-card"
      className="border-border/60 bg-background/60 relative rounded-lg border p-3 pr-8"
    >
      <div className="flex items-start gap-2.5">
        <Sparkles aria-hidden className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-xs font-medium">{notification.title}</p>
          {notification.body !== undefined && (
            <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
              {notification.body}
            </p>
          )}
        </div>
      </div>
      {/* Always visible, not hover-only: this is the card's only way out, and a
          control a touch screen cannot see is one it cannot use. */}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="text-muted-foreground hover:text-foreground focus-ring absolute top-2 right-2 rounded-md p-1 transition-colors"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
