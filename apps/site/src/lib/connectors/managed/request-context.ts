/**
 * Shared hosted connector route authentication and provider composition.
 *
 * @module lib/connectors/managed/request-context
 */
import { createComposioHostedClients } from '@dorkos/connector-providers/composio';

import { getDb } from '@/db/client';
import { getAuth } from '@/lib/auth';
import {
  verifyManagedConnectorInstance,
  type ManagedConnectorPermission,
} from '@/lib/instance-service';
import {
  registerManagedProvider,
  resolveConnectorTenant,
  type ManagedConnectorPrincipal,
} from './authority-service';
import { managedCapabilityAvailability, readManagedConnectorConfig } from './config';

/** Stable hosted provider instance id mirrored by linked local instances. */
export const HOSTED_COMPOSIO_PROVIDER_INSTANCE_ID = 'managed:composio';

/** Authenticated instance identity without dependency on provider availability. */
export async function resolveManagedConnectorPrincipal(
  request: Request,
  permission: ManagedConnectorPermission
) {
  const auth = getAuth();
  const verified = await verifyManagedConnectorInstance(auth, request, permission);
  if (verified.status !== 'ok') return verified;
  const db = getDb();
  const tenant = await resolveConnectorTenant(db, verified.ownerId);
  return {
    status: 'ok' as const,
    db,
    principal: {
      ownerId: verified.ownerId,
      instanceId: verified.instanceId,
      tenantId: tenant.id,
      keyId: verified.keyId,
    },
  };
}

/** Fully verified request context with clients built from one exact material read. */
export type ManagedConnectorRequestContext =
  | { status: 'unauthorized' | 'permission_upgrade_required' | 'unavailable'; reason?: string }
  | {
      status: 'ok';
      principal: ManagedConnectorPrincipal;
      providerUserId: string;
      materialGeneration: number;
      executionConfigDigest: string;
      db: ReturnType<typeof getDb>;
      operations: ReturnType<typeof createComposioHostedClients>['operations'];
      accounts: ReturnType<typeof createComposioHostedClients>['accounts'];
      config: ReturnType<typeof readManagedConnectorConfig>;
      verifyLiveInstance: () => Promise<boolean>;
    };

/** Resolve and revalidate one managed route without trusting request selectors. */
export async function resolveManagedConnectorRequest(
  request: Request,
  permission: ManagedConnectorPermission
): Promise<ManagedConnectorRequestContext> {
  let config: ReturnType<typeof readManagedConnectorConfig>;
  try {
    config = readManagedConnectorConfig();
  } catch {
    return { status: 'unavailable', reason: 'Managed connector configuration is invalid.' };
  }
  const capability = managedCapabilityAvailability(
    config,
    permission === 'authority' ? 'catalog' : permission === 'execute' ? 'execution' : 'catalog'
  );
  if (capability.status === 'unavailable') {
    return { status: 'unavailable', reason: capability.reason };
  }
  const auth = getAuth();
  const verified = await verifyManagedConnectorInstance(auth, request, permission);
  if (verified.status !== 'ok') return verified;
  const db = getDb();
  const tenant = await resolveConnectorTenant(db, verified.ownerId);
  const clients = createComposioHostedClients({
    apiKey: config.projectApiKey!,
    serverUserId: tenant.providerUserId,
    authConfigByToolkit: config.authConfigByToolkit,
    ...(config.apiOrigin && { baseUrl: config.apiOrigin }),
  });
  const materialGeneration = await registerManagedProvider(db, {
    tenantId: tenant.id,
    providerInstanceId: HOSTED_COMPOSIO_PROVIDER_INSTANCE_ID,
    configurationDigest: clients.executionConfigDigest,
  });
  const principal = {
    ownerId: verified.ownerId,
    instanceId: verified.instanceId,
    tenantId: tenant.id,
    keyId: verified.keyId,
  };
  return {
    status: 'ok',
    principal,
    providerUserId: tenant.providerUserId,
    materialGeneration,
    executionConfigDigest: clients.executionConfigDigest,
    db,
    operations: clients.operations,
    accounts: clients.accounts,
    config,
    verifyLiveInstance: async () => {
      const current = await verifyManagedConnectorInstance(auth, request, permission);
      return (
        current.status === 'ok' &&
        current.ownerId === principal.ownerId &&
        current.instanceId === principal.instanceId &&
        current.keyId === principal.keyId
      );
    },
  };
}

/** Convert a safe route-context refusal into the exact hosted wire response. */
export function managedContextFailure(
  context: Exclude<ManagedConnectorRequestContext, { status: 'ok' }>
): Response {
  if (context.status === 'permission_upgrade_required') {
    return Response.json({ error: 'permission_upgrade_required' }, { status: 403 });
  }
  if (context.status === 'unavailable') {
    return Response.json(
      { error: 'managed_connectors_unavailable', reason: context.reason },
      { status: 503 }
    );
  }
  return Response.json({ error: 'unauthorized' }, { status: 401 });
}
