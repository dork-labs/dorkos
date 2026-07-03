/**
 * `GET /api/instances/pending?user_code=<code>` — resolve a device user code for
 * the `/activate` approval screen (accounts-and-auth P2, task 2.3).
 *
 * Session-guarded: reading a pending device authorization claims it for the
 * signed-in account (RFC 8628 requires the code be bound to a verifying session
 * before approval) and returns the requesting instance's descriptor (name,
 * platform) plus its status so `/activate` can show who is asking before the
 * user approves or denies.
 *
 * @module app/api/instances/pending
 */
import { getAuth } from '@/lib/auth';
import { getServerSession } from '@/lib/auth-session';
import { getPendingInstance } from '@/lib/instance-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Look up (and claim) a device user code for the signed-in account. */
export async function GET(request: Request): Promise<Response> {
  const session = await getServerSession();
  if (!session) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const userCode = new URL(request.url).searchParams.get('user_code');
  if (!userCode) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }

  const pending = await getPendingInstance(getAuth(), {
    userCode,
    userId: session.user.id,
  });
  return Response.json(pending, { status: 200 });
}
