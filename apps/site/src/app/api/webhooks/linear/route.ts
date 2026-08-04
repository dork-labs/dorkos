/**
 * `POST /api/webhooks/linear` — Linear webhook receiver for the feedback
 * intake pipeline (feedback-pipeline Part 4, decision 260803-205035).
 *
 * The first webhook-signature-verification code in this repo. Linear signs
 * every delivery with an HMAC-SHA256 hex digest of the raw request body,
 * keyed by the webhook's signing secret, sent in the `Linear-Signature`
 * header — verified here with `crypto.timingSafeEqual` so a bad signature is
 * rejected in constant time rather than leaking a timing side-channel. Runs
 * on the `nodejs` runtime (`node:crypto`, matching every other
 * signature/token-hashing route in this app).
 *
 * On a verified `Issue` `update` event whose `data.id` matches a
 * `feedback_submission.linearIssueId`, the issue's workflow state is mapped
 * to the cockpit's four-plus-received status vocabulary
 * (`lib/feedback/linear-status-map.ts`) and written onto that row. A mapped
 * status of `shipped` also best-effort captures a `shippedVersion`. The
 * "your report shipped" email fires via `sendFeedbackShipped` only on the
 * **transition into** `shipped` (the row's status before this update was
 * something else) — Linear sends an `Issue` `update` webhook for every field
 * change (label, assignee, description…), so an already-shipped issue keeps
 * generating deliveries this route must not re-notify on. A mail failure
 * never fails the webhook response, since Linear will retry a non-2xx
 * delivery and this repo's Linear issue is already the source of truth for
 * what happened.
 *
 * Every other event shape (a different `type`, a non-`update` `action`, an
 * issue that isn't ours, or a state with no mapping) is accepted with a bare
 * `{ ok: true }` — Linear should never see a retry-worthy failure for an
 * event this route simply has nothing to do with.
 *
 * @module app/api/webhooks/linear
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '@/db/client';
import { feedbackSubmission } from '@/db/feedback-schema';
import { env } from '@/env';
import { mapLinearStateToStatus, resolveShippedVersion } from '@/lib/feedback/linear-status-map';
import { sendFeedbackShipped } from '@/lib/mailer';
import { resolveNotifyEmail } from '@/lib/feedback/notify-email';

export const runtime = 'nodejs';

/** Header Linear sends the HMAC-SHA256 hex signature in. */
const SIGNATURE_HEADER = 'linear-signature';

/**
 * Loose schema for the slice of a Linear `Issue` webhook this route reads.
 * Deliberately **not** `.strict()` — this is a third-party payload Linear can
 * grow at any time, unlike the request bodies this repo controls end to end.
 */
const LinearWebhookSchema = z.object({
  action: z.string(),
  type: z.string(),
  data: z.object({
    id: z.string(),
    state: z
      .object({
        name: z.string().optional(),
        type: z.string().optional(),
      })
      .optional(),
    projectMilestone: z.object({ name: z.string().optional() }).nullish(),
    cycle: z.object({ name: z.string().optional() }).nullish(),
  }),
});

/**
 * Verify the raw body against Linear's HMAC-SHA256 signature, constant-time.
 *
 * @param rawBody - The exact bytes Linear signed (read before JSON parsing).
 * @param signatureHeader - The `Linear-Signature` header value, or null.
 * @param secret - `LINEAR_WEBHOOK_SECRET`.
 */
function isValidSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string
): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(signatureHeader, 'utf8');
  // timingSafeEqual throws on a length mismatch rather than returning false —
  // check first so a same-length-required comparison never becomes a crash.
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Handle a Linear webhook delivery. `401` on a missing/invalid signature
 * (including when the secret itself is unconfigured — an unverifiable
 * payload is rejected, not trusted), `200 { ok: true }` for everything else,
 * including event shapes this route has nothing to do.
 */
export async function POST(request: Request): Promise<Response> {
  if (!env.LINEAR_WEBHOOK_SECRET) {
    console.error('[webhooks/linear] LINEAR_WEBHOOK_SECRET is not configured; rejecting delivery');
    return Response.json({ ok: false, error: 'Webhook not configured' }, { status: 401 });
  }

  const raw = await request.text();
  const signature = request.headers.get(SIGNATURE_HEADER);
  if (!isValidSignature(raw, signature, env.LINEAR_WEBHOOK_SECRET)) {
    return Response.json({ ok: false, error: 'Invalid signature' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = LinearWebhookSchema.safeParse(body);
  if (!parsed.success) {
    // A shape we don't understand — accept so Linear doesn't retry forever,
    // but there is nothing to act on.
    return Response.json({ ok: true });
  }

  const { action, type, data } = parsed.data;
  if (type !== 'Issue' || action !== 'update') {
    return Response.json({ ok: true });
  }

  const status = mapLinearStateToStatus(data.state);
  if (!status) {
    return Response.json({ ok: true });
  }

  const db = getDb();
  const [row] = await db
    .select()
    .from(feedbackSubmission)
    .where(eq(feedbackSubmission.linearIssueId, data.id))
    .limit(1);
  if (!row) {
    // Not a Linear issue this pipeline created (or a delivery that arrived
    // before the create-time update wrote the id) — nothing to update.
    return Response.json({ ok: true });
  }

  const shippedVersion = status === 'shipped' ? resolveShippedVersion(data) : undefined;

  await db
    .update(feedbackSubmission)
    .set({
      status,
      updatedAt: new Date(),
      ...(shippedVersion ? { shippedVersion } : {}),
    })
    .where(eq(feedbackSubmission.id, row.id));

  if (status === 'shipped' && row.status !== 'shipped') {
    const to = resolveNotifyEmail(row);
    const version = shippedVersion ?? row.shippedVersion;
    if (to && version) {
      // Never awaited-through to the response's success/fail — sendFeedbackShipped
      // itself catches and logs, so a Resend outage never turns this 200 into a
      // 500 (and never causes Linear to retry a delivery that already landed).
      await sendFeedbackShipped(to, { message: row.message, shippedVersion: version });
    }
  }

  return Response.json({ ok: true });
}
