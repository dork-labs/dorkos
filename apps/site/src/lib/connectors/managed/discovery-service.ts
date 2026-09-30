/**
 * Tenant-scoped managed connector discovery and private connection inventory.
 *
 * @module lib/connectors/managed/discovery-service
 */
import type { ComposioOperationClient } from '@dorkos/connector-providers/composio';
import {
  projectConnectorAuthentication,
  type ConnectorToolkit,
} from '@dorkos/shared/connector-provider';
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
  type ManagedConnectorOperation,
  type ManagedConnectorToolkit,
  type ManagedConnectorToolkitVersionResponse,
} from '@dorkos/shared/connector-managed-discovery-schemas';
import type {
  ConnectorOperationPage,
  ConnectorProviderInstanceId,
  ConnectorToolkitVersionResult,
  ConnectorUnsupportedResult,
} from '@dorkos/shared/connector-schemas';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { z } from 'zod';

import { schema } from '@/db/client';
import type { ManagedConnectorDatabase, ManagedConnectorPrincipal } from './authority-service';
import { HOSTED_COMPOSIO_PROVIDER_INSTANCE_ID } from './request-context';
import { managedCapabilityAvailability, type ManagedConnectorConfig } from './config';

/** A malformed managed-connector request: always the caller's fault, always 400. */
export class ManagedRequestShapeError extends Error {
  /** Wrap the request-shape parse failure as its cause. */
  constructor(cause: unknown) {
    super('Malformed managed-connector request.', { cause });
    this.name = 'ManagedRequestShapeError';
  }
}

/**
 * Parse the caller's request, tagging a failure as the caller's fault so a
 * route never confuses it with a failure to build its own answer.
 */
function parseRequestShape<T>(schema: z.ZodType<T>, rawRequest: unknown): T {
  try {
    return schema.parse(rawRequest);
  } catch (error) {
    throw new ManagedRequestShapeError(error);
  }
}

/**
 * Map one provider toolkit onto the strict wire field by field. A provider
 * toolkit carries more than the wire allows (its logo and description), and
 * a spread would forward those and fail the whole page.
 */
function toWireToolkit(toolkit: ConnectorToolkit): ManagedConnectorToolkit {
  const trimmed = toolkit.displayName.trim().slice(0, 200);
  return {
    slug: toolkit.slug,
    displayName: trimmed.length > 0 ? trimmed : toolkit.slug,
    authKind: toolkit.authKind,
    ...(toolkit.authenticationSetup !== undefined && {
      authenticationSetup: toolkit.authenticationSetup,
    }),
    ...(toolkit.authentication !== undefined && { authentication: toolkit.authentication }),
    ...(toolkit.maxAccountsPerUser !== undefined && {
      maxAccountsPerUser: toolkit.maxAccountsPerUser,
    }),
  };
}

/** Map one resolved toolkit version onto the strict wire field by field, capping its reason. */
function toWireToolkitVersion(
  result: ConnectorToolkitVersionResult | ConnectorUnsupportedResult
): ManagedConnectorToolkitVersionResponse {
  return result.status === 'unsupported'
    ? { version: 1, status: 'unsupported', reason: result.reason.slice(0, 1_000) }
    : {
        version: 1,
        status: 'ok',
        toolkit: result.toolkit,
        toolkitVersion: result.toolkitVersion,
      };
}

/** Map one discovered operation onto the strict wire field by field. */
function toWireOperation(
  operation: ConnectorOperationPage['operations'][number],
  hostedRevisionId: string
): ManagedConnectorOperation {
  return {
    hostedRevisionId,
    providerInstanceId: operation.providerInstanceId,
    toolkit: operation.toolkit,
    operationSlug: operation.operationSlug,
    toolkitVersion: operation.toolkitVersion,
    schemaHash: operation.schemaHash,
    capabilityClassification: operation.capabilityClassification,
    retryPolicy: operation.retryPolicy,
    // The provider's type is a plain record; the page's own wire parse checks
    // it is JSON before anything leaves this process.
    inputSchema: operation.inputSchema as ManagedConnectorOperation['inputSchema'],
    // displayName/important stay off the wire until every supported app
    // accepts them; providerRevisionRef is private upstream identity and never
    // leaves this process.
  };
}

function configuredAuthentication(
  config: ManagedConnectorConfig,
  toolkit: ConnectorToolkit,
  includeAuthenticationSetup: boolean
): ConnectorToolkit {
  if (!config.authConfigByToolkit[toolkit.slug]) return toolkit;
  const setup = toolkit.authenticationSetup;
  if (setup && setup.kind !== 'unsupported') {
    return { ...toolkit, authenticationSetup: { ...setup, source: 'configured' } };
  }
  if (setup?.scheme === 'OAUTH2') {
    return {
      ...toolkit,
      authKind: 'oauth2',
      authenticationSetup: {
        kind: 'oauth',
        source: 'configured',
        scheme: 'OAUTH2',
        requiresAccountFields: false,
      },
    };
  }
  if (!includeAuthenticationSetup) {
    const legacy = { ...toolkit };
    delete legacy.authenticationSetup;
    return legacy;
  }
  return {
    ...toolkit,
    authenticationSetup: {
      kind: 'unsupported',
      source: 'configured',
      ...(setup?.scheme && { scheme: setup.scheme }),
      requiresAccountFields: false,
    },
  };
}

function authenticationAvailability(config: ManagedConnectorConfig, toolkit: ConnectorToolkit) {
  const catalog = managedCapabilityAvailability(config, 'catalog');
  if (catalog.status === 'unavailable') return catalog;
  if (!config.callbackOrigin) {
    return {
      status: 'unavailable' as const,
      reason: 'Managed account sign-in is not configured yet.',
    };
  }
  if (config.authConfigByToolkit[toolkit.slug]) return { status: 'available' as const };
  if (!toolkit.authenticationSetup || toolkit.authenticationSetup.kind === 'unsupported') {
    const method = toolkit.authenticationSetup?.scheme;
    return {
      status: 'unavailable' as const,
      reason:
        method === 'OAUTH2'
          ? 'This service needs a custom OAuth setup before DorkOS can connect it.'
          : method
            ? `This service uses ${method}, which DorkOS does not support yet.`
            : 'Composio did not declare a supported sign-in method for this service.',
    };
  }
  return { status: 'available' as const };
}

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
  /** Only true after the route receives the exact supported metadata header. */
  includeAuthenticationSetup?: boolean;
  operations: ComposioOperationClient;
  config: ManagedConnectorConfig;
  rawRequest: unknown;
  signal: AbortSignal;
}) {
  const request = parseRequestShape(ManagedConnectorCatalogRequestSchema, input.rawRequest);
  const result = await input.operations.listToolkitPage({
    ...(request.query !== undefined && { query: request.query }),
    ...(request.cursor !== undefined && { cursor: request.cursor }),
    limit: request.limit,
    signal: input.signal,
  });
  return ManagedConnectorCatalogPageSchema.parse({
    version: 1,
    toolkits: result.toolkits.map((rawToolkit) => {
      const toolkit = configuredAuthentication(
        input.config,
        rawToolkit,
        input.includeAuthenticationSetup === true
      );
      const availability = authenticationAvailability(input.config, toolkit);
      return toWireToolkit(
        projectConnectorAuthentication(
          {
            ...toolkit,
            authentication:
              availability.status === 'available'
                ? { status: 'available' as const }
                : { status: 'unsupported' as const, reason: availability.reason },
          },
          input.includeAuthenticationSetup === true
        )
      );
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
  const request = parseRequestShape(ManagedConnectorToolkitVersionRequestSchema, input.rawRequest);
  const result = await input.operations.resolveToolkitVersion(request.toolkit, input.signal);
  return ManagedConnectorToolkitVersionResponseSchema.parse(toWireToolkitVersion(result));
}

/** Discover and persist one immutable exact-version operation page. */
export async function listManagedOperationSchemas(input: {
  db: ManagedConnectorDatabase;
  principal: ManagedConnectorPrincipal;
  operations: ComposioOperationClient;
  rawRequest: unknown;
  signal: AbortSignal;
}) {
  const request = parseRequestShape(ManagedConnectorOperationPageRequestSchema, input.rawRequest);
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
    const discovered: ManagedConnectorOperation[] = [];
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
        discovered.push(toWireOperation(operation, current.id));
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
      discovered.push(toWireOperation(operation, revision.id));
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
