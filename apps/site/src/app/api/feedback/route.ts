/**
 * `POST /api/feedback` — durable intake for in-app feedback submissions
 * (feedback-pipeline, decision 260803-205035: dual-write to Linear with Neon
 * as system of record).
 *
 * This is a **new, additional** site route — not the existing
 * `/api/telemetry/events` ingest, which is explicitly "no Neon table,
 * PostHog only" by design (see that route's module doc) and keeps receiving
 * the same lightweight `feedback_submitted`/`feature_requested` PostHog
 * events unchanged, for aggregate metrics continuity. The cockpit's own
 * server forwards the richer submission here as a second, additive target.
 *
 * Runs on the `nodejs` runtime (not edge): Linear issue creation wants
 * ordinary Node fetch semantics and this isn't a hot, high-volume path the
 * way the PostHog ingest is.
 *
 * ## Cross-reference (ADR-0235)
 *
 * `FeedbackIntakeSchema` below is a route-local mirror of the richer
 * submission shape `packages/shared`'s `FeedbackSubmissionSchema` grows in
 * PR A of this same spec (`specs/feedback-pipeline/02-specification.md` Part
 * 1), plus the server-filled context fields (`instanceId`, `surface`,
 * resolved `reporterEmail`/`reporterName`) the cockpit server adds before
 * forwarding. Per ADR-0235 the site keeps route-local schemas rather than
 * importing `@dorkos/shared` — keep this mirror's caps and shape in lockstep
 * with the shared registry by hand; a reviewer should treat a drift between
 * the two as a bug.
 *
 * ## Flow and honesty contract
 *
 * per-IP throttle → honeypot check → Zod validate (strict, per-field caps,
 * whole-body size cap) → insert `feedback_submission` (`status: 'received'`) → best-effort
 * receipt email (Part 4, when a `reporterEmail`/email-shaped `contact` is on
 * the submission) → best-effort `createFeedbackIssue` → on success, update
 * the row with Linear ids and `status: 'triaged'`. The response is
 * `{ ok: true, id }` in **both** the Linear-success and Linear-failure cases —
 * the Neon insert is the durable, caller-visible guarantee; Linear is
 * retryable out-of-band later (a reconciliation sweep for stuck `received`
 * rows is a documented follow-up, not built here). Only a failed Neon insert
 * or an invalid body is `{ ok: false }` / a non-200 status.
 *
 * The per-IP throttle (DOR-1586) is charged first, before the body is sized or
 * read: a caller over its limit gets `429` with a `Retry-After` and nothing is
 * persisted. It leaks nothing about any submission — only that this IP has
 * posted too often — and every accepted request costs a Neon row, an email, and
 * a Linear issue, so an unthrottled loop is expensive in three places at once.
 *
 * @module app/api/feedback
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '@/db/client';
import { feedbackSubmission } from '@/db/feedback-schema';
import { createFeedbackIssue } from '@/lib/feedback/linear';
import { resolveNotifyEmail } from '@/lib/feedback/notify-email';
import { consumeFeedbackQuota } from '@/lib/feedback/submit-rate-limit';
import { resolveBaseURL } from '@/lib/auth';
import { sendFeedbackReceipt } from '@/lib/mailer';

export const runtime = 'nodejs';

const MAX_MESSAGE_LEN = 4000;
const MAX_CONTACT_LEN = 254;
const MAX_ROUTE_LEN = 256;
const MAX_INSTANCE_ID_LEN = 128;
const MAX_REPORTER_NAME_LEN = 128;
const MAX_DIAGNOSTICS_LEN = 8000;
const MAX_TRANSCRIPT_LEN = 8000;
const MAX_ATTACHMENT_URLS = 5;
const MAX_URL_LEN = 2048;
// Whole-body size cap. The screenshot itself rides a separate upload path
// (Part 3 references `screenshotUploadId`/pre-uploaded attachment URLs), so
// this route's body stays small — bounding it defends against a caller that
// somehow inlines large content instead of uploading it first.
const MAX_BODY_BYTES = 64_000;

/**
 * Route-local mirror of the submission shape (see module doc). `.strict()`
 * so an unexpected field is a validation error, not silent drop.
 */
const FeedbackIntakeSchema = z
  .object({
    instanceId: z.string().min(1).max(MAX_INSTANCE_ID_LEN),
    kind: z.enum(['feedback', 'bug', 'idea']),
    message: z.string().min(1).max(MAX_MESSAGE_LEN),
    contact: z.string().min(1).max(MAX_CONTACT_LEN).optional(),
    reporterEmail: z.string().email().max(MAX_CONTACT_LEN).optional(),
    reporterName: z.string().min(1).max(MAX_REPORTER_NAME_LEN).optional(),
    route: z.string().min(1).max(MAX_ROUTE_LEN).optional(),
    surface: z.enum(['cockpit', 'site']),
    // Bounded, pre-rendered diagnostics text (the cockpit server builds this
    // from `FeedbackDiagnosticsSchema` — client report, breadcrumbs, server
    // log excerpt — before forwarding; this route treats it as opaque text
    // and folds it into the Linear issue description, never re-parses it).
    diagnostics: z.string().max(MAX_DIAGNOSTICS_LEN).optional(),
    transcriptExcerpt: z.string().max(MAX_TRANSCRIPT_LEN).optional(),
    attachmentUrls: z.array(z.string().url().max(MAX_URL_LEN)).max(MAX_ATTACHMENT_URLS).optional(),
    hasScreenshot: z.boolean().optional(),
    hasTranscript: z.boolean().optional(),
    // Honeypot: a hidden field no human fills in, checked (and short-circuited
    // on) before this schema ever runs — see the check in POST() below.
    // Declared here, not stripped, so a legitimate empty submission from the
    // real form doesn't fail `.strict()` over its own anti-spam field.
    website: z.string().max(200).optional(),
  })
  .strict();

type FeedbackIntake = z.infer<typeof FeedbackIntakeSchema>;

/** Always-200 success shape; `id` is the tracking id (the Neon row id), or `null` for a dropped honeypot hit. */
interface OkResponse {
  ok: true;
  id: string | null;
}

interface ErrorResponse {
  ok: false;
  error: string;
  issues?: unknown[];
}

/**
 * Handle a feedback submission POST.
 *
 * `429` when this IP is over its limit, `400` for malformed JSON or a schema
 * violation, `413` for an oversized
 * body, `500` only when the durable Neon insert itself fails. Every other
 * path — including a Linear failure — is `200 { ok: true, id }`.
 */
export async function POST(request: Request): Promise<Response> {
  // Charged before the body is even sized, let alone read: the flood this
  // exists to slow is a loop posting whatever it likes, so what was sent must
  // not decide whether it counts.
  const quota = consumeFeedbackQuota(request);
  if (!quota.allowed) {
    return Response.json(
      {
        ok: false,
        error: 'Too many requests. Retry after the number of seconds in the Retry-After header.',
      } satisfies ErrorResponse,
      { status: 429, headers: { 'retry-after': String(quota.retryAfterSeconds) } }
    );
  }

  // Best-effort early reject before buffering: an honest, oversized
  // Content-Length is turned away without materializing the body. It can be
  // absent or wrong, so the post-read byte check below stays the authoritative
  // bound (and the platform's own serverless body limit is the real memory
  // ceiling regardless).
  const declaredLen = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
    return Response.json({ ok: false, error: 'Payload too large' }, { status: 413 });
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return Response.json({ ok: false, error: 'Could not read request body' }, { status: 400 });
  }

  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return Response.json({ ok: false, error: 'Payload too large' }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  // Honeypot: a hidden `website` field no human fills in (mirrors
  // `/api/telemetry/events`'s posture). A non-empty value is a bot — accept
  // (so it learns nothing) but persist nothing and skip Linear entirely.
  if (
    body != null &&
    typeof body === 'object' &&
    typeof (body as { website?: unknown }).website === 'string' &&
    (body as { website: string }).website.trim() !== ''
  ) {
    return Response.json({ ok: true, id: null } satisfies OkResponse);
  }

  const parsed = FeedbackIntakeSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        ok: false,
        error: 'Invalid submission',
        issues: parsed.error.issues,
      } satisfies ErrorResponse,
      { status: 400 }
    );
  }

  const submission = parsed.data;

  let insertedId: string;
  try {
    insertedId = await insertFeedbackRow(submission);
  } catch (error) {
    console.error('[api/feedback] insert failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { ok: false, error: 'Failed to record submission' } satisfies ErrorResponse,
      { status: 500 }
    );
  }

  // The receipt email (feedback-pipeline Part 4) fires right after the
  // durable insert succeeds — it is the "we got it" confirmation, so it must
  // not wait on the best-effort Linear mirror below. `sendFeedbackReceipt`
  // never throws (it catches and logs internally), so a Resend outage can
  // never turn this into a failed request.
  const notifyEmail = resolveNotifyEmail(submission);
  if (notifyEmail) {
    await sendFeedbackReceipt(notifyEmail, `${resolveBaseURL()}/feedback/${insertedId}`);
  }

  // Linear is best-effort on top of the durable insert above — a failure
  // here must never turn the honest "received" response into an error. The
  // row simply stays `status: 'received'` with no Linear id, retryable
  // out-of-band later.
  try {
    const issue = await createFeedbackIssue({
      kind: submission.kind,
      message: submission.message,
      reporterEmail: submission.reporterEmail,
      reporterName: submission.reporterName,
      contact: submission.contact,
      route: submission.route,
      diagnosticsSummary: buildDiagnosticsSummary(submission),
      attachmentUrls: submission.attachmentUrls,
    });
    if (issue) {
      await markTriaged(insertedId, issue);
    }
  } catch (error) {
    console.error('[api/feedback] Linear create failed (row stays received)', {
      id: insertedId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return Response.json({ ok: true, id: insertedId } satisfies OkResponse);
}

/** Insert the durable row. Returns the new row's id (the tracking id). */
async function insertFeedbackRow(submission: FeedbackIntake): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(feedbackSubmission)
    .values({
      instanceId: submission.instanceId,
      kind: submission.kind,
      message: submission.message,
      contact: submission.contact ?? null,
      reporterEmail: submission.reporterEmail ?? null,
      reporterName: submission.reporterName ?? null,
      route: submission.route ?? null,
      surface: submission.surface,
      hasScreenshot: submission.hasScreenshot ?? false,
      hasTranscript: submission.hasTranscript ?? false,
    })
    .returning({ id: feedbackSubmission.id });

  if (!row) {
    throw new Error('insert returned no row');
  }
  return row.id;
}

/** Update a row with the Linear mirror's ids and flip it to `triaged`. */
async function markTriaged(
  id: string,
  issue: { issueId: string; issueUrl: string }
): Promise<void> {
  const db = getDb();
  await db
    .update(feedbackSubmission)
    .set({
      linearIssueId: issue.issueId,
      linearIssueUrl: issue.issueUrl,
      status: 'triaged',
      updatedAt: new Date(),
    })
    .where(eq(feedbackSubmission.id, id));
}

/** Fold the diagnostics text and transcript excerpt into one summary block for the Linear description. */
function buildDiagnosticsSummary(submission: FeedbackIntake): string | undefined {
  const parts: string[] = [];
  if (submission.diagnostics) parts.push(submission.diagnostics);
  if (submission.transcriptExcerpt) {
    parts.push(`Transcript excerpt:\n${submission.transcriptExcerpt}`);
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}
