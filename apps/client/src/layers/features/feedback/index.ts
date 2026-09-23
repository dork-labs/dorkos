/**
 * Feedback feature — the app's "Send feedback" dialog (DOR-317, ADR
 * 260713-143958 Phase 5).
 *
 * A small composer-style dialog that sends a message the user deliberately
 * writes (feedback, a bug, or an idea) to the DorkOS team via the owned ingest,
 * optionally with one screenshot the user pasted, dropped, picked, captured in
 * one click, or pointed at one element to get, and that element's name as its
 * own field (DOR-2232). It is not telemetry: nothing is sent until the user
 * presses Send, and it bypasses the telemetry consent channel entirely (pressing
 * Send is the consent). The prefilled-GitHub path is one link in its footer.
 *
 * @module features/feedback
 */
export { FeedbackDialog } from './ui/FeedbackDialog';
export {
  useSendFeedback,
  type FeedbackDraft,
  type UseSendFeedback,
} from './model/use-send-feedback';
