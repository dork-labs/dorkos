/** Signed-in owner handoff from DorkOS to the provider consent screen. */
import { getDb } from '@/db/client';
import { getAuth } from '@/lib/auth';
import {
  bindManagedAuthenticationBrowser,
  MANAGED_CONNECTOR_FLOW_COOKIE,
} from '@/lib/connectors/managed/authentication-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Bind the browser owner and redirect to the stored trusted provider URL. */
export async function GET(request: Request): Promise<Response> {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) {
    const returnTo = new URL(request.url).pathname + new URL(request.url).search;
    return Response.redirect(
      new URL(`/signin?returnTo=${encodeURIComponent(returnTo)}`, request.url),
      302
    );
  }
  const url = new URL(request.url);
  const flowId = url.searchParams.get('flow');
  const nonce = url.searchParams.get('nonce');
  if (!flowId || !nonce) return Response.json({ error: 'not_found' }, { status: 404 });
  const bound = await bindManagedAuthenticationBrowser({
    db: getDb(),
    ownerId: session.user.id,
    flowId,
    nonce,
  });
  if (!bound) return Response.json({ error: 'not_found' }, { status: 404 });
  return new Response(null, {
    status: 302,
    headers: {
      location: bound.redirectUrl,
      'set-cookie': `${MANAGED_CONNECTOR_FLOW_COOKIE}=${bound.cookieValue}; Path=/api/connectors/managed/callback; HttpOnly; SameSite=Lax; Max-Age=600${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
    },
  });
}
