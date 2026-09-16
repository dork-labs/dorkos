/**
 * `GET /api/cron/instance-expiry` — expire unverified users, spent device codes
 * and stale instances (DOR-194).
 *
 * One of the two routes the old combined `/api/cron/cleanup` split into; the
 * other is `/api/cron/event-retention`. They were split along the same line the
 * schema is: this route sweeps account and device-link state, that one sweeps
 * managed-connector event rows. Separate routes mean one of them failing or
 * timing out no longer takes the other's work with it — the combined route ran
 * account cleanup first and then returned 500 for the whole invocation when the
 * event sweep threw, which read as "cleanup failed" in the cron log.
 *
 * Invoked by Vercel Cron on the schedule in `apps/site/vercel.json` and
 * authorized by the `CRON_SECRET` Bearer token (see `@/lib/cron/auth`).
 *
 * @module app/api/cron/instance-expiry
 */
import { getAuth } from '@/lib/auth';
import { runCleanup } from '@/lib/cleanup-service';
import { rejectUnauthorizedCron } from '@/lib/cron/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Run the account and instance expiry pass; authorized by `CRON_SECRET`. */
export async function GET(request: Request): Promise<Response> {
  const unauthorized = rejectUnauthorizedCron(request);
  if (unauthorized) return unauthorized;

  const counts = await runCleanup(getAuth(), {});
  return Response.json({ ok: true, counts }, { status: 200 });
}
