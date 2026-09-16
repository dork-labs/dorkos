/**
 * Shared Bearer-token authorization for the site's Vercel Cron routes.
 *
 * Vercel Cron issues a `GET` and, when `CRON_SECRET` is set in the deployment,
 * sends it as `Authorization: Bearer <CRON_SECRET>`. Every cron route requires
 * that header to match, and **fails closed**: when `CRON_SECRET` is unset there
 * can be no authenticated caller, so the job must not run rather than run wide
 * open.
 *
 * This lives in one place because the scheduled work is split across more than
 * one route and the check must not drift between them.
 *
 * @module lib/cron/auth
 */
import { env } from '@/env';

/** Extract a Bearer token from an Authorization header, if present. */
function readBearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Check a cron request's Bearer token against `CRON_SECRET`.
 *
 * @param request - The incoming cron request.
 * @returns A 401 `Response` to return as-is, or `null` when the caller is authorized.
 */
export function rejectUnauthorizedCron(request: Request): Response | null {
  const secret = env.CRON_SECRET;
  const presented = readBearer(request.headers.get('authorization'));
  if (!secret || !presented || presented !== secret) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}
