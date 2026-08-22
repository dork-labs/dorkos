/**
 * The schedule approval — an agent's proposal, and an informed answer to it.
 *
 * **Its own slice, not a row in `dashboard-attention`.** What lives here is a
 * decision surface with machinery of its own: two mutations, a supervised test
 * run, and an undo window that outlives the component drawing it. Its neighbour
 * slice is `features/approvals` (a capability hold) and `features/ask` (a prompt
 * an agent is parked on) — three different objects, one card family, one thing
 * to whoever is being asked. `dashboard-attention` is the drawing of attention
 * ROWS and their detail sheets; a card with a deferred-delete scheduler in it
 * was never that, and leaving it there made the Inbox depend on the home
 * surface's row slice for something that is not a row.
 *
 * @module features/schedule-approval
 */
export { ScheduleApprovalCard } from './ui/ScheduleApprovalCard';
export type { ScheduleApprovalCardProps } from './ui/ScheduleApprovalCard';
export {
  REJECTION_UNDO_MS,
  cancelRejection,
  discardPendingRejections,
  flushRejections,
  isRejectionPending,
  rejectAfterUndoWindow,
  useRejectionPending,
} from './model/deferred-rejection';
// Every surface that lists proposals composes this, so a decided card holds its
// receipt for the same beat on all three — see the module for the disappearance
// it closes.
export {
  APPROVAL_SETTLE_MS,
  discardSettlingSchedules,
  useScheduleApprovalCards,
} from './model/settling-approvals';
export { useScheduleTestRun } from './model/use-schedule-test-run';
export type { ScheduleTestRunPhase, ScheduleTestRunState } from './model/use-schedule-test-run';
export { formatCadence, formatFirstRuns, formatRunMoment } from './lib/format-schedule-times';
export type { FirstRuns } from './lib/format-schedule-times';
