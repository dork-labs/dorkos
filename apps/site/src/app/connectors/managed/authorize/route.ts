/** Signed-in owner handoff to OAuth consent or the hosted account-fields page. */
import { getTransactionDb } from '@/db/transaction-client';
import { getAuth } from '@/lib/auth';
import { MANAGED_CONNECTOR_FLOW_COOKIE } from '@/lib/connectors/managed/authentication-service';
import { createManagedAuthenticationOwnerService } from '@/lib/connectors/managed/authentication-owner-service';
import {
  MANAGED_AUTHENTICATION_FIELDS_COOKIE,
  MANAGED_AUTHENTICATION_FIELDS_PATH,
} from '@/lib/connectors/managed/authentication-owner-contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Bind the browser owner without accepting credential values or callback account selectors. */
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
  if (!flowId || !nonce || nonce.length > 128)
    return Response.json({ error: 'not_found' }, { status: 404 });
  try {
    const bound = await createManagedAuthenticationOwnerService(getTransactionDb()).authorize({
      ownerId: session.user.id,
      flowId,
      nonce,
      signal: request.signal,
    });
    if (!bound || bound.cookieMaxAgeSeconds <= 0)
      return Response.json({ error: 'not_found' }, { status: 404 });
    const oauth = bound.kind === 'oauth';
    return new Response(null, {
      status: 302,
      headers: {
        location: oauth ? bound.redirectUrl : MANAGED_AUTHENTICATION_FIELDS_PATH,
        'cache-control': 'private, no-store',
        'set-cookie': `${oauth ? MANAGED_CONNECTOR_FLOW_COOKIE : MANAGED_AUTHENTICATION_FIELDS_COOKIE}=${bound.cookieValue}; Path=${oauth ? '/api/connectors/managed/callback' : '/'}; HttpOnly; SameSite=${oauth ? 'Lax' : 'Strict'}; Max-Age=${bound.cookieMaxAgeSeconds}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
      },
    });
  } catch {
    return Response.json(
      { error: 'account_setup_unavailable' },
      { status: 503, headers: { 'cache-control': 'private, no-store' } }
    );
  }
}
