/**
 * Feedback forwarder (DOR-317, ADR 260713-143958 Phase 5; dual-write to the
 * durable site route per feedback-pipeline spec Part 3, decision
 * 260803-205035).
 *
 * `sendFeedback` DUAL-WRITES a user-volunteered feedback submission:
 *
 *   1. **Durable post (determines the returned `{ ok }`).** POSTs the richer
 *      submission + server-resolved context to the site's
 *      `POST /api/feedback` (`apps/site/src/app/api/feedback/route.ts`) —
 *      Neon storage + best-effort Linear issue, per that route's own module
 *      doc. This is the caller-visible guarantee: the Neon insert is durable
 *      storage, so `ok` reflects THIS response, not the metrics post below.
 *   2. **Metrics post (best-effort, does NOT determine `ok`).** Keeps sending
 *      the existing PostHog-shaped event to `/api/telemetry/events` — that
 *      route is explicitly "no Neon table, PostHog only" by design and stays
 *      the metrics-continuity target it always was.
 *
 * Deliberately NOT the usage-reporter:
 *
 *   - **No consent gating.** Feedback is a message the user typed and pressed
 *     Send on, so it does not ride the `telemetry.usage` channel, the Tier 1
 *     notice gate, or the `DO_NOT_TRACK` / `DORKOS_TELEMETRY_DISABLED` env kill
 *     switches. Those govern *tracking*; a person asking us to receive their bug
 *     report is not tracking. This module reads none of them.
 *   - **Immediate, unbuffered send.** No buffer, no flush timer — one
 *     submission, two POSTs, right now.
 *   - **Honest result.** Network errors are swallowed (they never destabilize
 *     the server) but the outcome is RETURNED as `{ ok }` so the calling UI can
 *     toast truthfully ("Thanks, sent." vs "Couldn't send — try the GitHub
 *     option."). This is the opposite of the fire-and-forget usage path.
 *
 * The anonymous per-install `instanceId` is shared by both posts (the metrics
 * event's `distinctId` and the durable payload's `instanceId`), and the
 * current DorkOS version rides in the metrics event's properties as context.
 *
 * ## Cross-reference (ADR-0235)
 *
 * The durable payload's shape (see {@link DurableFeedbackPayload}) is a
 * BY-HAND mirror of the site route's `FeedbackIntakeSchema` — per ADR-0235
 * the site keeps route-local schemas rather than importing `@dorkos/shared`,
 * so there is no shared Zod schema to import here either. Keep the two in
 * lockstep by hand; a reviewer should treat a drift between the two as a bug.
 *
 * @module services/core/feedback-reporter
 */

import {
  buildFeedbackEvent,
  FeedbackEventSchema,
  type FeedbackDiagnostics,
  type FeedbackEventContext,
  type FeedbackListItem,
  type FeedbackSubmission,
} from '@dorkos/shared/telemetry-events';

import { env } from '../../env.js';
import { getOrCreateInstanceId } from '../../lib/instance-id.js';
import { logger, logError } from '../../lib/logger.js';
import { getUserById } from './auth/index.js';

/** Where the metrics-continuity feedback event is delivered (the one owned PostHog ingest). */
export const FEEDBACK_ENDPOINT = 'https://dorkos.ai/api/telemetry/events';

/** Path of the durable feedback route on the site, appended to `env.DORKOS_CLOUD_URL` / `cloudUrl`. */
const DURABLE_FEEDBACK_PATH = '/api/feedback';

/** How long to wait on either ingest before giving up (ms). */
const FEEDBACK_TIMEOUT_MS = 10_000;

/** How long to wait on the site's tracking-list read before giving up (ms). */
const FEEDBACK_MINE_TIMEOUT_MS = 10_000;

/**
 * Cap on the rendered `diagnostics` text sent to the durable route — matches
 * `MAX_DIAGNOSTICS_LEN` in `apps/site/src/app/api/feedback/route.ts` exactly,
 * so a large bundle degrades to a truncated block instead of a 400.
 */
const DURABLE_DIAGNOSTICS_MAX_LEN = 8000;

/**
 * Cap on `transcriptExcerpt` sent to the durable route — matches
 * `MAX_TRANSCRIPT_LEN` in `apps/site/src/app/api/feedback/route.ts`, which is
 * smaller than `@dorkos/shared`'s own `MAX_TRANSCRIPT_LEN` (20,000), so this
 * truncates rather than mirroring that constant.
 */
const DURABLE_TRANSCRIPT_MAX_LEN = 8000;

/**
 * Caps on the server-resolved reporter identity sent to the durable route,
 * matching that route's `.strict()` schema (`MAX_REPORTER_NAME_LEN` 128 and
 * `.email().max(254)`). These are DB-sourced, Better-Auth-validated values that
 * almost never exceed their caps — but the durable route is strict, so an
 * over-cap value would 400 the whole write and silently lose the feedback. The
 * name truncates safely; an over-cap email is dropped rather than truncated
 * (a sliced address is worse than none) so identity never sinks the write.
 */
const DURABLE_REPORTER_NAME_MAX_LEN = 128;
const DURABLE_REPORTER_EMAIL_MAX_LEN = 254;

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
  /** Current DorkOS version, attached as a context property on the metrics event. */
  dorkosVersion: string;
  /**
   * The requester's identity, resolved server-side by {@link resolveFeedbackIdentity}
   * — `undefined` when auth is off or no session exists. Forwarded into both
   * the durable payload's `reporterEmail`/`reporterName` fields and the
   * metrics event's same-named properties.
   */
  identity?: FeedbackIdentity;
  /** Override the metrics (PostHog) ingest endpoint (tests). Defaults to {@link FEEDBACK_ENDPOINT}. */
  endpoint?: string;
  /** Override the site base URL the durable post targets (tests). Defaults to `env.DORKOS_CLOUD_URL`. */
  cloudUrl?: string;
  /** Override `fetch` for both posts (tests). Defaults to the global. */
  fetchImpl?: typeof fetch;
}

/**
 * Dual-write one feedback submission: a durable post to the site's
 * `POST /api/feedback` (Neon + best-effort Linear), plus a best-effort
 * metrics post of the existing PostHog-shaped event. NEVER throws.
 *
 * @param options - The submission plus identity/version/delivery inputs.
 * @returns `{ ok: true }` when the DURABLE post's response was OK, else
 *   `{ ok: false }` — the metrics post's outcome never affects this value.
 */
export async function sendFeedback(options: SendFeedbackOptions): Promise<{ ok: boolean }> {
  const { submission, dorkHome, dorkosVersion, identity } = options;
  const metricsEndpoint = options.endpoint ?? FEEDBACK_ENDPOINT;
  const cloudUrl = (options.cloudUrl ?? env.DORKOS_CLOUD_URL).replace(/\/+$/, '');
  const durableEndpoint = `${cloudUrl}${DURABLE_FEEDBACK_PATH}`;
  const fetchImpl = options.fetchImpl ?? fetch;

  let instanceId: string;
  try {
    instanceId = await getOrCreateInstanceId(dorkHome);
  } catch (err) {
    // Neither post can proceed without an instance id — report honestly
    // rather than sending a payload with no identity at all.
    logger.warn('[Feedback] Failed to resolve instance id; feedback not sent', logError(err));
    return { ok: false };
  }

  const durableOk = await postDurableFeedback({
    submission,
    instanceId,
    identity,
    endpoint: durableEndpoint,
    fetchImpl,
  });

  // Best-effort metrics continuity — fired for its side effect only. Its
  // outcome (success, non-OK response, or thrown error) never changes the
  // `ok` this function returns; the durable post above is the guarantee.
  await postMetricsFeedback({
    submission,
    instanceId,
    dorkosVersion,
    identity,
    endpoint: metricsEndpoint,
    fetchImpl,
  });

  return { ok: durableOk };
}

/**
 * By-hand mirror of the durable body shape the site's
 * `POST /api/feedback` route validates (`FeedbackIntakeSchema` in
 * `apps/site/src/app/api/feedback/route.ts`) — see this module's doc for the
 * ADR-0235 cross-reference. Field names, optionality, and caps must match
 * that schema exactly; any drift is a silent 400 at the site.
 */
interface DurableFeedbackPayload {
  instanceId: string;
  kind: FeedbackSubmission['kind'];
  message: string;
  contact?: string;
  reporterEmail?: string;
  reporterName?: string;
  route?: string;
  surface: 'cockpit';
  diagnostics?: string;
  transcriptExcerpt?: string;
  hasScreenshot?: boolean;
  hasTranscript?: boolean;
}

/**
 * Render the bounded {@link FeedbackDiagnostics} bundle into the opaque
 * text block the durable route's `diagnostics` field expects — that route
 * folds it verbatim into the Linear issue description and never re-parses it
 * (see that route's module doc), so this is free-form as long as it stays
 * within {@link DURABLE_DIAGNOSTICS_MAX_LEN}.
 *
 * @param diagnostics - The submission's optional diagnostics bundle.
 * @returns The rendered text, or `undefined` when no diagnostics were attached.
 */
function renderDiagnostics(diagnostics: FeedbackDiagnostics | undefined): string | undefined {
  if (!diagnostics) return undefined;

  const { clientReport, breadcrumbs, serverLogExcerpt } = diagnostics;
  const headerLines = [`Version: ${clientReport.version}`, `Platform: ${clientReport.platform}`];
  if (clientReport.runtimes.length > 0) {
    headerLines.push(`Runtimes: ${clientReport.runtimes.join(', ')}`);
  }
  const flagEntries = Object.entries(clientReport.flags);
  if (flagEntries.length > 0) {
    headerLines.push(
      `Flags: ${flagEntries.map(([key, value]) => `${key}=${String(value)}`).join(', ')}`
    );
  }

  const sections = [headerLines.join('\n')];
  if (breadcrumbs && breadcrumbs.length > 0) {
    const breadcrumbLines = breadcrumbs.map((b) => `[${b.at}] ${b.kind}: ${b.message}`);
    sections.push(`Breadcrumbs:\n${breadcrumbLines.join('\n')}`);
  }
  if (serverLogExcerpt) {
    sections.push(`Server log excerpt:\n${serverLogExcerpt}`);
  }

  return sections.join('\n\n').slice(0, DURABLE_DIAGNOSTICS_MAX_LEN);
}

/** Build the {@link DurableFeedbackPayload} for one submission. */
function buildDurablePayload(
  submission: FeedbackSubmission,
  instanceId: string,
  identity: FeedbackIdentity | undefined
): DurableFeedbackPayload {
  const diagnostics = renderDiagnostics(submission.diagnostics);
  const transcriptExcerpt = submission.transcriptExcerpt
    ? submission.transcriptExcerpt.slice(0, DURABLE_TRANSCRIPT_MAX_LEN)
    : undefined;

  return {
    instanceId,
    kind: submission.kind,
    message: submission.message,
    surface: 'cockpit',
    ...(submission.contact ? { contact: submission.contact } : {}),
    ...(identity?.email && identity.email.length <= DURABLE_REPORTER_EMAIL_MAX_LEN
      ? { reporterEmail: identity.email }
      : {}),
    ...(identity?.name
      ? { reporterName: identity.name.slice(0, DURABLE_REPORTER_NAME_MAX_LEN) }
      : {}),
    ...(submission.route ? { route: submission.route } : {}),
    ...(diagnostics ? { diagnostics } : {}),
    ...(transcriptExcerpt ? { transcriptExcerpt, hasTranscript: true } : {}),
    ...(submission.screenshotUploadId ? { hasScreenshot: true } : {}),
  };
}

/**
 * POST the durable payload to the site's `POST /api/feedback`. NEVER throws:
 * a network failure or non-OK response resolves to `false`.
 */
async function postDurableFeedback(args: {
  submission: FeedbackSubmission;
  instanceId: string;
  identity: FeedbackIdentity | undefined;
  endpoint: string;
  fetchImpl: typeof fetch;
}): Promise<boolean> {
  try {
    const payload = buildDurablePayload(args.submission, args.instanceId, args.identity);
    const res = await args.fetchImpl(args.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FEEDBACK_TIMEOUT_MS),
    });
    return res.ok;
  } catch (err) {
    logger.warn('[Feedback] Failed to forward feedback to the durable site route', logError(err));
    return false;
  }
}

/**
 * POST the existing PostHog-shaped metrics event to `/api/telemetry/events`.
 * Best-effort: NEVER throws, and its result is not returned — {@link sendFeedback}
 * only logs on failure here.
 */
async function postMetricsFeedback(args: {
  submission: FeedbackSubmission;
  instanceId: string;
  dorkosVersion: string;
  identity: FeedbackIdentity | undefined;
  endpoint: string;
  fetchImpl: typeof fetch;
}): Promise<void> {
  try {
    const event = buildFeedbackEvent(args.submission, {
      surface: 'cockpit',
      distinctId: args.instanceId,
      timestamp: new Date().toISOString(),
      dorkosVersion: args.dorkosVersion,
      identity: args.identity,
    });

    // Validate our own envelope before sending — a malformed event should be
    // dropped here rather than silently rejected by the ingest.
    const parsed = FeedbackEventSchema.safeParse(event);
    if (!parsed.success) {
      logger.warn('[Feedback] Built an invalid metrics feedback event; not sending');
      return;
    }

    const res = await args.fetchImpl(args.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [parsed.data] }),
      signal: AbortSignal.timeout(FEEDBACK_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn('[Feedback] Metrics ingest returned a non-OK response', { status: res.status });
    }
  } catch (err) {
    // Best-effort: swallow so a metrics failure never affects the durable
    // result or escapes this function.
    logger.warn('[Feedback] Failed to forward feedback metrics event', logError(err));
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
 * List this install's own feedback submissions for the "Product feedback"
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
