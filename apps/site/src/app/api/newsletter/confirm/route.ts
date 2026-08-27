/**
 * `GET /api/newsletter/confirm?token=` — completes the newsletter double
 * opt-in (ADR 260707-025214).
 *
 * The link the confirmation email points at. Confirms the token, mirrors the
 * address into the Resend Segment, then redirects to the friendly
 * `/newsletter/confirmed` result page (with `?status=invalid` for an
 * expired/unknown token). Node runtime for `node:crypto` token hashing.
 *
 * Confirming on GET is the newsletter norm (a plain email link), and it means
 * an email security scanner that pre-fetches links can auto-complete the
 * opt-in. That is an accepted trade-off here: double opt-in exists for
 * deliverability and consent, not hard anti-abuse, and confirmation is
 * idempotent and reversible (one-click unsubscribe). Revisit with a
 * click-to-confirm POST page if the anti-abuse guarantee ever needs teeth.
 *
 * The per-IP throttle (DOR-1586) is charged before the token is looked up. The
 * token already gates what a caller can *do* here; the throttle bounds what a
 * caller can *cost* — a loop guessing tokens spends a database read and a hash
 * per guess. Over the limit answers `429` with a `Retry-After`, and because a
 * person may be looking at this in a browser it answers in readable HTML rather
 * than JSON, matching the route's human-facing style.
 *
 * @module app/api/newsletter/confirm
 */
import { confirm } from '@/lib/newsletter/service';
import { consumeConfirmQuota } from '@/lib/newsletter/confirm-rate-limit';
import { tooManyRequestsPage } from '@/lib/rate-limit/too-many-requests-page';

export const runtime = 'nodejs';

/**
 * Handle the confirm-link GET and redirect to the result page. Returns `429`
 * as a readable page when this IP is over its limit.
 */
export async function GET(request: Request): Promise<Response> {
  const quota = consumeConfirmQuota(request);
  if (!quota.allowed) {
    return tooManyRequestsPage(
      'One moment',
      'You have opened this link a lot in a short time. Wait a minute, then open it again. Your subscription is unaffected.',
      quota.retryAfterSeconds
    );
  }

  const token = new URL(request.url).searchParams.get('token') ?? '';
  const result = await confirm(token);
  const dest = new URL('/newsletter/confirmed', request.url);
  if (result === 'invalid') dest.searchParams.set('status', 'invalid');
  return Response.redirect(dest, 303);
}
