/**
 * `GET /api/account/export` — download the signed-in account's data as JSON
 * (GDPR Art. 20 portability / CCPA; cloud-account-management, DOR-187).
 *
 * Session-guarded: returns only the caller's own data (never another account's).
 * The response is an attachment so a browser downloads it. Secrets (password
 * hashes, OAuth tokens, API-key values) are stripped by {@link exportAccountData}.
 *
 * @module app/api/account/export
 */
import { exportAccountData } from '@/lib/account-service';
import { getAuth } from '@/lib/auth';
import { getServerSession } from '@/lib/auth-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Serve the signed-in account's portability export as a JSON download. */
export async function GET(): Promise<Response> {
  const session = await getServerSession();
  if (!session) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const data = await exportAccountData(getAuth(), session.user.id);
  if (!data) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  return new Response(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'content-disposition': 'attachment; filename="dorkos-account-export.json"',
    },
  });
}
