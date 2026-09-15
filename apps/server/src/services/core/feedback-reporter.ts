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

// There is deliberately NO cap constant for the attached screenshot's `data:`
// URL: it is forwarded verbatim, unlike `diagnostics` and `transcriptExcerpt`
// above. Those two truncate because `@dorkos/shared`'s caps (20,000) exceed the
// site route's (8,000), so a legal submission could still 400 the durable write.
// The screenshot's two caps are the SAME number on both sides
// (`MAX_FEEDBACK_SCREENSHOT_DATA_URL_LEN` = the site's
// `MAX_SCREENSHOT_DATA_URL_LEN` = 850,000), and only a submission that already
// passed the shared schema reaches here, so an over-cap value cannot arrive.
// Truncating would be worse than useless anyway: a sliced base64 payload is a
// corrupt image, not a smaller one. If the caps ever diverge, DROP the
// screenshot rather than slicing it — the same reasoning that drops an over-cap
// reporter email instead of truncating it.

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
  /**
   * Current DorkOS version. Attached as a context property on the metrics
   * event, AND rendered into the durable diagnostics block beside the version
   * the client reported — so an upgrade that happened under a long-lived tab is
   * visible to triage instead of being invisible skew (DOR-1960).
   */
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
    serverVersion: dorkosVersion,
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
  screenshot?: { dataUrl: string };
  hasScreenshot?: boolean;
  hasTranscript?: boolean;
}

/** What separates two sections of the rendered diagnostics block. */
const SECTION_SEPARATOR = '\n\n';

/** Join rendered sections into the block the durable route receives. */
function joinSections(sections: string[]): string {
  return sections.join(SECTION_SEPARATOR);
}

/** One labelled, newest-last excerpt awaiting a budget. `text` absent means "not attached". */
interface BudgetedSection {
  /** The heading a reader sees, without its colon. */
  label: string;
  /** The body, oldest first, already bounded by whoever gathered it. */
  text: string | undefined;
}

/** What a section's heading says when there was no room for any of its body. */
const OMITTED_SUFFIX = ': (omitted, no room)';

/**
 * Divide `available` characters between sections that each want `costs[i]`.
 *
 * Max-min fair: everyone gets an equal share, whatever the sections that need
 * less than their share do not use is handed back to the ones that want more,
 * and the total can never exceed `available`. So a five-line server excerpt
 * does not cost the desktop excerpt half the block, and two full-size excerpts
 * get half each.
 *
 * @param costs - How many characters each section would use unbounded.
 * @param available - Characters left for all of them together.
 */
function shareBudget(costs: number[], available: number): number[] {
  if (costs.length === 0) return [];
  const share = Math.floor(Math.max(0, available) / costs.length);
  const slack = costs.reduce((sum, cost) => sum + Math.max(0, share - cost), 0);
  const overBudget = costs.filter((cost) => cost > share).length;
  const bonus = overBudget > 0 ? Math.floor(slack / overBudget) : 0;
  return costs.map((cost) => (cost <= share ? cost : share + bonus));
}

/**
 * The smallest section worth emitting, in characters.
 *
 * Below this a section is a label and a few characters of a line nobody can
 * read, which is worse than saying nothing: it looks like the log was empty
 * rather than like it did not fit.
 */
const MIN_LOG_SECTION_LEN = 200;

/**
 * Render the block's variable-length sections, each within its own share of
 * what the header left.
 *
 * **Why this is not one slice over the whole block.** Every section here is
 * bounded on its own — the two log excerpts at `MAX_LOG_EXCERPT_LEN` (8,000),
 * the breadcrumbs at 50 × 300 — while the rendered block is capped at
 * {@link DURABLE_DIAGNOSTICS_MAX_LEN} (8,000). So "more than fits" is the
 * ordinary shape of a report from an app that has been running a while, not an
 * edge case. A single head slice across the joined block deleted whichever
 * sections came last, label and all, so the report did not even say it had been
 * cut; at smaller sizes it cut those sections' TAILS, which is their newest end
 * and the half a report is filed about. Both were measured in review
 * (DOR-2045), the second round of which found breadcrumbs doing it to BOTH
 * logs at 23 maximum-size crumbs.
 *
 * Each section is therefore cut from the FRONT with a leading ellipsis, which
 * is how the excerpts were bounded by their own gatherers (`log-excerpt.ts` and
 * the shell's `shell-log-excerpt`) and for the same reason: a report is filed
 * about the moment at the end of the log, and the newest breadcrumb is the one
 * next to the crash.
 *
 * **A section that does not fit says so.** Saying "omitted" is itself a section
 * and costs characters, so that cost is reserved for every attached section
 * before anything is shared out — a report that silently drops its logs reads
 * as "there were no logs", which sends triage looking in the wrong place.
 *
 * @param candidates - The labelled sections, in the order they should appear.
 * @param available - Characters left after the header.
 * @returns The rendered sections, each either whole, front-cut, or a one-line
 *   marker saying it did not fit.
 */
function renderBudgetedSections(candidates: BudgetedSection[], available: number): string[] {
  const attached = candidates.filter((section): section is BudgetedSection & { text: string } =>
    Boolean(section.text)
  );
  if (attached.length === 0) return [];

  // Each section costs its label line plus the separator that precedes it...
  const overheads = attached.map((s) => `${s.label}:\n`.length + SECTION_SEPARATOR.length);
  // ...and, at minimum, the cost of admitting it did not fit.
  const markers = attached.map((s) => `${s.label}${OMITTED_SUFFIX}`);
  const floors = markers.map((marker) => marker.length + SECTION_SEPARATOR.length);
  const reserved = floors.reduce((sum, floor) => sum + floor, 0);

  // Not even room to say what was dropped: the header alone has taken the whole
  // block, which is only reachable through the uncapped `flags` record.
  if (available < reserved) {
    logger.warn('[Feedback] No room in the diagnostics block for any excerpt', {
      omitted: attached.map((s) => s.label),
    });
    return [];
  }

  const extras = shareBudget(
    attached.map((s, i) => Math.max(0, s.text.length + overheads[i] - floors[i])),
    available - reserved
  );

  const rendered: string[] = [];
  const omitted: string[] = [];
  for (const [i, section] of attached.entries()) {
    const room = floors[i] + extras[i] - overheads[i];
    // Fits whole — the common case, and the one the minimum below must not
    // touch: a five-line server excerpt is short, not squeezed.
    if (section.text.length <= room) {
      rendered.push(`${section.label}:\n${section.text}`);
      continue;
    }
    if (room < MIN_LOG_SECTION_LEN) {
      rendered.push(markers[i]);
      omitted.push(section.label);
      continue;
    }
    rendered.push(`${section.label}:\n…${section.text.slice(-(room - 1))}`);
  }
  if (omitted.length > 0) {
    logger.warn('[Feedback] Dropped a diagnostics section with no room left', { omitted });
  }
  return rendered;
}

/**
 * Render the bounded {@link FeedbackDiagnostics} bundle into the opaque
 * text block the durable route's `diagnostics` field expects — that route
 * folds it verbatim into the Linear issue description and never re-parses it
 * (see that route's module doc), so this is free-form as long as it stays
 * within {@link DURABLE_DIAGNOSTICS_MAX_LEN}.
 *
 * The environment lines are emitted BEFORE the `Flags` line, and the header as
 * a whole before every other section. That ordering is what protects them: the
 * header is the one part no budget can shrink, so it has to come first, and
 * within it the bounded environment lines precede the unbounded `flags` record.
 *
 * Everything after the header — breadcrumbs and the two log excerpts — shares
 * one budget and is cut from the FRONT, so no section can starve another and a
 * section that could not fit says so. See {@link renderBudgetedSections};
 * breadcrumbs alone can reach ~17,000 characters (50 × a 300-char message),
 * which is how they came to delete both logs from a report (DOR-2045).
 *
 * @param diagnostics - The submission's optional diagnostics bundle.
 * @param serverVersion - This server's own version, for the upgrade-skew line.
 * @returns The rendered text, or `undefined` when no diagnostics were attached.
 */
function renderDiagnostics(
  diagnostics: FeedbackDiagnostics | undefined,
  serverVersion: string
): string | undefined {
  if (!diagnostics) return undefined;

  const { clientReport, breadcrumbs, serverLogExcerpt, shellLogExcerpt } = diagnostics;

  // The client's `version` is whatever the server reported to it when its config
  // query last ran, so the two agree in the normal case and there is nothing to
  // say. They diverge exactly when the server was upgraded under a long-lived
  // tab — which is a leading cause of "it broke and I don't know why" — so name
  // both numbers only then, rather than printing a redundant pair every time.
  //
  // `unknown` is the client's placeholder for "the config query had not
  // resolved yet" (`buildClientReport`), not a version. Reporting it as skew
  // would invent a disagreement out of a loading state, so the server's number
  // simply stands alone.
  const clientVersionKnown = clientReport.version !== 'unknown' && clientReport.version !== '';
  const versionLine = !clientVersionKnown
    ? `Version: ${serverVersion}`
    : clientReport.version === serverVersion
      ? `Version: ${clientReport.version}`
      : `Version: ${clientReport.version} (server ${serverVersion})`;

  const headerLines = [versionLine, `Platform: ${clientReport.platform}`];
  if (clientReport.runtimes.length > 0) {
    headerLines.push(`Runtimes: ${clientReport.runtimes.join(', ')}`);
  }

  // The "what was on screen" half (DOR-1960). Each line is emitted only when the
  // client actually answered that field: an absent one means the host could not
  // report it, and a placeholder would read as a measurement.
  const { viewport, browser, shell, theme, locale, timezone } = clientReport;
  if (viewport) {
    const dpr = viewport.devicePixelRatio;
    headerLines.push(
      `Viewport: ${viewport.width}x${viewport.height}${dpr && dpr !== 1 ? ` @${dpr}x` : ''}`
    );
  }
  if (shell) headerLines.push(`Shell: ${shell}`);
  if (theme) headerLines.push(`Theme: ${theme}`);
  if (locale) headerLines.push(`Locale: ${locale}`);
  if (timezone) headerLines.push(`Timezone: ${timezone}`);
  if (browser) headerLines.push(`Browser: ${browser}`);

  const flagEntries = Object.entries(clientReport.flags);
  if (flagEntries.length > 0) {
    headerLines.push(
      `Flags: ${flagEntries.map(([key, value]) => `${key}=${String(value)}`).join(', ')}`
    );
  }

  // The header is the only unbudgeted section: it is the part that has to
  // survive, and it is emitted first for that reason.
  const sections = [headerLines.join('\n')];

  // Everything else shares what the header leaves, each front-cut on its own.
  // Breadcrumbs are in here rather than emitted ahead of the budget: 23
  // maximum-size crumbs are enough to spend the whole block, and they used to
  // take both logs down with them and say nothing about it.
  const budgeted: BudgetedSection[] = [
    {
      label: 'Breadcrumbs',
      text:
        breadcrumbs && breadcrumbs.length > 0
          ? breadcrumbs.map((b) => `[${b.at}] ${b.kind}: ${b.message}`).join('\n')
          : undefined,
    },
    { label: 'Server log excerpt', text: serverLogExcerpt },
    // The desktop shell's own log (DOR-2045), named apart from the server's so
    // a reader knows which process wrote which. Present only on a report filed
    // from the desktop app; it carries none of the server child's forwarded
    // output, which the shell filters out precisely so this does not repeat the
    // section above it.
    { label: 'Desktop app log excerpt', text: shellLogExcerpt },
  ];
  sections.push(
    ...renderBudgetedSections(budgeted, DURABLE_DIAGNOSTICS_MAX_LEN - joinSections(sections).length)
  );

  return joinSections(sections).slice(0, DURABLE_DIAGNOSTICS_MAX_LEN);
}

/**
 * Build the {@link DurableFeedbackPayload} for one submission.
 *
 * @param submission - The gathered submission.
 * @param instanceId - This install's anonymous id.
 * @param identity - The server-resolved reporter identity, when there is one.
 * @param serverVersion - This server's version, rendered into the diagnostics block.
 */
function buildDurablePayload(
  submission: FeedbackSubmission,
  instanceId: string,
  identity: FeedbackIdentity | undefined,
  serverVersion: string
): DurableFeedbackPayload {
  const diagnostics = renderDiagnostics(submission.diagnostics, serverVersion);
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
    ...(submission.screenshot
      ? { screenshot: { dataUrl: submission.screenshot.dataUrl }, hasScreenshot: true }
      : {}),
  };
}

/**
 * POST the durable payload to the site's `POST /api/feedback`. NEVER throws:
 * a network failure or non-OK response resolves to `false`.
 *
 * On a `413` it retries ONCE with the screenshot dropped. Every per-field cap
 * on both sides counts CHARACTERS, while the site's whole-body cap counts
 * BYTES — so a report written in a multibyte script, carrying a
 * maximum-sized screenshot, can satisfy every field rule and still exceed
 * 900,000 bytes. Without the retry that is a 413 and the entire report is
 * lost, which is exactly the outcome the screenshot degradation elsewhere in
 * this pipeline exists to prevent. Losing the picture is the acceptable half.
 */
async function postDurableFeedback(args: {
  submission: FeedbackSubmission;
  instanceId: string;
  identity: FeedbackIdentity | undefined;
  /** This server's version, rendered into the diagnostics block. */
  serverVersion: string;
  endpoint: string;
  fetchImpl: typeof fetch;
}): Promise<boolean> {
  const send = (payload: DurableFeedbackPayload): Promise<Response> =>
    args.fetchImpl(args.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FEEDBACK_TIMEOUT_MS),
    });

  try {
    const payload = buildDurablePayload(
      args.submission,
      args.instanceId,
      args.identity,
      args.serverVersion
    );
    const res = await send(payload);
    if (res.ok) return true;
    if (res.status !== 413 || !payload.screenshot) return false;

    logger.warn(
      '[Feedback] Submission too large with its screenshot; retrying without it so the report survives'
    );
    // `hasScreenshot` goes with it: after the drop this submission genuinely
    // does not carry one, and the flag is what the tracking view shows the
    // reporter. Claiming a screenshot that was never delivered is the one
    // dishonest option here.
    const { screenshot: _dropped, hasScreenshot: _hint, ...withoutScreenshot } = payload;
    const retry = await send(withoutScreenshot);
    return retry.ok;
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
