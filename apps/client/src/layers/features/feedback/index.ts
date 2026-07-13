/**
 * Feedback feature — the cockpit "Send feedback" dialog (DOR-317, ADR
 * 260713-143958 Phase 5).
 *
 * A small dialog that sends a message the user deliberately writes (feedback, a
 * bug, or an idea) to the DorkOS team via the owned ingest. It is not telemetry:
 * nothing is sent until the user presses Send, and it bypasses the telemetry
 * consent channel entirely (pressing Send is the consent). The prefilled-GitHub
 * path stays available alongside it in the help menu for developers.
 *
 * @module features/feedback
 */
export { FeedbackDialog } from './ui/FeedbackDialog';
export {
  useSendFeedback,
  type FeedbackDraft,
  type UseSendFeedback,
} from './model/use-send-feedback';
