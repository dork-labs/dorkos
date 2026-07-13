/**
 * Feedback Transport method factory (DOR-317, ADR 260713-143958 Phase 5).
 *
 * POSTs a user-volunteered feedback submission to the local `/api/feedback`
 * route, which fills the identity/version context and forwards it to the owned
 * ingest. The server always answers `{ ok }`; a network failure surfaces as
 * `{ ok: false }` (never a thrown error) so the UI can toast honestly and offer
 * the GitHub fallback.
 *
 * @module shared/lib/transport/feedback-methods
 */
import type { FeedbackSubmission } from '@dorkos/shared/telemetry-events';
import { fetchJSON } from './http-client';

/**
 * Create the feedback methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createFeedbackMethods(baseUrl: string) {
  return {
    async sendFeedback(submission: FeedbackSubmission): Promise<{ ok: boolean }> {
      try {
        return await fetchJSON<{ ok: boolean }>(baseUrl, '/feedback', {
          method: 'POST',
          body: JSON.stringify(submission),
        });
      } catch {
        // Best-effort delivery: a network error is a truthful `ok: false`, not an
        // exception the caller must handle.
        return { ok: false };
      }
    },
  };
}
