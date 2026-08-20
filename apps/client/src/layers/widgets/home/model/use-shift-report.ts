/**
 * The unread daily Shift Report, if any — the {@link ShiftReportCard}'s own
 * lens on the Inbox (spec `notification-system`, task 5.2, DOR-1389).
 *
 * Mirrors the kinds-lens pattern `useActivityNotifications` established
 * (`features/dashboard-attention/model/use-activity-notifications.ts`): its
 * own paged query on its own lens, sharing nothing with the bell's cache.
 * `unread: true` is what lets dismissing the card be the whole story —
 * marking the row read moves it out of this query without this hook tracking
 * dismissal itself.
 *
 * @module widgets/home/model/use-shift-report
 */
import { useMemo } from 'react';
import type { NotificationDTO, NotificationKind } from '@dorkos/shared/notification-schemas';
import { useNotifications } from '@/layers/entities/notifications';

/** The one kind this lens ever asks for. */
const SHIFT_REPORT_KINDS: readonly NotificationKind[] = ['report.daily'];

/**
 * The unread Shift Report, or `undefined` when there is none to show.
 *
 * At most one is ever unread in practice — the composer fires once per local
 * day (`emitters/shift-report.ts`), and seeing this card is what reads it —
 * but the newest wins if a gap ever let two pile up.
 */
export function useShiftReport(): NotificationDTO | undefined {
  const { notifications } = useNotifications({ kinds: SHIFT_REPORT_KINDS, unread: true });
  return useMemo(() => notifications[0], [notifications]);
}
