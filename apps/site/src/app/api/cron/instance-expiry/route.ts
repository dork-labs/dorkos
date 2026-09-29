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
 * No longer on a Vercel Cron schedule (removed from `apps/site/vercel.json`
 * once DorkOS Cloud's own scheduler took over this sweep) — reachable only by
 * a direct, authorized call until DOR-2442 deletes the route. Authorized by
 * the `CRON_SECRET` Bearer token either way (see `@/lib/cron/auth`).
 *
 * @module app/api/cron/instance-expiry
 */
import { getAuth } from '@/lib/auth';
import { runCleanup } from '@/lib/cleanup-service';
import { env } from '@/env';
import { cloudAccountsForwarding } from '@/lib/cloud-accounts/forward';
import { rejectUnauthorizedCron } from '@/lib/cron/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Run the account and instance expiry pass; authorized by `CRON_SECRET`. */
export async function GET(request: Request): Promise<Response> {
  const unauthorized = rejectUnauthorizedCron(request);
  if (unauthorized) return unauthorized;

  // Once accounts are handed to the accounts service (DOR-2441), the account
  // and device-link rows this sweeps belong to that service, and it runs the
  // sweep itself. Answer 200 so the scheduler sees a healthy job, and touch
  // nothing.
  if (cloudAccountsForwarding(env.DORKOS_CLOUD_ACCOUNTS_ORIGIN)) {
    return Response.json({ ok: true, skipped: 'accounts-service' }, { status: 200 });
  }

  const counts = await runCleanup(getAuth(), {});
  return Response.json({ ok: true, counts }, { status: 200 });
}
