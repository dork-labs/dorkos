/**
 * `POST /api/newsletter/subscribe` — newsletter double-opt-in entry point
 * (ADR 260707-025214).
 *
 * Validates the email, records a `pending` subscriber, and sends the
 * confirmation email. Runs on the Node runtime (token generation uses
 * `node:crypto`, matching the auth routes). The response is **always**
 * `200 { ok: true }` once the payload validates: a duplicate, an
 * already-confirmed address, and even a downstream mailer failure all look
 * identical to the client, so the endpoint can never be used to probe whether
 * an address is on the list.
 *
 * The one exception to that shape is the per-IP throttle (DOR-1581): a caller
 * over the limit gets `429` with a `Retry-After`. It leaks nothing about any
 * address — only that this IP has posted too often — and without it a `curl`
 * loop could pump the pending list.
 *
 * @module app/api/newsletter/subscribe
 */
import { z } from 'zod';

import { subscribe } from '@/lib/newsletter/service';
import { consumeSubscribeQuota } from '@/lib/newsletter/subscribe-rate-limit';

export const runtime = 'nodejs';

const SubscribeSchema = z.object({
  email: z.string().email().max(254),
  source: z
    .enum(['footer', 'newsletter-page', 'blog', 'tutorials-modal', 'unknown'])
    .default('unknown'),
});

/**
 * Handle a subscribe POST. Returns `429` when this IP is over its limit and
 * `400` on malformed JSON or an invalid email; every other valid submission
 * returns `200 { ok: true }`.
 */
export async function POST(request: Request): Promise<Response> {
  const quota = consumeSubscribeQuota(request);
  if (!quota.allowed) {
    // For whoever is calling the endpoint directly. The signup form never reads
    // this body — it renders its own copy from `use-newsletter-form` — so the
    // two sentences are independent, not a duplicate waiting to drift.
    return Response.json(
      { error: 'Too many requests. Retry after the number of seconds in the Retry-After header.' },
      { status: 429, headers: { 'retry-after': String(quota.retryAfterSeconds) } }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = SubscribeSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'Invalid email' }, { status: 400 });
  }

  try {
    await subscribe(parsed.data.email, parsed.data.source);
  } catch (error) {
    // Swallow: never leak whether the address exists or whether the mail send
    // failed. The pending row is already written; a retry re-sends.
    console.error('[api/newsletter/subscribe] failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return Response.json({ ok: true });
}
