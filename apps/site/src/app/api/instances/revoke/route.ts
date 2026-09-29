/**
 * `POST /api/instances/revoke` — unlink a device-linked instance
 * (accounts-and-auth P2, task 2.3).
 *
 * Session-guarded: the signed-in DorkOS account may revoke only its own
 * instances. Revocation deletes the instance's owning API key (so its next
 * cloud call 401s and the local instance detects the unlink) and stamps
 * `instance.revokedAt`. Then it ends the apps that machine connected through
 * the account: their connections close at once, and their sign-ins are ended
 * at the service as far as {@link REVOKE_CLEANUP_BUDGET_MS} allows. The
 * scheduled sweep finishes whatever that budget did not. Called by the
 * `/account/instances` registry UI.
 *
 * @module app/api/instances/revoke
 */
import { getTransactionDb } from '@/db/transaction-client';
import { getAuth } from '@/lib/auth';
import { getServerSession } from '@/lib/auth-session';
import { endRevokedInstanceConnections } from '@/lib/connectors/managed/instance-revocation/cleanup';
import { revokeInstance } from '@/lib/instance-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** How long a revoke waits on the service to end its apps' sign-ins before answering. */
const REVOKE_CLEANUP_BUDGET_MS = 15_000;

/** Revoke one of the signed-in account's linked instances. */
export async function POST(request: Request): Promise<Response> {
  const session = await getServerSession();
  if (!session) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: { instanceId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }
  const instanceId = typeof body.instanceId === 'string' ? body.instanceId : null;
  if (!instanceId) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }

  const result = await revokeInstance(getAuth(), { userId: session.user.id, instanceId });
  if (!result.ok) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  try {
    await endRevokedInstanceConnections(getTransactionDb(), instanceId, {
      signal: AbortSignal.timeout(REVOKE_CLEANUP_BUDGET_MS),
    });
  } catch {
    // The link is already revoked, which is what the person asked for. Anything
    // left open here is closed by the scheduled sweep, so this never fails the
    // revoke. Never log the error: driver messages can carry SQL values.
  }
  return Response.json({ ok: true }, { status: 200 });
}
