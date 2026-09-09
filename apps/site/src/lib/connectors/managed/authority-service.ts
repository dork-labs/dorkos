/**
 * Durable tenant-scoped managed connector authority synchronization.
 *
 * @module lib/connectors/managed/authority-service
 */
import { createHash } from 'node:crypto';
import type { ConnectorEventCapability } from '@dorkos/shared/connector-events';
import { applyManagedEventAuthorityCommand } from './event-authority-service';
import type { ManagedEventCapacityPolicy } from './event-capacity-service';
import {
  ComposioManagedAccountError,
  type ComposioManagedAccountClient,
} from '@dorkos/connector-providers/composio';
import {
  MANAGED_CONNECTOR_AUTHORITY_PERMISSIONS,
  ManagedConnectorAuthorityCommandSchema,
  type ManagedConnectorAuthorityCommandStatus,
} from '@dorkos/shared/connector-managed-schemas';
import { stableStringify } from '@dorkos/shared/capabilities';
import { and, desc, eq, exists, gt, isNull, lte, or, sql } from 'drizzle-orm';

import { schema } from '@/db/client';
import type { getTransactionDb } from '@/db/transaction-client';

/** Site database surface used by the managed service. */
export type ManagedConnectorDatabase = ReturnType<typeof getTransactionDb>;

/** Verified tenant/instance identity supplied by the route boundary. */
export interface ManagedConnectorPrincipal {
  ownerId: string;
  instanceId: string;
  tenantId: string;
  keyId: string;
}

/** Fail-closed authority error when the linked instance changes before commit. */
export class ManagedAuthorityUnauthorizedError extends Error {
  constructor() {
    super('Managed connector authority is unavailable.');
    this.name = 'ManagedAuthorityUnauthorizedError';
  }
}

/** Safe provider failure while a durable lifecycle command remains retryable. */
export class ManagedAuthorityProviderUnavailableError extends Error {
  constructor() {
    super('Managed connector provider is unavailable.');
    this.name = 'ManagedAuthorityProviderUnavailableError';
  }
}

/** Exact provider material required for lifecycle health and cleanup work. */
export interface ManagedAuthorityProviderContext {
  events?: ConnectorEventCapability;
  accounts: Pick<ComposioManagedAccountClient, 'getAccount' | 'deleteAccount'>;
  providerUserId: string;
  materialGeneration: number;
  executionConfigDigest: string;
  signal: AbortSignal;
}

/** Lock the exact live instance key before committing any managed authority change. */
export async function lockLiveAuthorityPrincipal(
  tx: Parameters<Parameters<ManagedConnectorDatabase['transaction']>[0]>[0],
  principal: ManagedConnectorPrincipal
): Promise<void> {
  const now = new Date();
  const [live] = await tx
    .select({ instanceId: schema.instance.id })
    .from(schema.instance)
    .innerJoin(
      schema.apikey,
      and(
        eq(schema.apikey.id, principal.keyId),
        eq(schema.apikey.referenceId, principal.ownerId),
        eq(schema.apikey.enabled, true),
        or(isNull(schema.apikey.expiresAt), gt(schema.apikey.expiresAt, now)),
        sql`${schema.apikey.metadata}::jsonb @> ${JSON.stringify({ instanceId: principal.instanceId, scope: 'instance' })}::jsonb`,
        sql`${schema.apikey.permissions}::jsonb @> ${JSON.stringify(MANAGED_CONNECTOR_AUTHORITY_PERMISSIONS)}::jsonb`
      )
    )
    .where(
      and(
        eq(schema.instance.id, principal.instanceId),
        eq(schema.instance.userId, principal.ownerId),
        isNull(schema.instance.revokedAt)
      )
    )
    .for('update');
  if (!live) throw new ManagedAuthorityUnauthorizedError();
}

/** Hash a strict wire request without retaining its contents in an idempotency key. */
export function managedRequestHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

/** Load or atomically create the one random connector tenant for an owner. */
export async function resolveConnectorTenant(
  db: ManagedConnectorDatabase,
  ownerId: string
): Promise<{ id: string; ownerUserId: string; providerUserId: string }> {
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.connectorTenant)
      .values({ ownerUserId: ownerId })
      .onConflictDoNothing({ target: schema.connectorTenant.ownerUserId })
      .returning();
    if (created) {
      await tx.insert(schema.managedConnectorEventCapacity).values({ tenantId: created.id });
      return created;
    }
    const [existing] = await tx
      .select()
      .from(schema.connectorTenant)
      .where(eq(schema.connectorTenant.ownerUserId, ownerId))
      .limit(1);
    if (!existing) throw new Error('Connector tenant could not be resolved.');
    return existing;
  });
}

/**
 * Register the exact provider material generation. A changed digest closes all
 * tenant authority before the new generation is returned.
 */
export async function registerManagedProvider(
  db: ManagedConnectorDatabase,
  input: { tenantId: string; providerInstanceId: string; configurationDigest: string }
): Promise<number> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(schema.managedConnectorProvider)
      .where(
        and(
          eq(schema.managedConnectorProvider.tenantId, input.tenantId),
          eq(schema.managedConnectorProvider.id, input.providerInstanceId)
        )
      )
      .limit(1);
    if (!existing) {
      await tx.insert(schema.managedConnectorProvider).values({
        tenantId: input.tenantId,
        id: input.providerInstanceId,
        providerType: 'composio',
        configurationDigest: input.configurationDigest,
      });
      return 1;
    }
    if (existing.configurationDigest === input.configurationDigest && existing.enabled) {
      return existing.materialGeneration;
    }
    const nextGeneration = existing.materialGeneration + 1;
    const now = new Date();
    await tx
      .update(schema.managedConnectorProvider)
      .set({
        configurationDigest: input.configurationDigest,
        materialGeneration: nextGeneration,
        enabled: true,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.managedConnectorProvider.tenantId, input.tenantId),
          eq(schema.managedConnectorProvider.id, input.providerInstanceId)
        )
      );
    await tx
      .update(schema.managedConnectorConnection)
      .set({ lifecycle: 'paused', updatedAt: now })
      .where(
        and(
          eq(schema.managedConnectorConnection.tenantId, input.tenantId),
          eq(schema.managedConnectorConnection.providerInstanceId, input.providerInstanceId)
        )
      );
    await tx
      .update(schema.managedConnectorGrant)
      .set({ active: false, revokedAt: now })
      .where(
        and(
          eq(schema.managedConnectorGrant.tenantId, input.tenantId),
          exists(
            tx
              .select({ one: sql`1` })
              .from(schema.managedConnectorConnection)
              .where(
                and(
                  eq(
                    schema.managedConnectorConnection.tenantId,
                    schema.managedConnectorGrant.tenantId
                  ),
                  eq(
                    schema.managedConnectorConnection.id,
                    schema.managedConnectorGrant.connectionId
                  ),
                  eq(schema.managedConnectorConnection.providerInstanceId, input.providerInstanceId)
                )
              )
          )
        )
      );
    return nextGeneration;
  });
}

function statusOf(row: typeof schema.managedConnectorAuthorityCommand.$inferSelect) {
  const base = {
    version: 1 as const,
    commandId: row.commandId,
    managedConnectionId: row.connectionId,
    scopeVersion: row.scopeVersion,
  };
  if (row.state === 'pending') return { ...base, state: 'pending' as const };
  if (row.state === 'superseded') return { ...base, state: 'superseded' as const };
  if (row.state === 'rejected') {
    return {
      ...base,
      state: 'rejected' as const,
      rejectionCode: (row.rejectionCode ?? 'connection_unavailable') as
        | 'connection_unavailable'
        | 'revision_unavailable'
        | 'permission_upgrade_required'
        | 'scope_conflict',
    };
  }
  return {
    ...base,
    state: 'applied' as const,
    ...(row.appliedRevisionSetHash ? { appliedRevisionSetHash: row.appliedRevisionSetHash } : {}),
    ...(row.appliedEventScopeHash ? { appliedEventScopeHash: row.appliedEventScopeHash } : {}),
    externalCleanup: row.externalCleanup,
  };
}

/** Finish only the external binding captured by this still-current disconnect. */
async function finishDisconnectCleanup(
  db: ManagedConnectorDatabase,
  principal: ManagedConnectorPrincipal,
  command: Extract<
    ReturnType<typeof ManagedConnectorAuthorityCommandSchema.parse>,
    { kind: 'set_connection_lifecycle' }
  >,
  requestHash: string,
  binding: (typeof schema.managedConnectorAuthorityCommand.$inferSelect)['cleanupBinding'],
  previousStatus: ManagedConnectorAuthorityCommandStatus,
  provider?: ManagedAuthorityProviderContext
): Promise<{ status: ManagedConnectorAuthorityCommandStatus; conflict: boolean }> {
  const ownCommand = and(
    eq(schema.managedConnectorAuthorityCommand.tenantId, principal.tenantId),
    eq(schema.managedConnectorAuthorityCommand.instanceId, principal.instanceId),
    eq(schema.managedConnectorAuthorityCommand.commandId, command.commandId),
    eq(schema.managedConnectorAuthorityCommand.requestHash, requestHash),
    eq(schema.managedConnectorAuthorityCommand.state, 'applied')
  );
  const closedBinding = binding
    ? exists(
        db
          .select({ one: sql`1` })
          .from(schema.managedConnectorConnection)
          .where(
            and(
              eq(schema.managedConnectorConnection.tenantId, principal.tenantId),
              eq(schema.managedConnectorConnection.originatingInstanceId, principal.instanceId),
              eq(schema.managedConnectorConnection.id, command.managedConnectionId),
              eq(schema.managedConnectorConnection.lifecycle, 'disconnected'),
              eq(schema.managedConnectorConnection.lifecycleScopeVersion, command.scopeVersion),
              eq(schema.managedConnectorConnection.providerInstanceId, binding.providerInstanceId),
              eq(schema.managedConnectorConnection.providerUserId, binding.providerUserId),
              eq(schema.managedConnectorConnection.externalAccountRef, binding.externalAccountRef),
              eq(schema.managedConnectorConnection.bindingGeneration, binding.bindingGeneration),
              eq(schema.managedConnectorConnection.materialGeneration, binding.materialGeneration)
            )
          )
      )
    : sql`false`;
  const [superseded] = await db
    .update(schema.managedConnectorAuthorityCommand)
    .set({ state: 'superseded', updatedAt: new Date() })
    .where(and(ownCommand, sql`NOT (${closedBinding})`))
    .returning();
  if (superseded)
    return {
      status: statusOf(superseded) as ManagedConnectorAuthorityCommandStatus,
      conflict: false,
    };
  if (!provider || !binding) throw new ManagedAuthorityProviderUnavailableError();
  const now = new Date();
  // A lease prevents simultaneous HTTP retries from deleting the same binding.
  // This last database claim rechecks the closed scope after every preflight await.
  // An already-started provider deletion may finish; no database transaction can
  // make an external provider request atomic with a later reconnect.
  const [cleanupClaim] = await db
    .update(schema.managedConnectorAuthorityCommand)
    .set({ cleanupClaimedAt: now, externalCleanup: 'pending', updatedAt: now })
    .where(
      and(
        ownCommand,
        closedBinding,
        or(
          eq(schema.managedConnectorAuthorityCommand.externalCleanup, 'pending'),
          eq(schema.managedConnectorAuthorityCommand.externalCleanup, 'failed')
        ),
        or(
          isNull(schema.managedConnectorAuthorityCommand.cleanupClaimedAt),
          lte(
            schema.managedConnectorAuthorityCommand.cleanupClaimedAt,
            new Date(now.getTime() - 5 * 60_000)
          )
        ),
        exists(
          db
            .select({ one: sql`1` })
            .from(schema.managedConnectorProvider)
            .where(
              and(
                eq(schema.managedConnectorProvider.tenantId, principal.tenantId),
                eq(schema.managedConnectorProvider.id, binding.providerInstanceId),
                eq(schema.managedConnectorProvider.enabled, true),
                eq(schema.managedConnectorProvider.materialGeneration, provider.materialGeneration),
                eq(
                  schema.managedConnectorProvider.configurationDigest,
                  provider.executionConfigDigest
                )
              )
            )
        ),
        sql`${binding.materialGeneration} = ${provider.materialGeneration}`,
        sql`${binding.providerUserId} = ${provider.providerUserId}`
      )
    )
    .returning();
  if (!cleanupClaim) {
    // A concurrent claim or reconnect wins. Make a superseding binding terminal
    // even if it changed after the initial stale-command check.
    await db
      .update(schema.managedConnectorAuthorityCommand)
      .set({ state: 'superseded', updatedAt: new Date() })
      .where(and(ownCommand, sql`NOT (${closedBinding})`));
    const status = await getManagedAuthorityCommandStatus(db, principal, command.commandId);
    return { status: status ?? previousStatus, conflict: false };
  }
  let externalCleanup: 'complete' | 'failed' = 'complete';
  try {
    await provider.accounts.deleteAccount(binding.externalAccountRef, provider.signal);
  } catch {
    externalCleanup = 'failed';
  }
  const [updated] = await db
    .update(schema.managedConnectorAuthorityCommand)
    .set({ externalCleanup, cleanupClaimedAt: null, updatedAt: new Date() })
    .where(and(ownCommand, eq(schema.managedConnectorAuthorityCommand.cleanupClaimedAt, now)))
    .returning();
  return {
    status: updated
      ? (statusOf(updated) as ManagedConnectorAuthorityCommandStatus)
      : previousStatus,
    conflict: false,
  };
}

/** Apply one exact idempotent authority command beneath its verified tenant. */
export async function applyManagedAuthorityCommand(
  db: ManagedConnectorDatabase,
  principal: ManagedConnectorPrincipal,
  rawCommand: unknown,
  provider?: ManagedAuthorityProviderContext,
  eventPolicy?: ManagedEventCapacityPolicy
): Promise<{ status: ManagedConnectorAuthorityCommandStatus; conflict: boolean }> {
  const command = ManagedConnectorAuthorityCommandSchema.parse(rawCommand);
  if (command.kind === 'set_event_subscription')
    return applyManagedEventAuthorityCommand(db, principal, command, provider, eventPolicy);
  const requestHash = managedRequestHash(command);
  const claimed = await db.transaction(async (tx) => {
    await lockLiveAuthorityPrincipal(tx, principal);
    const [duplicate] = await tx
      .select()
      .from(schema.managedConnectorAuthorityCommand)
      .where(
        and(
          eq(schema.managedConnectorAuthorityCommand.tenantId, principal.tenantId),
          eq(schema.managedConnectorAuthorityCommand.instanceId, principal.instanceId),
          eq(schema.managedConnectorAuthorityCommand.commandId, command.commandId)
        )
      )
      .limit(1);
    if (duplicate) {
      return {
        status: statusOf(duplicate) as ManagedConnectorAuthorityCommandStatus,
        conflict: duplicate.requestHash !== requestHash,
        connection: null,
        cleanupBinding: duplicate.cleanupBinding,
      };
    }

    const [connection] = await tx
      .select()
      .from(schema.managedConnectorConnection)
      .where(
        and(
          eq(schema.managedConnectorConnection.tenantId, principal.tenantId),
          eq(schema.managedConnectorConnection.id, command.managedConnectionId),
          eq(schema.managedConnectorConnection.originatingInstanceId, principal.instanceId)
        )
      )
      .limit(1);
    const scopeKey =
      command.kind === 'replace_agent_grants' ? `agent:${command.agentId}` : 'lifecycle';
    const [latest] = await tx
      .select()
      .from(schema.managedConnectorAuthorityCommand)
      .where(
        and(
          eq(schema.managedConnectorAuthorityCommand.tenantId, principal.tenantId),
          eq(schema.managedConnectorAuthorityCommand.instanceId, principal.instanceId),
          eq(schema.managedConnectorAuthorityCommand.connectionId, command.managedConnectionId),
          eq(schema.managedConnectorAuthorityCommand.scopeKey, scopeKey)
        )
      )
      .orderBy(desc(schema.managedConnectorAuthorityCommand.scopeVersion))
      .limit(1);

    let state: 'pending' | 'applied' | 'rejected' | 'superseded' =
      command.kind === 'set_connection_lifecycle' && command.lifecycle === 'active'
        ? 'pending'
        : 'applied';
    let rejectionCode: string | null = null;
    let appliedRevisionSetHash: string | null = null;
    if (!connection) {
      state = 'rejected';
      rejectionCode = 'connection_unavailable';
    } else if (
      command.kind === 'set_connection_lifecycle' &&
      command.lifecycle === 'active' &&
      connection.lifecycle === 'disconnected'
    ) {
      state = 'rejected';
      rejectionCode = 'connection_unavailable';
    } else if (latest && latest.scopeVersion >= command.scopeVersion) {
      state = 'superseded';
    }

    let revisionRows: Array<typeof schema.managedConnectorOperationRevision.$inferSelect> = [];
    if ((state === 'applied' || state === 'pending') && command.kind === 'replace_agent_grants') {
      for (const revision of command.revisions) {
        const rows = await tx
          .select()
          .from(schema.managedConnectorOperationRevision)
          .where(
            and(
              eq(schema.managedConnectorOperationRevision.tenantId, principal.tenantId),
              eq(schema.managedConnectorOperationRevision.id, revision.hostedRevisionId),
              eq(schema.managedConnectorOperationRevision.current, true),
              eq(
                schema.managedConnectorOperationRevision.providerInstanceId,
                connection!.providerInstanceId
              ),
              eq(schema.managedConnectorOperationRevision.toolkit, connection!.toolkit),
              eq(schema.managedConnectorOperationRevision.operationSlug, revision.operationSlug),
              eq(schema.managedConnectorOperationRevision.toolkitVersion, revision.toolkitVersion),
              eq(schema.managedConnectorOperationRevision.schemaHash, revision.schemaHash)
            )
          )
          .limit(2);
        // Classification remains server-owned; only the exact current hosted
        // identity can be granted after an owner reviews a reclassification.
        if (rows.length !== 1) {
          state = 'rejected';
          rejectionCode = 'revision_unavailable';
          revisionRows = [];
          break;
        }
        revisionRows.push(rows[0]);
      }
      if (state === 'applied') {
        appliedRevisionSetHash = managedRequestHash(
          command.revisions
            .map((revision) => ({ ...revision }))
            .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)))
        );
      }
    }

    const now = new Date();
    if (state === 'applied' && command.kind === 'replace_agent_grants') {
      await tx
        .update(schema.managedConnectorGrant)
        .set({ active: false, revokedAt: now })
        .where(
          and(
            eq(schema.managedConnectorGrant.tenantId, principal.tenantId),
            eq(schema.managedConnectorGrant.instanceId, principal.instanceId),
            eq(schema.managedConnectorGrant.connectionId, command.managedConnectionId),
            eq(schema.managedConnectorGrant.agentId, command.agentId)
          )
        );
      if (revisionRows.length > 0) {
        for (const revision of revisionRows) {
          await tx
            .insert(schema.managedConnectorGrant)
            .values({
              tenantId: principal.tenantId,
              instanceId: principal.instanceId,
              connectionId: command.managedConnectionId,
              agentId: command.agentId,
              operationRevisionId: revision.id,
              scopeVersion: command.scopeVersion,
              active: true,
            })
            .onConflictDoUpdate({
              target: [
                schema.managedConnectorGrant.tenantId,
                schema.managedConnectorGrant.instanceId,
                schema.managedConnectorGrant.connectionId,
                schema.managedConnectorGrant.agentId,
                schema.managedConnectorGrant.operationRevisionId,
              ],
              set: { scopeVersion: command.scopeVersion, active: true, revokedAt: null },
            });
        }
      }
    }
    if (
      state === 'applied' &&
      command.kind === 'set_connection_lifecycle' &&
      command.lifecycle !== 'active'
    ) {
      await tx
        .update(schema.managedConnectorConnection)
        .set({
          lifecycle: command.lifecycle,
          lifecycleScopeVersion: command.scopeVersion,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.managedConnectorConnection.tenantId, principal.tenantId),
            eq(schema.managedConnectorConnection.id, command.managedConnectionId)
          )
        );
      if (command.lifecycle === 'disconnected') {
        await tx
          .update(schema.managedConnectorGrant)
          .set({ active: false, revokedAt: now })
          .where(
            and(
              eq(schema.managedConnectorGrant.tenantId, principal.tenantId),
              eq(schema.managedConnectorGrant.instanceId, principal.instanceId),
              eq(schema.managedConnectorGrant.connectionId, command.managedConnectionId)
            )
          );
      }
    }
    if (
      state === 'pending' &&
      command.kind === 'set_connection_lifecycle' &&
      command.lifecycle === 'active'
    ) {
      await tx
        .update(schema.managedConnectorConnection)
        .set({ lifecycleScopeVersion: command.scopeVersion, updatedAt: now })
        .where(
          and(
            eq(schema.managedConnectorConnection.tenantId, principal.tenantId),
            eq(schema.managedConnectorConnection.id, command.managedConnectionId),
            eq(schema.managedConnectorConnection.originatingInstanceId, principal.instanceId)
          )
        );
    }

    const [inserted] = await tx
      .insert(schema.managedConnectorAuthorityCommand)
      .values({
        tenantId: principal.tenantId,
        instanceId: principal.instanceId,
        commandId: command.commandId,
        requestHash,
        connectionId: command.managedConnectionId,
        kind: command.kind,
        agentId: command.kind === 'replace_agent_grants' ? command.agentId : null,
        scopeKey,
        scopeVersion: command.scopeVersion,
        requestPayload: command as unknown as Record<string, unknown>,
        state,
        rejectionCode,
        appliedRevisionSetHash,
        cleanupBinding:
          command.kind === 'set_connection_lifecycle' &&
          command.lifecycle === 'disconnected' &&
          connection
            ? {
                providerInstanceId: connection.providerInstanceId,
                providerUserId: connection.providerUserId,
                externalAccountRef: connection.externalAccountRef,
                bindingGeneration: connection.bindingGeneration,
                materialGeneration: connection.materialGeneration,
              }
            : null,
        externalCleanup:
          command.kind === 'set_connection_lifecycle' && command.lifecycle === 'disconnected'
            ? 'pending'
            : 'not_required',
      })
      .returning();
    return {
      status: statusOf(inserted) as ManagedConnectorAuthorityCommandStatus,
      conflict: false,
      connection,
      cleanupBinding: inserted.cleanupBinding,
    };
  });

  if (claimed.conflict || command.kind !== 'set_connection_lifecycle') {
    return { status: claimed.status, conflict: claimed.conflict };
  }
  const retryingCleanup =
    command.lifecycle === 'disconnected' &&
    claimed.status.state === 'applied' &&
    (claimed.status.externalCleanup === 'pending' || claimed.status.externalCleanup === 'failed');
  const retryingResume = command.lifecycle === 'active' && claimed.status.state === 'pending';
  if (!retryingCleanup && !retryingResume) {
    return { status: claimed.status, conflict: false };
  }
  if (command.lifecycle === 'disconnected') {
    return finishDisconnectCleanup(
      db,
      principal,
      command,
      requestHash,
      claimed.cleanupBinding,
      claimed.status,
      provider
    );
  }
  if (!provider) throw new ManagedAuthorityProviderUnavailableError();

  const connection =
    claimed.connection ??
    (
      await db
        .select()
        .from(schema.managedConnectorConnection)
        .where(
          and(
            eq(schema.managedConnectorConnection.tenantId, principal.tenantId),
            eq(schema.managedConnectorConnection.originatingInstanceId, principal.instanceId),
            eq(schema.managedConnectorConnection.id, command.managedConnectionId)
          )
        )
        .limit(1)
    )[0];
  if (!connection) return { status: claimed.status, conflict: false };

  let account: Awaited<ReturnType<ManagedAuthorityProviderContext['accounts']['getAccount']>>;
  try {
    account = await provider.accounts.getAccount(connection.externalAccountRef, provider.signal);
  } catch (error) {
    if (error instanceof ComposioManagedAccountError || error instanceof Error) {
      throw new ManagedAuthorityProviderUnavailableError();
    }
    throw error;
  }
  const accountMatches =
    account.connectedAccountId === connection.externalAccountRef &&
    account.providerUserId === provider.providerUserId &&
    account.toolkit === connection.toolkit &&
    account.authConfigId === connection.authConfigId &&
    account.status === 'ACTIVE';
  const [finished] = await db.transaction(async (tx) => {
    await lockLiveAuthorityPrincipal(tx, principal);
    const now = new Date();
    if (!accountMatches || connection.lifecycle === 'disconnected') {
      return tx
        .update(schema.managedConnectorAuthorityCommand)
        .set({ state: 'rejected', rejectionCode: 'connection_unavailable', updatedAt: now })
        .where(
          and(
            eq(schema.managedConnectorAuthorityCommand.tenantId, principal.tenantId),
            eq(schema.managedConnectorAuthorityCommand.instanceId, principal.instanceId),
            eq(schema.managedConnectorAuthorityCommand.commandId, command.commandId),
            eq(schema.managedConnectorAuthorityCommand.requestHash, requestHash),
            eq(schema.managedConnectorAuthorityCommand.state, 'pending')
          )
        )
        .returning();
    }
    const [liveConnection] = await tx
      .select({ id: schema.managedConnectorConnection.id })
      .from(schema.managedConnectorConnection)
      .innerJoin(
        schema.managedConnectorProvider,
        and(
          eq(schema.managedConnectorProvider.tenantId, schema.managedConnectorConnection.tenantId),
          eq(
            schema.managedConnectorProvider.id,
            schema.managedConnectorConnection.providerInstanceId
          ),
          eq(schema.managedConnectorProvider.enabled, true),
          eq(schema.managedConnectorProvider.materialGeneration, provider.materialGeneration),
          eq(schema.managedConnectorProvider.configurationDigest, provider.executionConfigDigest)
        )
      )
      .where(
        and(
          eq(schema.managedConnectorConnection.tenantId, principal.tenantId),
          eq(schema.managedConnectorConnection.originatingInstanceId, principal.instanceId),
          eq(schema.managedConnectorConnection.id, command.managedConnectionId),
          eq(schema.managedConnectorConnection.providerUserId, provider.providerUserId),
          eq(schema.managedConnectorConnection.externalAccountRef, connection.externalAccountRef),
          eq(schema.managedConnectorConnection.materialGeneration, provider.materialGeneration),
          eq(schema.managedConnectorConnection.lifecycleScopeVersion, command.scopeVersion)
        )
      )
      .for('update');
    if (!liveConnection) {
      return tx
        .update(schema.managedConnectorAuthorityCommand)
        .set({ state: 'superseded', updatedAt: now })
        .where(
          and(
            eq(schema.managedConnectorAuthorityCommand.tenantId, principal.tenantId),
            eq(schema.managedConnectorAuthorityCommand.instanceId, principal.instanceId),
            eq(schema.managedConnectorAuthorityCommand.commandId, command.commandId),
            eq(schema.managedConnectorAuthorityCommand.state, 'pending')
          )
        )
        .returning();
    }
    await tx
      .update(schema.managedConnectorConnection)
      .set({ lifecycle: 'active', authenticationStatus: 'active', updatedAt: now })
      .where(
        and(
          eq(schema.managedConnectorConnection.tenantId, principal.tenantId),
          eq(schema.managedConnectorConnection.id, command.managedConnectionId),
          eq(schema.managedConnectorConnection.lifecycleScopeVersion, command.scopeVersion)
        )
      );
    return tx
      .update(schema.managedConnectorAuthorityCommand)
      .set({ state: 'applied', updatedAt: now })
      .where(
        and(
          eq(schema.managedConnectorAuthorityCommand.tenantId, principal.tenantId),
          eq(schema.managedConnectorAuthorityCommand.instanceId, principal.instanceId),
          eq(schema.managedConnectorAuthorityCommand.commandId, command.commandId),
          eq(schema.managedConnectorAuthorityCommand.requestHash, requestHash),
          eq(schema.managedConnectorAuthorityCommand.state, 'pending')
        )
      )
      .returning();
  });
  return {
    status: finished
      ? (statusOf(finished) as ManagedConnectorAuthorityCommandStatus)
      : claimed.status,
    conflict: false,
  };
}

/** Read one command status only beneath its verified tenant and instance. */
export async function getManagedAuthorityCommandStatus(
  db: ManagedConnectorDatabase,
  principal: ManagedConnectorPrincipal,
  commandId: string
): Promise<ManagedConnectorAuthorityCommandStatus | null> {
  const [row] = await db
    .select()
    .from(schema.managedConnectorAuthorityCommand)
    .where(
      and(
        eq(schema.managedConnectorAuthorityCommand.tenantId, principal.tenantId),
        eq(schema.managedConnectorAuthorityCommand.instanceId, principal.instanceId),
        eq(schema.managedConnectorAuthorityCommand.commandId, commandId)
      )
    )
    .limit(1);
  return row ? (statusOf(row) as ManagedConnectorAuthorityCommandStatus) : null;
}
