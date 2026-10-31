/**
 * The feedback slice of the `Transport` interface (DOR-317, ADR 260713-143958
 * Phase 5; the room preview per DOR-2108), joined in `transport-slices.ts`.
 *
 * @module shared/transport-feedback
 */
import type {
  FeedbackListItem,
  FeedbackSubmission,
  RoomTranscriptPreview,
} from './telemetry-events.js';

/** What the app asks the server about feedback the person writes. */
export interface FeedbackTransport {
  /**
   * Send a piece of feedback the user deliberately wrote and submitted — general
   * feedback, a bug report, or a feature idea. Unlike usage telemetry, this is a
   * message the person chose to send, so it bypasses the telemetry consent
   * channel and env kill switches entirely (see `@dorkos/shared/telemetry-events`
   * for the reasoning). It still rides the one owned ingest.
   *
   * `HttpTransport` POSTs `/feedback` (the server fills surface/version/id and
   * forwards to the ingest). The result is
   * an honest `{ ok }` so the UI can toast truthfully — a network failure resolves
   * `{ ok: false }` rather than throwing, since best-effort delivery is not an
   * error the user must handle.
   *
   * @param submission - The user-typed `{ kind, message, contact?, route? }`.
   */
  sendFeedback(submission: FeedbackSubmission): Promise<{ ok: boolean }>;

  /**
   * List this install's own feedback submissions for the "Product
   * feedback" tracking view (feedback-pipeline Part 4, decision
   * 260803-205035) — kept newest first, scoped to this install's own
   * pseudonymous `instanceId` so no login is required.
   *
   * `HttpTransport` calls the local server's `GET /api/feedback/mine` proxy,
   * which forwards to the site (never a cross-origin request from the client).
   *
   * Unlike {@link sendFeedback}'s honest `{ ok }` posture, this **rejects**
   * on failure — it is a read the tracking view's own loading/error UI
   * handles directly, not a fire-and-forget send.
   */
  listMyFeedback(): Promise<FeedbackListItem[]>;

  /**
   * The room excerpt a feedback report written in `roomId` would attach
   * (DOR-2108), for the dialog's preview, with the `seq` of its newest message.
   * Built by the same server function a send runs, so it is exactly what would
   * leave the machine. Resolves `{ text: '', throughSeq: null }` for an empty
   * room or one the reporter cannot see; rejects on a network failure.
   */
  previewRoomTranscript(roomId: string): Promise<RoomTranscriptPreview>;
}
