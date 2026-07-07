/**
 * `GET /api/newsletter/unsubscribe?token=` — one-click unsubscribe
 * (ADR 260707-025214).
 *
 * The target of both the in-email unsubscribe link and the `List-Unsubscribe`
 * header on broadcasts. Marks the subscriber (and its Resend contact)
 * unsubscribed, then redirects to `/newsletter/unsubscribed`. Idempotent:
 * an unknown token still lands on the friendly page. Node runtime for
 * `node:crypto` token hashing.
 *
 * @module app/api/newsletter/unsubscribe
 */
import { unsubscribe } from '@/lib/newsletter/service';

export const runtime = 'nodejs';

/** Handle the unsubscribe-link GET and redirect to the result page. */
export async function GET(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get('token') ?? '';
  await unsubscribe(token);
  return Response.redirect(new URL('/newsletter/unsubscribed', request.url), 303);
}
