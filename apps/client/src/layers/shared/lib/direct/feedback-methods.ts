/**
 * Direct feedback method factory (DOR-317, ADR 260713-143958 Phase 5).
 *
 * The in-process (Obsidian) twin of `transport/feedback-methods.ts`. There is no
 * local server to POST `/api/feedback` to, so this forwards the built feedback
 * event straight to the owned ingest, reusing the shared `buildFeedbackEvent`
 * mapping so the wire shape is identical to the cockpit path.
 *
 * Like every feedback path, this bypasses telemetry consent entirely (pressing
 * Send is the consent) and returns an honest `{ ok }` — a network failure is
 * `{ ok: false }`, never a thrown error.
 *
 * @module shared/lib/direct/feedback-methods
 */
import {
  buildFeedbackEvent,
  FeedbackEventSchema,
  type FeedbackSubmission,
} from '@dorkos/shared/telemetry-events';

/** The one owned ingest all feedback rides (matches the server forwarder). */
const FEEDBACK_ENDPOINT = 'https://dorkos.ai/api/telemetry/events';

/** How long to wait on the ingest before giving up (ms). */
const FEEDBACK_TIMEOUT_MS = 10_000;

/** Create the in-process feedback methods for the embedded transport. */
export function createDirectFeedbackMethods() {
  return {
    async sendFeedback(submission: FeedbackSubmission): Promise<{ ok: boolean }> {
      try {
        const event = buildFeedbackEvent(submission, {
          surface: 'cockpit',
          // Embedded has no server-side instanceId file; a fresh pseudonymous id
          // per submission is unlinkable and sufficient for a volunteered message.
          distinctId: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
        });
        const parsed = FeedbackEventSchema.safeParse(event);
        if (!parsed.success) return { ok: false };

        const res = await fetch(FEEDBACK_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ events: [parsed.data] }),
          signal: AbortSignal.timeout(FEEDBACK_TIMEOUT_MS),
        });
        return { ok: res.ok };
      } catch {
        return { ok: false };
      }
    },
  };
}
