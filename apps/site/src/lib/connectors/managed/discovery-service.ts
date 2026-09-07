/**
 * Tenant-scoped managed connector discovery and private connection inventory.
 *
 * @module lib/connectors/managed/discovery-service
 */
import type { ComposioOperationClient } from '@dorkos/connector-providers/composio';
import {
  ManagedConnectorAccountListRequestSchema,
  ManagedConnectorAccountListResponseSchema,
  ManagedConnectorAccountResponseSchema,
  ManagedConnectorCatalogPageSchema,
  ManagedConnectorCatalogRequestSchema,
  ManagedConnectorOperationPageRequestSchema,
  ManagedConnectorOperationPageResponseSchema,
  ManagedConnectorToolkitVersionRequestSchema,
  ManagedConnectorToolkitVersionResponseSchema,
  type ManagedConnectorAccount,
} from '@dorkos/shared/connector-managed-discovery-schemas';
import type { ConnectorProviderInstanceId } from '@dorkos/shared/connector-schemas';
import { and, asc, eq, gt } from 'drizzle-orm';

import { schema } from '@/db/client';
import type { ManagedConnectorDatabase, ManagedConnectorPrincipal } from './authority-service';
import { HOSTED_COMPOSIO_PROVIDER_INSTANCE_ID } from './request-context';
import { managedCapabilityAvailability, type ManagedConnectorConfig } from './config';

/** Convert one private row to the strict site-owned account wire. */
export function managedAccountFromRow(
  row: typeof schema.managedConnectorConnection.$inferSelect
): ManagedConnectorAccount {
  return {
    managedConnectionId: row.id,
    toolkit: row.toolkit,
    label: row.label,
    authenticationStatus: row.authenticationStatus,
    lifecycle: row.lifecycle,
    bindingGeneration: row.bindingGeneration,
    materialGeneration: row.materialGeneration,
  };
}

/** Read one bounded account-free toolkit page from the hosted SDK. */
export async function listManagedConnectorCatalog(input: {
  operations: ComposioOperationClient;
  config: ManagedConnectorConfig;
  rawRequest: unknown;
  signal: AbortSignal;
}) {
  const request = ManagedConnectorCatalogRequestSchema.parse(input.rawRequest);
  const result = await input.operations.listToolkitPage({
    ...(request.query !== undefined && { query: request.query }),
    ...(request.cursor !== undefined && { cursor: request.cursor }),
    limit: request.limit,
    signal: input.signal,
  });
  return ManagedConnectorCatalogPageSchema.parse({
    version: 1,
    toolkits: result.toolkits.map((toolkit) => {
      const availability = managedCapabilityAvailability(
        input.config,
        'authentication',
        toolkit.slug
      );
      return {
        ...toolkit,
        authentication:
          availability.status === 'available'
            ? { status: 'available' as const }
            : { status: 'unsupported' as const, reason: availability.reason },
      };
    }),
    ...(result.nextCursor !== undefined && { nextCursor: result.nextCursor }),
    truncated: result.truncated,
  });
}

/** Resolve one trusted exact toolkit version through the hosted SDK. */
export async function resolveManagedToolkitVersion(input: {
  operations: ComposioOperationClient;
  rawRequest: unknown;
  signal: AbortSignal;
}) {
  const request = ManagedConnectorToolkitVersionRequestSchema.parse(input.rawRequest);
  const result = await input.operations.resolveToolkitVersion(request.toolkit, input.signal);
  return ManagedConnectorToolkitVersionResponseSchema.parse({ version: 1, ...result });
}

/** Discover and persist one immutable exact-version operation page. */
export async function listManagedOperationSchemas(input: {
  db: ManagedConnectorDatabase;
  principal: ManagedConnectorPrincipal;
  operations: ComposioOperationClient;
  rawRequest: unknown;
  signal: AbortSignal;
}) {
  const request = ManagedConnectorOperationPageRequestSchema.parse(input.rawRequest);
  const result = await input.operations.listOperationSchemas(
    HOSTED_COMPOSIO_PROVIDER_INSTANCE_ID as ConnectorProviderInstanceId,
    {
      toolkit: request.toolkit,
      toolkitVersion: request.toolkitVersion,
      ...(request.cursor !== undefined && { cursor: request.cursor }),
      limit: request.limit,
      signal: input.signal,
    }
  );
  for (const operation of result.page.operations) {
    if (
      operation.providerInstanceId !== HOSTED_COMPOSIO_PROVIDER_INSTANCE_ID ||
      operation.toolkit !== request.toolkit ||
      operation.toolkitVersion !== request.toolkitVersion
    ) {
      throw new Error('Managed provider returned operation metadata for another request.');
    }
  }
  const operations = await input.db.transaction(async (tx) => {
    // Serialize head replacement with other discovery pages for this provider.
    await tx
      .select({ id: schema.managedConnectorProvider.id })
      .from(schema.managedConnectorProvider)
      .where(
        and(
          eq(schema.managedConnectorProvider.tenantId, input.principal.tenantId),
          eq(schema.managedConnectorProvider.id, HOSTED_COMPOSIO_PROVIDER_INSTANCE_ID)
        )
      )
      .for('update');
    const discovered = [];
    for (const operation of result.page.operations) {
      const [current] = await tx
        .select()
        .from(schema.managedConnectorOperationRevision)
        .where(
          and(
            eq(schema.managedConnectorOperationRevision.tenantId, input.principal.tenantId),
            eq(
              schema.managedConnectorOperationRevision.providerInstanceId,
              HOSTED_COMPOSIO_PROVIDER_INSTANCE_ID
            ),
            eq(schema.managedConnectorOperationRevision.toolkit, operation.toolkit),
            eq(schema.managedConnectorOperationRevision.operationSlug, operation.operationSlug),
            eq(schema.managedConnectorOperationRevision.toolkitVersion, operation.toolkitVersion),
            eq(schema.managedConnectorOperationRevision.schemaHash, operation.schemaHash),
            eq(schema.managedConnectorOperationRevision.current, true)
          )
        )
        .limit(1);
      if (current?.classification === operation.capabilityClassification) {
        discovered.push({ ...operation, hostedRevisionId: current.id });
        continue;
      }
      if (current) {
        await tx
          .update(schema.managedConnectorOperationRevision)
          .set({ current: false })
          .where(
            and(
              eq(schema.managedConnectorOperationRevision.tenantId, input.principal.tenantId),
              eq(schema.managedConnectorOperationRevision.id, current.id)
            )
          );
        await tx
          .update(schema.managedConnectorGrant)
          .set({ active: false, revokedAt: new Date() })
          .where(
            and(
              eq(schema.managedConnectorGrant.tenantId, input.principal.tenantId),
              eq(schema.managedConnectorGrant.operationRevisionId, current.id)
            )
          );
      }
      const [revision] = await tx
        .insert(schema.managedConnectorOperationRevision)
        .values({
          tenantId: input.principal.tenantId,
          providerInstanceId: HOSTED_COMPOSIO_PROVIDER_INSTANCE_ID,
          toolkit: operation.toolkit,
          operationSlug: operation.operationSlug,
          toolkitVersion: operation.toolkitVersion,
          schemaHash: operation.schemaHash,
          classification: operation.capabilityClassification,
          inputSchema: operation.inputSchema,
        })
        .returning();
      discovered.push({ ...operation, hostedRevisionId: revision.id });
    }
    return discovered;
  });
  return ManagedConnectorOperationPageResponseSchema.parse({
    version: 1,
    status: 'ok',
    operations,
    ...(result.page.nextCursor !== undefined && { nextCursor: result.page.nextCursor }),
    truncated: result.page.truncated,
  });
}

/** List one bounded page of connections owned by the verified originating instance. */
export async function listManagedConnections(
  db: ManagedConnectorDatabase,
  principal: ManagedConnectorPrincipal,
  rawRequest: unknown
) {
  const request = ManagedConnectorAccountListRequestSchema.parse(rawRequest);
  const rows = await db
    .select()
    .from(schema.managedConnectorConnection)
    .where(
      and(
        eq(schema.managedConnectorConnection.tenantId, principal.tenantId),
        eq(schema.managedConnectorConnection.originatingInstanceId, principal.instanceId),
        ...(request.toolkit !== undefined
          ? [eq(schema.managedConnectorConnection.toolkit, request.toolkit)]
          : []),
        ...(request.cursor !== undefined
          ? [gt(schema.managedConnectorConnection.id, request.cursor)]
          : [])
      )
    )
    .orderBy(asc(schema.managedConnectorConnection.id))
    .limit(request.limit + 1);
  const hasMore = rows.length > request.limit;
  const visible = rows.slice(0, request.limit);
  return ManagedConnectorAccountListResponseSchema.parse({
    version: 1,
    accounts: visible.map(managedAccountFromRow),
    ...(hasMore && visible.length > 0 ? { nextCursor: visible[visible.length - 1]!.id } : {}),
  });
}

/** Read one exact connection owned by the verified originating instance. */
export async function getManagedConnection(
  db: ManagedConnectorDatabase,
  principal: ManagedConnectorPrincipal,
  managedConnectionId: string
) {
  const [row] = await db
    .select()
    .from(schema.managedConnectorConnection)
    .where(
      and(
        eq(schema.managedConnectorConnection.tenantId, principal.tenantId),
        eq(schema.managedConnectorConnection.originatingInstanceId, principal.instanceId),
        eq(schema.managedConnectorConnection.id, managedConnectionId)
      )
    )
    .limit(1);
  return row
    ? ManagedConnectorAccountResponseSchema.parse({
        version: 1,
        account: managedAccountFromRow(row),
      })
    : null;
}
