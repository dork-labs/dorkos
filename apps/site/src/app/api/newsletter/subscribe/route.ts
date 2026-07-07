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
 * @module app/api/newsletter/subscribe
 */
import { z } from 'zod';

import { subscribe } from '@/lib/newsletter/service';

export const runtime = 'nodejs';

const SubscribeSchema = z.object({
  email: z.string().email().max(254),
  source: z.enum(['footer', 'newsletter-page', 'blog', 'unknown']).default('unknown'),
});

/**
 * Handle a subscribe POST. Returns `400` only on malformed JSON or an invalid
 * email; every valid submission returns `200 { ok: true }`.
 */
export async function POST(request: Request): Promise<Response> {
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
