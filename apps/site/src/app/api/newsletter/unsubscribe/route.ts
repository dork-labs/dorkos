/**
 * `/api/newsletter/unsubscribe?token=` — unsubscribe endpoint
 * (ADR 260707-025214).
 *
 * Two verbs on one URL, both idempotent and both marking the subscriber (and
 * its Resend contact) unsubscribed via `unsubscribe(token)`:
 *
 * - **GET** — the human-clicked in-email link; redirects to the friendly
 *   `/newsletter/unsubscribed` page.
 * - **POST** — RFC 8058 one-click. When broadcasts advertise
 *   `List-Unsubscribe: <this URL>` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
 *   the mail client POSTs here (body `List-Unsubscribe=One-Click`), which
 *   expects a `200`, not a redirect. Without this handler Gmail/Apple one-click
 *   unsubscribe would 405.
 *
 * Node runtime for `node:crypto` token hashing.
 *
 * @module app/api/newsletter/unsubscribe
 */
import { unsubscribe } from '@/lib/newsletter/service';

export const runtime = 'nodejs';

/** Extract the `token` query param from the request URL. */
function tokenFrom(request: Request): string {
  return new URL(request.url).searchParams.get('token') ?? '';
}

/** Handle the human-clicked unsubscribe link and redirect to the result page. */
export async function GET(request: Request): Promise<Response> {
  await unsubscribe(tokenFrom(request));
  return Response.redirect(new URL('/newsletter/unsubscribed', request.url), 303);
}

/**
 * Handle an RFC 8058 one-click unsubscribe POST from a mail client. Returns a
 * bare `200` (mail clients ignore the body) rather than a redirect.
 */
export async function POST(request: Request): Promise<Response> {
  await unsubscribe(tokenFrom(request));
  return new Response(null, { status: 200 });
}
