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
 * Both verbs share one per-IP throttle (DOR-1586), charged before the token is
 * looked up — it is one operation on one resource, so one bucket. The allowance
 * is set generously by the one-click case: those POSTs come from the mail
 * provider's servers, so every reader unsubscribing from one broadcast arrives
 * from the same few addresses at once, and refusing one would leave a reader
 * subscribed while telling them they are not. Over the limit answers `429` with
 * a `Retry-After`, in each verb's own style: a readable page for the GET a
 * person is watching, a bare response for the POST a mail client makes.
 *
 * @module app/api/newsletter/unsubscribe
 */
import { unsubscribe } from '@/lib/newsletter/service';
import {
  consumeUnsubscribeLinkQuota,
  consumeUnsubscribeOneClickQuota,
} from '@/lib/newsletter/unsubscribe-rate-limit';
import { tooManyRequestsPage, waitPhrase } from '@/lib/rate-limit/too-many-requests-page';

export const runtime = 'nodejs';

/** Extract the `token` query param from the request URL. */
function tokenFrom(request: Request): string {
  return new URL(request.url).searchParams.get('token') ?? '';
}

/**
 * Handle the human-clicked unsubscribe link and redirect to the result page.
 * Returns `429` as a readable page when this IP is over its limit.
 */
export async function GET(request: Request): Promise<Response> {
  const quota = consumeUnsubscribeLinkQuota(request);
  if (!quota.allowed) {
    return tooManyRequestsPage(
      'One moment',
      `Too many people opened this link from your network just now. Try again in ${waitPhrase(quota.retryAfterSeconds)} to unsubscribe.`,
      quota.retryAfterSeconds
    );
  }

  await unsubscribe(tokenFrom(request));
  return Response.redirect(new URL('/newsletter/unsubscribed', request.url), 303);
}

/**
 * Handle an RFC 8058 one-click unsubscribe POST from a mail client. Returns a
 * bare `200` (mail clients ignore the body) rather than a redirect, and a bare
 * `429` with a `Retry-After` in the same style when this IP is over its limit.
 */
export async function POST(request: Request): Promise<Response> {
  const quota = consumeUnsubscribeOneClickQuota(request);
  if (!quota.allowed) {
    return new Response(null, {
      status: 429,
      headers: { 'retry-after': String(quota.retryAfterSeconds) },
    });
  }

  await unsubscribe(tokenFrom(request));
  return new Response(null, { status: 200 });
}
