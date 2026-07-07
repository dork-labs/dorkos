/**
 * `GET /api/newsletter/confirm?token=` — completes the newsletter double
 * opt-in (ADR 260707-025214).
 *
 * The link the confirmation email points at. Confirms the token, mirrors the
 * address into the Resend Audience, then redirects to the friendly
 * `/newsletter/confirmed` result page (with `?status=invalid` for an
 * expired/unknown token). Node runtime for `node:crypto` token hashing.
 *
 * @module app/api/newsletter/confirm
 */
import { confirm } from '@/lib/newsletter/service';

export const runtime = 'nodejs';

/** Handle the confirm-link GET and redirect to the result page. */
export async function GET(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get('token') ?? '';
  const result = await confirm(token);
  const dest = new URL('/newsletter/confirmed', request.url);
  if (result === 'invalid') dest.searchParams.set('status', 'invalid');
  return Response.redirect(dest, 303);
}
