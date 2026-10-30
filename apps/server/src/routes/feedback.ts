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
 * `GET /api/feedback/mine` — thin proxy for the "Your reports"
 * tracking view (feedback-pipeline Part 4, decision 260803-205035). Resolves
 * this install's own anonymous `instanceId` and forwards to the site's
 * `GET /api/feedback/mine` via {@link listMyFeedback}, so the client never
 * makes a cross-origin request to dorkos.ai itself.
 *
 * @module routes/feedback
 */
import bodyParser from 'body-parser';
import { Hono, type Context } from 'hono';
import {
  FeedbackSubmissionSchema,
  MAX_FEEDBACK_ROOM_ID_LEN,
  type FeedbackSubmission,
} from '@dorkos/shared/telemetry-events';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readJsonBody, underMount, type BodyRule } from '../http/request-body.js';
import {
  sendFeedback,
  resolveFeedbackIdentity,
  listMyFeedback,
} from '../services/core/feedback-reporter.js';
import { getRecentLogExcerpt } from '../lib/log-excerpt.js';
import { getSessionTranscriptExcerpt } from '../lib/transcript-excerpt.js';
import { getRoomTranscriptExcerpt } from '../services/rooms/messages/room-transcript-excerpt.js';
import { resolveDorkHome } from '../lib/dork-home.js';
import { logger, logError } from '../lib/logger.js';
import { SERVER_VERSION } from '../lib/version.js';
import { resolveCaller } from './room-caller.js';

const router = new Hono<ApiEnv>();

/**
 * The JSON body rule for this group alone, with a ceiling above the app-wide
 * 1 MB limit (`http/request-body.ts`).
 *
 * A feedback submission may carry an opt-in screenshot inline as a `data:` URL
 * (`MAX_FEEDBACK_SCREENSHOT_DATA_URL_LEN`, 850,000 chars) on top of the
 * message, diagnostics and transcript excerpt. Those caps count CHARACTERS
 * while every body limit counts BYTES, and the two only coincide for ASCII: a
 * report written in a multibyte script costs up to 3 bytes per character, so
 * the ~890,000-character worst case is ~890 KB of ASCII but can exceed 1 MB in
 * practice. The screenshot itself is base64 and therefore always 1:1, which is
 * why the prose fields are the ones that move. Hence the headroom here — and,
 * for the site's own byte cap further along, the drop-the-screenshot retry in
 * `feedback-reporter.ts`.
 *
 * It is a rule of the chain's body stage, chosen INSTEAD of the app-wide
 * parser for every path under `/api/feedback`, because the body is parsed
 * before any route runs: a parser on the route itself would come too late, and
 * the app-wide 1 MB limit would refuse the submission first.
 */
export const feedbackBodyRule: BodyRule = {
  matches: (_method, path) => underMount(path, '/api/feedback'),
  parse: bodyParser.json({ limit: '2mb' }),
};

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
 * The reporter's own room author id, for reading a room AS them (DOR-2108).
 * Resolved as a READ, the same way the room view's own reads are: sending a
 * report changes nothing in the room, so it must not need a write session.
 * `undefined` when the caller cannot be resolved at all (an agent token this
 * machine cannot verify) — the report still sends, without the room.
 *
 * @param c - The request context.
 */
function reporterAuthorId(c: Context<ApiEnv>): string | undefined {
  try {
    return resolveCaller(honoRequestFacts(c), 'read').id;
  } catch {
    return undefined;
  }
}

/**
 * Gather a room's excerpt as the reporter, or `undefined` when there is none
 * they may read.
 *
 * @param c - The request context.
 * @param roomId - The room the report was written in.
 */
async function roomExcerptFor(c: Context<ApiEnv>, roomId: string): Promise<string | undefined> {
  const viewer = reporterAuthorId(c);
  return viewer ? getRoomTranscriptExcerpt(roomId, viewer) : undefined;
}

/**
 * Fold a bounded, scrubbed transcript excerpt into a validated submission, when
 * the submitter turned the conversation chip on (`includeTranscript`). Gathered
 * SERVER-SIDE (never a client-supplied excerpt), so the scrubbing and bounding
 * are enforced here, not trusted from the browser. A report written in a room
 * carries `roomId` and gets that one room's latest messages, read as the
 * reporter (DOR-2108); otherwise a `sessionId` gets that chat's transcript.
 * Only ever called after validation, so a malformed submission never triggers
 * a read; nothing readable leaves the submission unchanged (best-effort, like
 * the log excerpt).
 *
 * @param c - The request context, for reading a room as the reporter.
 * @param submission - The Zod-validated submission.
 */
async function withTranscriptExcerpt(
  c: Context<ApiEnv>,
  submission: FeedbackSubmission
): Promise<FeedbackSubmission> {
  if (!submission.includeTranscript) return submission;

  let transcriptExcerpt: string | undefined;
  if (submission.roomId) {
    transcriptExcerpt = await roomExcerptFor(c, submission.roomId);
  } else if (submission.sessionId) {
    transcriptExcerpt = await getSessionTranscriptExcerpt(submission.sessionId);
  }
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
 * **`diagnostics.shellLogExcerpt` is the one deliberate exception**, and it
 * survives on purpose (DOR-2045). It is the desktop shell's own `main.log`,
 * which lives in the Electron main process: this server runs as a child of that
 * process and cannot see that file at all, so the shell is the only thing able
 * to gather it and the client is the only route it can travel. The alternative
 * — handing the shell's log path to the child through the environment so
 * `log-excerpt.ts` could read it here — was rejected as a new coupling between
 * the shell and the server for one diagnostic, against a path that exists
 * precisely because the shell is the authority on where its own log is. The
 * trade is that a page can put up to `MAX_LOG_EXCERPT_LEN` characters of its own
 * choosing into a report a person deliberately sent; the schema bound is the
 * mitigation, and the same person is already authoring the free-text message
 * beside it.
 *
 * @param submission - The Zod-validated (but still client-authored) submission.
 */
function stripServerAuthoredFields(submission: FeedbackSubmission): FeedbackSubmission {
  const { transcriptExcerpt: _clientTranscript, diagnostics, ...rest } = submission;
  if (!diagnostics) return rest;
  // `shellLogExcerpt`, if present, rides along in `safeDiagnostics` — see above.
  const { serverLogExcerpt: _clientServerLog, ...safeDiagnostics } = diagnostics;
  return { ...rest, diagnostics: safeDiagnostics };
}

/** POST /api/feedback — validate the submission and forward it to the ingest. */
router.post('/', async (c) => {
  const parsed = FeedbackSubmissionSchema.safeParse(readJsonBody(c));
  if (!parsed.success) {
    return c.json({ error: 'Invalid feedback', code: 'INVALID_FEEDBACK' }, 400);
  }

  // Identity is resolved from the verified session ONLY — `c.var.user` is
  // set by the session gate (never by anything in the request body), so a client
  // cannot spoof `reporterEmail`/`reporterName` even indirectly. `undefined`
  // when auth is off or no session exists (unchanged pseudonymous behavior), and
  // also when the dialog's "Send anonymously" flag is set — the one path that
  // withholds a verified identity on purpose (design-decisions §3): the lookup
  // is skipped entirely, so no reporter identity is ever attached.
  const requestUser = c.get('user');
  const identity =
    requestUser && !parsed.data.anonymous
      ? await resolveFeedbackIdentity(requestUser.userId)
      : undefined;

  // Strip any client-supplied server-authored fields BEFORE gathering, so only
  // the server can populate `transcriptExcerpt` / `diagnostics.serverLogExcerpt`.
  // `diagnostics.shellLogExcerpt` deliberately passes through: it is the desktop
  // shell's own log, which this process cannot read (DOR-2045 — the reasoning is
  // on `stripServerAuthoredFields`).
  const inbound = stripServerAuthoredFields(parsed.data);
  const submission = await withTranscriptExcerpt(c, await withServerLogExcerpt(inbound));

  const result = await sendFeedback({
    submission,
    dorkHome: resolveDorkHome(),
    dorkosVersion: SERVER_VERSION,
    identity,
  });

  // Always 200 with an honest `ok` — a failed forward is not a client error to
  // retry; the UI reads `ok` to choose between "Sent. Thank you!" and the
  // try-again message that keeps the person's words in the form.
  return c.json(result);
});

/**
 * GET /api/feedback/mine — this install's own submission history, proxied
 * from the site. `502` on any read failure (unreachable site, non-OK
 * response) so the client's error state has something honest to show; never
 * a client-error status, since nothing about the request itself is invalid.
 */
router.get('/mine', async (c) => {
  try {
    const items = await listMyFeedback({ dorkHome: resolveDorkHome() });
    return c.json(items);
  } catch (err) {
    logger.warn('[Feedback] Failed to read feedback history', logError(err));
    return c.json({ error: 'Could not reach the feedback service' }, 502);
  }
});
/**
 * GET /api/feedback/room-transcript?roomId= — the room excerpt a report would
 * attach, for the dialog's preview (DOR-2108). It runs the very function a send
 * runs, so the preview IS what leaves the machine, not an approximation of it.
 * A room the reporter cannot see answers an empty `text`, the same as a room
 * with nothing in it: the preview has nothing to show either way, and this
 * route says nothing about which rooms exist.
 */
router.get('/room-transcript', async (c) => {
  const roomId = c.req.query('roomId');
  if (!roomId || roomId.length > MAX_FEEDBACK_ROOM_ID_LEN) {
    return c.json({ error: 'roomId is required', code: 'INVALID_ROOM_ID' }, 400);
  }
  return c.json({ text: (await roomExcerptFor(c, roomId)) ?? '' });
});

/**
 * Claim every path under `/api/feedback`, served or not, so a request to one
 * no route serves still gets this group's body limit before its `/api` 404,
 * as it always had.
 */
router.all('*', (c) => c.notFound());

export default router;
