/**
 * `GET /api/cron/event-retention` — apply the managed-connector event retention
 * policy and recover interrupted subscription cleanups.
 *
 * The second of the two routes the old combined `/api/cron/cleanup` split into;
 * the first is `/api/cron/instance-expiry`. See that file for why they are
 * separate.
 *
 * Invoked by Vercel Cron on the schedule in `apps/site/vercel.json` and
 * authorized by the `CRON_SECRET` Bearer token (see `@/lib/cron/auth`).
 *
 * @module app/api/cron/event-retention
 */
import { getTransactionDb } from '@/db/transaction-client';
import { recoverManagedEventCleanup } from '@/lib/connectors/managed/event-cleanup-service';
import { sweepManagedConnectorEventRetention } from '@/lib/connectors/managed/event-delivery-service';
import { rejectUnauthorizedCron } from '@/lib/cron/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Run the event retention sweep; authorized by `CRON_SECRET`. */
export async function GET(request: Request): Promise<Response> {
  // Authorize first. The old combined route built its timeout before checking,
  // so every unauthorized request armed a 25s timer on its way to a 401.
  const unauthorized = rejectUnauthorizedCron(request);
  if (unauthorized) return unauthorized;

  const eventMaintenance = AbortSignal.any([request.signal, AbortSignal.timeout(25_000)]);
  try {
    const eventRetention = eventMaintenance.aborted
      ? { pages: 0, contentRowsCleared: 0, metadataRowsDeleted: 0, protectedBytesCleared: 0 }
      : await sweepManagedConnectorEventRetention(getTransactionDb(), {
          signal: eventMaintenance,
        });
    const eventSubscriptions = await recoverManagedEventCleanup(
      getTransactionDb(),
      eventMaintenance
    );
    return Response.json({ ok: true, eventRetention, eventSubscriptions }, { status: 200 });
  } catch {
    // Never surface the driver's message: it can carry connection details,
    // provider names or SQL parameter values.
    return Response.json(
      { ok: false, eventRetentionFailures: 1, error: 'event_cleanup_failed' },
      { status: 500 }
    );
  }
}
