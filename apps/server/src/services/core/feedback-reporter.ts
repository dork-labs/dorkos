/**
 * Feedback forwarder (DOR-317, ADR 260713-143958 Phase 5).
 *
 * Sends a single user-volunteered feedback message to the owned ingest at
 * https://dorkos.ai/api/telemetry/events. Deliberately NOT the usage-reporter:
 *
 *   - **No consent gating.** Feedback is a message the user typed and pressed
 *     Send on, so it does not ride the `telemetry.usage` channel, the Tier 1
 *     notice gate, or the `DO_NOT_TRACK` / `DORKOS_TELEMETRY_DISABLED` env kill
 *     switches. Those govern *tracking*; a person asking us to receive their bug
 *     report is not tracking. This module reads none of them.
 *   - **Immediate, single-event send.** No buffer, no flush timer — one message,
 *     one POST, right now.
 *   - **Honest result.** Network errors are swallowed (they never destabilize
 *     the server) but the outcome is RETURNED as `{ ok }` so the calling UI can
 *     toast truthfully ("Thanks, sent." vs "Couldn't send — try the GitHub
 *     option."). This is the opposite of the fire-and-forget usage path.
 *
 * The anonymous per-install `instanceId` is the `distinctId` (same id every
 * dorkos.ai channel shares), and the current DorkOS version rides in the event
 * properties as context.
 *
 * @module services/core/feedback-reporter
 */

import {
  buildFeedbackEvent,
  FeedbackEventSchema,
  type FeedbackSubmission,
} from '@dorkos/shared/telemetry-events';

import { getOrCreateInstanceId } from '../../lib/instance-id.js';
import { logger, logError } from '../../lib/logger.js';

/** Where feedback events are delivered (the one owned ingest). */
export const FEEDBACK_ENDPOINT = 'https://dorkos.ai/api/telemetry/events';

/** How long to wait on the ingest before giving up (ms). */
const FEEDBACK_TIMEOUT_MS = 10_000;

/** Inputs for {@link sendFeedback}. */
export interface SendFeedbackOptions {
  /** The user-typed submission (`kind`, `message`, optional `contact`/`route`). */
  submission: FeedbackSubmission;
  /** Resolved dorkHome path (for the anonymous instance id). */
  dorkHome: string;
  /** Current DorkOS version, attached as a context property. */
  dorkosVersion: string;
  /** Override the ingest endpoint (tests). Defaults to {@link FEEDBACK_ENDPOINT}. */
  endpoint?: string;
  /** Override `fetch` (tests). Defaults to the global. */
  fetchImpl?: typeof fetch;
}

/**
 * Forward one feedback submission to the owned ingest and report whether it
 * landed. NEVER throws: a network failure or non-OK response resolves to
 * `{ ok: false }` so the caller can surface an honest, actionable message.
 *
 * @param options - The submission plus identity/version/delivery inputs.
 * @returns `{ ok: true }` when the ingest accepted the POST, else `{ ok: false }`.
 */
export async function sendFeedback(options: SendFeedbackOptions): Promise<{ ok: boolean }> {
  const { submission, dorkHome, dorkosVersion } = options;
  const endpoint = options.endpoint ?? FEEDBACK_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const distinctId = await getOrCreateInstanceId(dorkHome);
    const event = buildFeedbackEvent(submission, {
      surface: 'cockpit',
      distinctId,
      timestamp: new Date().toISOString(),
      dorkosVersion,
    });

    // Validate our own envelope before sending — a malformed event should fail
    // here (returning ok:false) rather than being silently dropped by the ingest.
    const parsed = FeedbackEventSchema.safeParse(event);
    if (!parsed.success) {
      logger.warn('[Feedback] Built an invalid feedback event; not sending');
      return { ok: false };
    }

    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [parsed.data] }),
      signal: AbortSignal.timeout(FEEDBACK_TIMEOUT_MS),
    });

    return { ok: res.ok };
  } catch (err) {
    // Swallow so feedback delivery never destabilizes the server — but report
    // the failure honestly to the caller so the UI can offer the GitHub fallback.
    logger.warn('[Feedback] Failed to forward feedback', logError(err));
    return { ok: false };
  }
}
