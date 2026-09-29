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
import { and, asc, desc, eq, exists, gt, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';

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

/**
 * A revoked linked instance whose leftover connections the service ends on its
 * own, with no key and no request from the instance.
 *
 * It can only finish cleanup (delete a provider account or trigger that a
 * closed connection or subscription still owes). Every route that grants,
 * executes or reads takes a {@link ManagedConnectorPrincipal}, which this type
 * is not, so it can never authorize anything new.
 */
export interface RevokedInstanceCleanupPrincipal {
  revokedInstance: true;
  ownerId: string;
  instanceId: string;
  tenantId: string;
}

/** The authority a cleanup runs under: the live instance's key, or its revocation. */
export type ManagedCleanupPrincipal = ManagedConnectorPrincipal | RevokedInstanceCleanupPrincipal;

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

/**
 * Whether an account lookup failed because the service no longer has the
 * account (it answered 404), as opposed to failing for a reason that may pass.
 *
 * @param error - The error the account lookup threw.
 */
function isAccountGoneAtProvider(error: unknown): boolean {
  return (
    error instanceof ComposioManagedAccountError &&
    error.code === 'provider_rejected' &&
    error.status === 404
  );
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

/**
 * Lock the authority a cleanup runs under before it commits.
 *
 * A live principal must still hold its exact key ({@link lockLiveAuthorityPrincipal}).
 * A revoked principal must name an instance that is revoked and still belongs
 * to the same owner. Revocation is final (a relink creates a new instance), so
 * that authority never lapses once it holds.
 *
 * @param tx - The open transaction.
 * @param principal - The live or revoked cleanup authority.
 * @throws ManagedAuthorityUnauthorizedError when the authority no longer holds.
 */
export async function lockCleanupAuthority(
  tx: Parameters<Parameters<ManagedConnectorDatabase['transaction']>[0]>[0],
  principal: ManagedCleanupPrincipal
): Promise<void> {
  if (!('revokedInstance' in principal)) return lockLiveAuthorityPrincipal(tx, principal);
  const [revoked] = await tx
    .select({ id: schema.instance.id })
    .from(schema.instance)
    .where(
      and(
        eq(schema.instance.id, principal.instanceId),
        eq(schema.instance.userId, principal.ownerId),
        isNotNull(schema.instance.revokedAt)
      )
    )
    .for('update');
  if (!revoked) throw new ManagedAuthorityUnauthorizedError();
}

/**
 * The grant-row agent id that stands for every agent of the connection's owner
 * (ADR 260926-192625, DOR-2439).
 *
 * Only a `replace_every_agent_grants` command writes it and only an execution
 * that says `grantSubject: 'every_agent'` matches it. A named-agent command or
 * execution that presents it as an agent id is refused, so no agent can reach
 * the owner-wide rows by choosing its own name.
 */
export const EVERY_AGENT_GRANT_ROW = '*';

/**
 * The grant-row agent id one execution must match, or null when the request
 * cannot be authorized at all.
 *
 * @param request - The execution's claimed agent and grant subject.
 */
export function grantRowAgentId(request: {
  agentId: string;
  grantSubject?: 'agent' | 'every_agent';
}): string | null {
  if (request.grantSubject === 'every_agent') return EVERY_AGENT_GRANT_ROW;
  return request.agentId === EVERY_AGENT_GRANT_ROW ? null : request.agentId;
}

/** The authority scope one command advances. */
function authorityScopeKey(
  command: Exclude<
    ReturnType<typeof ManagedConnectorAuthorityCommandSchema.parse>,
    { kind: 'set_event_subscription' }
  >
): string {
  if (command.kind === 'replace_agent_grants') return `agent:${command.agentId}`;
  if (command.kind === 'replace_every_agent_grants') return 'every_agent';
  return 'lifecycle';
}

/** Hash a strict wire request without retaining its contents in an idempotency key. */
export function managedRequestHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

/**
 * Load the owner's connector tenant, creating it on first use.
 *
 * The owner index on `connector_tenant` may not be unique, so this never leans
 * on it: an `ON CONFLICT` naming a non-unique index fails every call. A
 * transaction-scoped advisory lock per owner serializes first requests instead,
 * so concurrent callers create one tenant between them. Should several rows
 * exist for one owner anyway, every caller picks the same one: the oldest, with
 * the id breaking a tie.
 */
export async function resolveConnectorTenant(
  db: ManagedConnectorDatabase,
  ownerId: string
): Promise<{ id: string; ownerUserId: string; providerUserId: string }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`connector_tenant:${ownerId}`}))`);
    const [existing] = await tx
      .select()
      .from(schema.connectorTenant)
      .where(eq(schema.connectorTenant.ownerUserId, ownerId))
      .orderBy(asc(schema.connectorTenant.createdAt), asc(schema.connectorTenant.id))
      .limit(1);
    if (existing) return existing;
    const [created] = await tx
      .insert(schema.connectorTenant)
      .values({ ownerUserId: ownerId })
      .returning();
    if (!created) throw new Error('Connector tenant could not be resolved.');
    await tx.insert(schema.managedConnectorEventCapacity).values({ tenantId: created.id });
    return created;
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
    // A disconnected connection stays disconnected: pausing it would reopen it
    // and orphan the account deletion its disconnect still owes.
    await tx
      .update(schema.managedConnectorConnection)
      .set({ lifecycle: 'paused', updatedAt: now })
      .where(
        and(
          eq(schema.managedConnectorConnection.tenantId, input.tenantId),
          eq(schema.managedConnectorConnection.providerInstanceId, input.providerInstanceId),
          ne(schema.managedConnectorConnection.lifecycle, 'disconnected')
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

/**
 * Finish only the external binding captured by this still-current disconnect.
 *
 * Leased (one worker deletes a binding at a time), idempotent (a replay of a
 * finished cleanup changes nothing) and retried (a failure is recorded as
 * `failed` and claimed again later). It runs for a live instance's own
 * disconnect and for the disconnects the service writes when an instance is
 * revoked; neither case locks a key, because cleanup only removes access.
 *
 * @param db - The site database.
 * @param principal - The live or revoked instance the disconnect belongs to.
 * @param command - The exact disconnect command.
 * @param requestHash - The stored hash of that command.
 * @param binding - The provider binding captured when the disconnect applied.
 * @param previousStatus - The status to report when nothing changes.
 * @param provider - Provider material; without it the cleanup stays owed.
 * @throws ManagedAuthorityProviderUnavailableError when no provider material is available.
 */
export async function finishDisconnectCleanup(
  db: ManagedConnectorDatabase,
  principal: ManagedCleanupPrincipal,
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
  // A live instance's disconnect can race its own reconnect under new provider
  // material, so its cleanup deletes only while the binding's generation and
  // this deployment's configuration are still current. A revoked instance can
  // never reconnect: its cleanup only removes access, so it rebinds to whatever
  // material the deployment has now and still finishes. Holding it to the old
  // generation would strand it for good after a key rotation or a catalog change.
  const currentMaterial =
    'revokedInstance' in principal
      ? sql`true`
      : and(
          exists(
            db
              .select({ one: sql`1` })
              .from(schema.managedConnectorProvider)
              .where(
                and(
                  eq(schema.managedConnectorProvider.tenantId, principal.tenantId),
                  eq(schema.managedConnectorProvider.id, binding.providerInstanceId),
                  eq(schema.managedConnectorProvider.enabled, true),
                  eq(
                    schema.managedConnectorProvider.materialGeneration,
                    provider.materialGeneration
                  ),
                  eq(
                    schema.managedConnectorProvider.configurationDigest,
                    provider.executionConfigDigest
                  )
                )
              )
          ),
          sql`${binding.materialGeneration} = ${provider.materialGeneration}`
        );
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
        currentMaterial,
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
  if (externalCleanup === 'complete' && 'revokedInstance' in principal) {
    // The trace is advisory: a failed read must not hold the receipt's claim
    // until the lease expires after the account is already gone.
    await traceReboundDeletion(db, principal, binding, provider).catch(() => undefined);
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

/**
 * Leave an operator trace when a revoked instance's account was deleted under
 * provider material other than the one it was made with.
 *
 * Such a deletion is counted done, as it must be for the cleanup to finish,
 * but the provider answers "not found" (which the client treats as already
 * deleted) both when the account really is gone and when the deployment has
 * moved to a different provider project that never held it. Only a person can
 * tell those apart, so the line names the account for a check by hand. It
 * carries provider ids only, never a person's name, email or account id.
 */
async function traceReboundDeletion(
  db: ManagedConnectorDatabase,
  principal: RevokedInstanceCleanupPrincipal,
  binding: NonNullable<
    (typeof schema.managedConnectorAuthorityCommand.$inferSelect)['cleanupBinding']
  >,
  provider: ManagedAuthorityProviderContext
): Promise<void> {
  const [current] = await db
    .select({ configurationDigest: schema.managedConnectorProvider.configurationDigest })
    .from(schema.managedConnectorProvider)
    .where(
      and(
        eq(schema.managedConnectorProvider.tenantId, principal.tenantId),
        eq(schema.managedConnectorProvider.id, binding.providerInstanceId)
      )
    )
    .limit(1);
  const rebound =
    binding.materialGeneration !== provider.materialGeneration ||
    current?.configurationDigest !== provider.executionConfigDigest;
  if (!rebound) return;
  console.error(
    '[instance-revocation] Account deleted under changed provider settings; check by hand that it is gone',
    {
      providerInstanceId: binding.providerInstanceId,
      providerUserId: binding.providerUserId,
      externalAccountRef: binding.externalAccountRef,
      boundGeneration: binding.materialGeneration,
      currentGeneration: provider.materialGeneration,
    }
  );
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
    const scopeKey = authorityScopeKey(command);
    const isGrantCommand =
      command.kind === 'replace_agent_grants' || command.kind === 'replace_every_agent_grants';
    const grantsAgentId =
      command.kind === 'replace_agent_grants'
        ? command.agentId
        : command.kind === 'replace_every_agent_grants'
          ? EVERY_AGENT_GRANT_ROW
          : null;
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
    } else if (
      command.kind === 'replace_agent_grants' &&
      command.agentId === EVERY_AGENT_GRANT_ROW
    ) {
      // A named agent can never stand for every agent.
      state = 'rejected';
      rejectionCode = 'scope_conflict';
    } else if (latest && latest.scopeVersion >= command.scopeVersion) {
      state = 'superseded';
    }

    let revisionRows: Array<typeof schema.managedConnectorOperationRevision.$inferSelect> = [];
    if ((state === 'applied' || state === 'pending') && isGrantCommand && grantsAgentId !== null) {
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
    if (state === 'applied' && isGrantCommand && grantsAgentId !== null) {
      await tx
        .update(schema.managedConnectorGrant)
        .set({ active: false, revokedAt: now })
        .where(
          and(
            eq(schema.managedConnectorGrant.tenantId, principal.tenantId),
            eq(schema.managedConnectorGrant.instanceId, principal.instanceId),
            eq(schema.managedConnectorGrant.connectionId, command.managedConnectionId),
            eq(schema.managedConnectorGrant.agentId, grantsAgentId)
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
              agentId: grantsAgentId,
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

  let account: Awaited<
    ReturnType<ManagedAuthorityProviderContext['accounts']['getAccount']>
  > | null;
  try {
    account = await provider.accounts.getAccount(connection.externalAccountRef, provider.signal);
  } catch (error) {
    // An account the service no longer has will never come back, so the resume
    // ends here as rejected. Every other failure may pass, so the command stays
    // pending and the linked instance's retry can finish it.
    if (isAccountGoneAtProvider(error)) account = null;
    else if (error instanceof Error) throw new ManagedAuthorityProviderUnavailableError();
    else throw error;
  }
  const accountMatches =
    account !== null &&
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

/**
 * Read one command status beneath its tenant and instance, for a live
 * instance's verified key or for a revoked instance's own cleanup.
 */
export async function getManagedAuthorityCommandStatus(
  db: ManagedConnectorDatabase,
  principal: ManagedCleanupPrincipal,
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
