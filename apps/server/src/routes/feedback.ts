/**
 * Feedback route (DOR-317, ADR 260713-143958 Phase 5; identity + diagnostics
 * plumbing per feedback-pipeline spec Parts 1-2, ADR 260803-205037).
 *
 * `POST /api/feedback` — receive a message the user deliberately wrote (general
 * feedback, a bug, or a feature idea) and forward it to the owned ingest via the
 * {@link sendFeedback} forwarder. Validate the submission with Zod, resolve the
 * requester's identity SERVER-SIDE from their verified session (never from the
 * request body), optionally gather a scrubbed server-log excerpt for a bug
 * report that asked for one, and relay the forwarder's honest `{ ok }` so the
 * cockpit can toast truthfully.
 *
 * Deliberately independent of the telemetry consent channel and env kill
 * switches — pressing Send IS the consent (see the feedback-reporter and
 * `@dorkos/shared/telemetry-events` for the reasoning).
 *
 * `GET /api/feedback/mine` — thin proxy for the "Product feedback"
 * tracking view (feedback-pipeline Part 4, decision 260803-205035). Resolves
 * this install's own anonymous `instanceId` and forwards to the site's
 * `GET /api/feedback/mine` via {@link listMyFeedback}, so the client never
 * makes a cross-origin request to dorkos.ai itself.
 *
 * @module routes/feedback
 */
import { Router } from 'express';
import { FeedbackSubmissionSchema, type FeedbackSubmission } from '@dorkos/shared/telemetry-events';
import {
  sendFeedback,
  resolveFeedbackIdentity,
  listMyFeedback,
} from '../services/core/feedback-reporter.js';
import { getRecentLogExcerpt } from '../lib/log-excerpt.js';
import { getSessionTranscriptExcerpt } from '../lib/transcript-excerpt.js';
import { resolveDorkHome } from '../lib/dork-home.js';
import { logger, logError } from '../lib/logger.js';
import { SERVER_VERSION } from '../lib/version.js';
import type { RequestUser } from '../services/core/auth/index.js';

const router = Router();

/**
 * Fold a scrubbed server-log excerpt into a validated bug submission, when the
 * submitter asked for one. Only ever called after the rest of validation has
 * passed, so a malformed submission never triggers a log read. Requires an
 * existing `diagnostics.clientReport` (the client always attaches one for
 * `kind === 'bug'`) — there is nothing meaningful to attach a log excerpt to
 * otherwise, so that case is left as submitted.
 *
 * @param submission - The Zod-validated submission.
 */
async function withServerLogExcerpt(submission: FeedbackSubmission): Promise<FeedbackSubmission> {
  if (submission.kind !== 'bug' || !submission.includeServerLogs || !submission.diagnostics) {
    return submission;
  }

  const serverLogExcerpt = await getRecentLogExcerpt();
  if (!serverLogExcerpt) return submission;

  return {
    ...submission,
    diagnostics: { ...submission.diagnostics, serverLogExcerpt },
  };
}

/**
 * Fold a bounded, scrubbed transcript excerpt into a validated submission, when
 * the submitter turned the "Conversation" toggle on (`includeTranscript` + a
 * `sessionId`). Gathered SERVER-SIDE from the session's own transcript (never a
 * client-supplied excerpt), so the scrubbing and bounding are enforced here, not
 * trusted from the browser. Only ever called after validation, so a malformed
 * submission never triggers a transcript read; a session with nothing readable
 * leaves the submission unchanged (best-effort, like the log excerpt).
 *
 * @param submission - The Zod-validated submission.
 */
async function withTranscriptExcerpt(submission: FeedbackSubmission): Promise<FeedbackSubmission> {
  if (!submission.includeTranscript || !submission.sessionId) return submission;

  const transcriptExcerpt = await getSessionTranscriptExcerpt(submission.sessionId);
  if (!transcriptExcerpt) return submission;

  return { ...submission, transcriptExcerpt };
}

/**
 * Strip the two fields the SERVER is the sole author of — `transcriptExcerpt`
 * and `diagnostics.serverLogExcerpt` — from an inbound submission before the
 * gather steps run. Both carry scrubbed, bounded, server-gathered content, so a
 * client-supplied value is never trusted: `withTranscriptExcerpt` /
 * `withServerLogExcerpt` only OVERWRITE on a hit, so without this a client value
 * would survive a gather miss (or `includeTranscript:false`). Today
 * `buildFeedbackEvent` drops both, but PR D's durable route reads the full
 * submission, so an unscrubbed client value must never reach it — this is the
 * defense-in-depth boundary that keeps that true.
 *
 * @param submission - The Zod-validated (but still client-authored) submission.
 */
function stripServerAuthoredFields(submission: FeedbackSubmission): FeedbackSubmission {
  const { transcriptExcerpt: _clientTranscript, diagnostics, ...rest } = submission;
  if (!diagnostics) return rest;
  const { serverLogExcerpt: _clientServerLog, ...safeDiagnostics } = diagnostics;
  return { ...rest, diagnostics: safeDiagnostics };
}

/** POST /api/feedback — validate the submission and forward it to the ingest. */
router.post('/', async (req, res) => {
  const parsed = FeedbackSubmissionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid feedback', code: 'INVALID_FEEDBACK' });
  }

  // Identity is resolved from the verified session ONLY — `res.locals.user` is
  // set by `sessionGate` (never by anything in the request body), so a client
  // cannot spoof `reporterEmail`/`reporterName` even indirectly. `undefined`
  // when auth is off or no session exists (unchanged pseudonymous behavior), and
  // also when the dialog's "Send anonymously" flag is set — the one path that
  // withholds a verified identity on purpose (design-decisions §3): the lookup
  // is skipped entirely, so no reporter identity is ever attached.
  const requestUser = res.locals.user as RequestUser | undefined;
  const identity =
    requestUser && !parsed.data.anonymous
      ? await resolveFeedbackIdentity(requestUser.userId)
      : undefined;

  // Strip any client-supplied server-authored fields BEFORE gathering, so only
  // the server can populate `transcriptExcerpt` / `diagnostics.serverLogExcerpt`.
  const inbound = stripServerAuthoredFields(parsed.data);
  const submission = await withTranscriptExcerpt(await withServerLogExcerpt(inbound));

  const result = await sendFeedback({
    submission,
    dorkHome: resolveDorkHome(),
    dorkosVersion: SERVER_VERSION,
    identity,
  });

  // Always 200 with an honest `ok` — a failed forward is not a client error to
  // retry; the UI reads `ok` to choose between "Thanks, sent." and the GitHub
  // fallback message.
  return res.json(result);
});

/**
 * GET /api/feedback/mine — this install's own submission history, proxied
 * from the site. `502` on any read failure (unreachable site, non-OK
 * response) so the client's error state has something honest to show; never
 * a client-error status, since nothing about the request itself is invalid.
 */
router.get('/mine', async (_req, res) => {
  try {
    const items = await listMyFeedback({ dorkHome: resolveDorkHome() });
    return res.json(items);
  } catch (err) {
    logger.warn('[Feedback] Failed to read feedback history', logError(err));
    return res.status(502).json({ error: 'Could not reach the feedback service' });
  }
});

export default router;
