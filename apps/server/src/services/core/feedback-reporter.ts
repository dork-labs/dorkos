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
  type FeedbackEventContext,
  type FeedbackListItem,
  type FeedbackSubmission,
} from '@dorkos/shared/telemetry-events';

import { env } from '../../env.js';
import { getOrCreateInstanceId } from '../../lib/instance-id.js';
import { logger, logError } from '../../lib/logger.js';
import { getUserById } from './auth/index.js';

/** Where feedback events are delivered (the one owned ingest). */
export const FEEDBACK_ENDPOINT = 'https://dorkos.ai/api/telemetry/events';

/** How long to wait on the ingest before giving up (ms). */
const FEEDBACK_TIMEOUT_MS = 10_000;

/** How long to wait on the site's tracking-list read before giving up (ms). */
const FEEDBACK_MINE_TIMEOUT_MS = 10_000;

/** The server-resolved identity of an authenticated feedback submitter. */
export type FeedbackIdentity = NonNullable<FeedbackEventContext['identity']>;

/**
 * Resolve the identity of an authenticated feedback submitter, SERVER-SIDE,
 * from their already-verified session `userId` — never from anything a client
 * sends (ADR 260803-205037). One extra lookup against the `user` table via
 * {@link getUserById}, which the feedback route calls with `res.locals.user.userId`
 * (set by `sessionGate`, only when `auth.enabled`).
 *
 * @param userId - The Better Auth user id `sessionGate` already verified.
 * @returns The resolved `{ userId, email, name }`, or `undefined` when the id
 *   does not resolve to a user (should not happen for a verified session, but
 *   never throws — a feedback submission must still be deliverable).
 */
export async function resolveFeedbackIdentity(
  userId: string
): Promise<FeedbackIdentity | undefined> {
  const row = getUserById(userId);
  if (!row) return undefined;
  return { userId: row.id, email: row.email, name: row.name };
}

/** Inputs for {@link sendFeedback}. */
export interface SendFeedbackOptions {
  /** The user-typed submission (`kind`, `message`, optional `contact`/`route`, plus diagnostics). */
  submission: FeedbackSubmission;
  /** Resolved dorkHome path (for the anonymous instance id). */
  dorkHome: string;
  /** Current DorkOS version, attached as a context property. */
  dorkosVersion: string;
  /**
   * The requester's identity, resolved server-side by {@link resolveFeedbackIdentity}
   * — `undefined` when auth is off or no session exists. Forwarded into the
   * built event's `reporterEmail`/`reporterName` properties.
   */
  identity?: FeedbackIdentity;
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
  const { submission, dorkHome, dorkosVersion, identity } = options;
  const endpoint = options.endpoint ?? FEEDBACK_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const distinctId = await getOrCreateInstanceId(dorkHome);
    const event = buildFeedbackEvent(submission, {
      surface: 'cockpit',
      distinctId,
      timestamp: new Date().toISOString(),
      dorkosVersion,
      identity,
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

/** Inputs for {@link listMyFeedback}. */
export interface ListMyFeedbackOptions {
  /** Resolved dorkHome path (for the anonymous instance id). */
  dorkHome: string;
  /** Override the site base URL (tests). Defaults to `env.DORKOS_CLOUD_URL`. */
  cloudUrl?: string;
  /** Override `fetch` (tests). Defaults to the global. */
  fetchImpl?: typeof fetch;
}

/**
 * List this install's own feedback submissions for the "Feedback & requests"
 * tracking view (feedback-pipeline Part 4, decision 260803-205035).
 *
 * A thin, read-only forward to the site's `GET /api/feedback/mine`,
 * scoped by this install's own anonymous `instanceId` (the same id
 * {@link sendFeedback} uses as `distinctId`) — the route this calls never
 * sees a request straight from a browser, matching every other site-backed
 * read in this pipeline. **Throws** on a network failure or non-OK response
 * (unlike {@link sendFeedback}'s `{ ok }` posture): this is a read the
 * tracking view's own loading/error UI is built to handle, not a
 * fire-and-forget send whose failure the UI must degrade around silently.
 *
 * @param options - dorkHome plus injectable base URL/fetch (tests).
 * @returns The install's own submissions, newest first (per the site route).
 */
export async function listMyFeedback(options: ListMyFeedbackOptions): Promise<FeedbackListItem[]> {
  const cloudUrl = (options.cloudUrl ?? env.DORKOS_CLOUD_URL).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;

  const instanceId = await getOrCreateInstanceId(options.dorkHome);
  const url = `${cloudUrl}/api/feedback/mine?instanceId=${encodeURIComponent(instanceId)}`;

  const res = await fetchImpl(url, { signal: AbortSignal.timeout(FEEDBACK_MINE_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`Feedback tracking read failed: HTTP ${res.status}`);
  }
  return (await res.json()) as FeedbackListItem[];
}
