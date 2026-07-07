/**
 * `GET /api/cron/cleanup` — the scheduled-cleanup vehicle for the DorkOS account
 * cloud identity core (DOR-194).
 *
 * Invoked by Vercel Cron on the schedule in `apps/site/vercel.json`. Vercel Cron
 * issues a `GET` and, when `CRON_SECRET` is set in the deployment, sends it as
 * `Authorization: Bearer <CRON_SECRET>`; this handler requires that header to
 * match. When `CRON_SECRET` is unset the route refuses to run (401), so it can
 * never be triggered unauthenticated.
 *
 * On success it runs {@link runCleanup} against the production Better Auth
 * singleton and returns the per-category removal counts as JSON.
 *
 * @module app/api/cron/cleanup
 */
import { env } from '@/env';
import { getAuth } from '@/lib/auth';
import { runCleanup } from '@/lib/cleanup-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Extract a Bearer token from an Authorization header, if present. */
function readBearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** Run the scheduled cleanup pass; authorized by the `CRON_SECRET` Bearer token. */
export async function GET(request: Request): Promise<Response> {
  // Fail closed: no configured secret means no authenticated caller can exist, so
  // the job must not run (rather than run wide open).
  const secret = env.CRON_SECRET;
  const presented = readBearer(request.headers.get('authorization'));
  if (!secret || !presented || presented !== secret) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const counts = await runCleanup(getAuth(), {});
  return Response.json({ ok: true, counts }, { status: 200 });
}
