/**
 * `POST /api/instances/revoke` — unlink a device-linked instance
 * (accounts-and-auth P2, task 2.3).
 *
 * Session-guarded: the signed-in DorkOS account may revoke only its own
 * instances. Revocation deletes the instance's owning API key (so its next
 * cloud call 401s and the local instance detects the unlink) and stamps
 * `instance.revokedAt`. Called by the `/account/instances` registry UI.
 *
 * @module app/api/instances/revoke
 */
import { getAuth } from '@/lib/auth';
import { getServerSession } from '@/lib/auth-session';
import { revokeInstance } from '@/lib/instance-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  return Response.json({ ok: true }, { status: 200 });
}
