/** Fixed signed-in browser callback for managed provider account completion. */
import { createComposioHostedClients } from '@dorkos/connector-providers/composio';

import { getDb } from '@/db/client';
import { getAuth } from '@/lib/auth';
import {
  completeManagedAuthentication,
  ManagedAuthenticationFlowError,
  MANAGED_CONNECTOR_FLOW_COOKIE,
} from '@/lib/connectors/managed/authentication-service';
import {
  managedCapabilityAvailability,
  readManagedConnectorConfig,
} from '@/lib/connectors/managed/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}

/** Consume the local flow before redeeming the opaque provider session. */
export async function GET(request: Request): Promise<Response> {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const sessionUri = new URL(request.url).searchParams.get('session_uri');
  const flowCookie = cookieValue(request, MANAGED_CONNECTOR_FLOW_COOKIE);
  if (!sessionUri || sessionUri.length > 4_096 || !flowCookie) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }
  let config: ReturnType<typeof readManagedConnectorConfig>;
  try {
    config = readManagedConnectorConfig();
  } catch {
    return Response.json({ error: 'managed_connectors_unavailable' }, { status: 503 });
  }
  const availability = managedCapabilityAvailability(config, 'catalog');
  if (availability.status === 'unavailable' || !config.projectApiKey || !config.callbackOrigin) {
    return Response.json({ error: 'managed_connectors_unavailable' }, { status: 503 });
  }
  try {
    const result = await completeManagedAuthentication({
      db: getDb(),
      ownerId: session.user.id,
      cookieValue: flowCookie,
      sessionUri,
      createAccounts: (providerUserId) =>
        createComposioHostedClients({
          apiKey: config.projectApiKey!,
          serverUserId: providerUserId,
          authConfigByToolkit: config.authConfigByToolkit,
          ...(config.apiOrigin && { baseUrl: config.apiOrigin }),
        }),
      signal: request.signal,
    });
    return new Response(null, {
      status: 302,
      headers: {
        location: new URL(
          `/account/instances?connection=${encodeURIComponent(result.connectionId)}`,
          config.callbackOrigin
        ).toString(),
        'set-cookie': `${MANAGED_CONNECTOR_FLOW_COOKIE}=; Path=/api/connectors/managed/callback; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
      },
    });
  } catch (error) {
    if (error instanceof ManagedAuthenticationFlowError) {
      return Response.json({ error: error.code, reason: error.message }, { status: 403 });
    }
    throw error;
  }
}
