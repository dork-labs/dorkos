/**
 * Hosted managed connector execution and authoritative receipt accounting.
 *
 * @module lib/connectors/managed/execution-service
 */
import { randomUUID } from 'node:crypto';
import {
  ComposioManagedAccountError,
  type ComposioManagedAccountClient,
  type ComposioOperationClient,
} from '@dorkos/connector-providers/composio';
import {
  MANAGED_CONNECTOR_EXECUTION_PERMISSIONS,
  ManagedConnectorExecutionRequestSchema,
  type ManagedConnectorExecutionReceipt,
  type ManagedConnectorExecutionResponse,
} from '@dorkos/shared/connector-managed-schemas';
import type {
  ConnectorOperationRevision,
  ConnectorProviderExecuteResult,
} from '@dorkos/shared/connector-schemas';
import { and, eq, exists, gt, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';

import { schema } from '@/db/client';
import {
  managedRequestHash,
  type ManagedConnectorDatabase,
  type ManagedConnectorPrincipal,
} from './authority-service';

interface AuthorizedExecution {
  connection: typeof schema.managedConnectorConnection.$inferSelect;
  revision: typeof schema.managedConnectorOperationRevision.$inferSelect;
  provider: typeof schema.managedConnectorProvider.$inferSelect;
}

const EXECUTION_LEASE_MS = 60_000;
const ABANDONED_DISPATCH_MS = 5 * 60_000;

/** Conflict raised when an attempt id is replayed with another canonical request. */
export class ManagedExecutionConflictError extends Error {
  constructor() {
    super('The managed execution attempt id is already bound to another request.');
    this.name = 'ManagedExecutionConflictError';
  }
}

/** Fail-closed authority error returned before provider dispatch. */
export class ManagedExecutionUnauthorizedError extends Error {
  constructor() {
    super('Managed connector authority is unavailable.');
    this.name = 'ManagedExecutionUnauthorizedError';
  }
}

/** Safe provider-read failure before an execution can reach dispatch. */
export class ManagedExecutionProviderUnavailableError extends Error {
  constructor() {
    super('Managed connector provider is unavailable.');
    this.name = 'ManagedExecutionProviderUnavailableError';
  }
}

function operationFromRow(
  row: typeof schema.managedConnectorOperationRevision.$inferSelect
): ConnectorOperationRevision {
  return {
    id: row.id,
    providerInstanceId: row.providerInstanceId,
    toolkit: row.toolkit,
    operationSlug: row.operationSlug,
    toolkitVersion: row.toolkitVersion,
    schemaHash: row.schemaHash,
    capabilityClassification: row.classification,
    retryPolicy: 'never',
    inputSchema: row.inputSchema,
    discoveredAt: row.discoveredAt.toISOString(),
  } as ConnectorOperationRevision;
}

/** Convert one terminal hosted row into its immutable secret-free receipt. */
export function managedExecutionReceiptFromRow(
  row: typeof schema.managedConnectorExecutionAttempt.$inferSelect
): ManagedConnectorExecutionReceipt {
  if (!row.outcome) throw new Error('A pending execution does not have a receipt.');
  return {
    version: 1,
    receiptId: row.receiptId,
    logicalOperationId: row.logicalOperationId,
    attemptId: row.attemptId,
    attemptIndex: row.attemptIndex,
    outcome: row.outcome,
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    completedAt: row.completedAt?.toISOString() ?? null,
    recordedAt: row.recordedAt.toISOString(),
  };
}

async function loadAuthorizedExecution(
  db: ManagedConnectorDatabase,
  principal: ManagedConnectorPrincipal,
  request: ReturnType<typeof ManagedConnectorExecutionRequestSchema.parse>
): Promise<AuthorizedExecution | null> {
  const [connection] = await db
    .select()
    .from(schema.managedConnectorConnection)
    .where(
      and(
        eq(schema.managedConnectorConnection.tenantId, principal.tenantId),
        eq(schema.managedConnectorConnection.id, request.managedConnectionId),
        eq(schema.managedConnectorConnection.originatingInstanceId, principal.instanceId),
        eq(schema.managedConnectorConnection.lifecycle, 'active'),
        eq(schema.managedConnectorConnection.authenticationStatus, 'active')
      )
    )
    .limit(1);
  if (!connection) return null;
  const [provider] = await db
    .select()
    .from(schema.managedConnectorProvider)
    .where(
      and(
        eq(schema.managedConnectorProvider.tenantId, principal.tenantId),
        eq(schema.managedConnectorProvider.id, connection.providerInstanceId),
        eq(schema.managedConnectorProvider.enabled, true),
        eq(schema.managedConnectorProvider.materialGeneration, connection.materialGeneration)
      )
    )
    .limit(1);
  if (!provider) return null;
  const revisions = await db
    .select()
    .from(schema.managedConnectorOperationRevision)
    .where(
      and(
        eq(schema.managedConnectorOperationRevision.tenantId, principal.tenantId),
        eq(schema.managedConnectorOperationRevision.id, request.revision.hostedRevisionId),
        eq(schema.managedConnectorOperationRevision.current, true),
        eq(
          schema.managedConnectorOperationRevision.providerInstanceId,
          connection.providerInstanceId
        ),
        eq(schema.managedConnectorOperationRevision.toolkit, connection.toolkit),
        eq(schema.managedConnectorOperationRevision.operationSlug, request.revision.operationSlug),
        eq(
          schema.managedConnectorOperationRevision.toolkitVersion,
          request.revision.toolkitVersion
        ),
        eq(schema.managedConnectorOperationRevision.schemaHash, request.revision.schemaHash)
      )
    )
    .limit(2);
  if (revisions.length !== 1) return null;
  const revision = revisions[0];
  const [grant] = await db
    .select()
    .from(schema.managedConnectorGrant)
    .where(
      and(
        eq(schema.managedConnectorGrant.tenantId, principal.tenantId),
        eq(schema.managedConnectorGrant.instanceId, principal.instanceId),
        eq(schema.managedConnectorGrant.connectionId, request.managedConnectionId),
        eq(schema.managedConnectorGrant.agentId, request.agentId),
        eq(schema.managedConnectorGrant.operationRevisionId, revision.id),
        eq(schema.managedConnectorGrant.scopeVersion, request.grantScopeVersion),
        eq(schema.managedConnectorGrant.active, true),
        isNull(schema.managedConnectorGrant.revokedAt)
      )
    )
    .limit(1);
  return grant ? { connection, revision, provider } : null;
}

function resultOutcome(
  result: ConnectorProviderExecuteResult
): ManagedConnectorExecutionReceipt['outcome'] {
  return result.status === 'success' ? 'success' : result.status;
}

function resultErrorCode(result: ConnectorProviderExecuteResult): string | null {
  if (result.status === 'success') return null;
  if (result.status === 'unsupported') return 'UNSUPPORTED';
  return result.code;
}

function resultProviderLogId(result: ConnectorProviderExecuteResult): string | null {
  if (!('providerLogId' in result) || !result.providerLogId) return null;
  // Provider log references are useful for server-side support, but remain
  // bounded so an upstream response cannot turn the accounting row into a
  // payload store.
  return result.providerLogId.slice(0, 1024);
}

async function authorizeAndMarkDispatch(input: {
  db: ManagedConnectorDatabase;
  principal: ManagedConnectorPrincipal;
  request: ReturnType<typeof ManagedConnectorExecutionRequestSchema.parse>;
  requestHash: string;
  executionLeaseToken: string;
  authorized: AuthorizedExecution;
}): Promise<boolean> {
  const now = new Date();
  const [updated] = await input.db
    .update(schema.managedConnectorExecutionAttempt)
    .set({
      dispatchClaimedAt: now,
      leaseExpiresAt: new Date(now.getTime() + ABANDONED_DISPATCH_MS),
    })
    .where(
      and(
        eq(schema.managedConnectorExecutionAttempt.tenantId, input.principal.tenantId),
        eq(schema.managedConnectorExecutionAttempt.instanceId, input.principal.instanceId),
        eq(schema.managedConnectorExecutionAttempt.attemptId, input.request.attemptId),
        eq(schema.managedConnectorExecutionAttempt.requestHash, input.requestHash),
        eq(schema.managedConnectorExecutionAttempt.state, 'pending'),
        eq(schema.managedConnectorExecutionAttempt.executionLeaseToken, input.executionLeaseToken),
        isNull(schema.managedConnectorExecutionAttempt.dispatchClaimedAt),

        exists(
          input.db
            .select({ one: sql`1` })
            .from(schema.instance)
            .where(
              and(
                eq(schema.instance.id, input.principal.instanceId),
                eq(schema.instance.userId, input.principal.ownerId),
                isNull(schema.instance.revokedAt)
              )
            )
        ),
        exists(
          input.db
            .select({ one: sql`1` })
            .from(schema.apikey)
            .where(
              and(
                eq(schema.apikey.id, input.principal.keyId),
                eq(schema.apikey.referenceId, input.principal.ownerId),
                eq(schema.apikey.enabled, true),
                or(isNull(schema.apikey.expiresAt), gt(schema.apikey.expiresAt, now)),
                sql`${schema.apikey.metadata}::jsonb @> ${JSON.stringify({ instanceId: input.principal.instanceId, scope: 'instance' })}::jsonb`,
                sql`${schema.apikey.permissions}::jsonb @> ${JSON.stringify(MANAGED_CONNECTOR_EXECUTION_PERMISSIONS)}::jsonb`
              )
            )
        ),
        exists(
          input.db
            .select({ one: sql`1` })
            .from(schema.managedConnectorConnection)
            .innerJoin(
              schema.managedConnectorProvider,
              and(
                eq(
                  schema.managedConnectorProvider.tenantId,
                  schema.managedConnectorConnection.tenantId
                ),
                eq(
                  schema.managedConnectorProvider.id,
                  schema.managedConnectorConnection.providerInstanceId
                )
              )
            )
            .where(
              and(
                eq(schema.managedConnectorConnection.tenantId, input.principal.tenantId),
                eq(schema.managedConnectorConnection.id, input.request.managedConnectionId),
                eq(
                  schema.managedConnectorConnection.originatingInstanceId,
                  input.principal.instanceId
                ),
                eq(schema.managedConnectorConnection.lifecycle, 'active'),
                eq(schema.managedConnectorConnection.authenticationStatus, 'active'),
                eq(
                  schema.managedConnectorConnection.providerInstanceId,
                  input.authorized.connection.providerInstanceId
                ),
                eq(
                  schema.managedConnectorConnection.providerUserId,
                  input.authorized.connection.providerUserId
                ),
                eq(
                  schema.managedConnectorConnection.authConfigId,
                  input.authorized.connection.authConfigId
                ),
                eq(schema.managedConnectorConnection.toolkit, input.authorized.connection.toolkit),
                eq(
                  schema.managedConnectorConnection.externalAccountRef,
                  input.authorized.connection.externalAccountRef
                ),
                eq(
                  schema.managedConnectorConnection.bindingGeneration,
                  input.authorized.connection.bindingGeneration
                ),
                eq(
                  schema.managedConnectorConnection.materialGeneration,
                  input.authorized.connection.materialGeneration
                ),
                eq(schema.managedConnectorProvider.enabled, true),
                eq(schema.managedConnectorProvider.id, input.authorized.provider.id),
                eq(
                  schema.managedConnectorProvider.materialGeneration,
                  input.authorized.provider.materialGeneration
                ),
                eq(
                  schema.managedConnectorProvider.configurationDigest,
                  input.authorized.provider.configurationDigest
                )
              )
            )
        ),
        exists(
          input.db
            .select({ one: sql`1` })
            .from(schema.managedConnectorGrant)
            .innerJoin(
              schema.managedConnectorOperationRevision,
              and(
                eq(
                  schema.managedConnectorOperationRevision.tenantId,
                  schema.managedConnectorGrant.tenantId
                ),
                eq(
                  schema.managedConnectorOperationRevision.id,
                  schema.managedConnectorGrant.operationRevisionId
                )
              )
            )
            .where(
              and(
                eq(schema.managedConnectorGrant.tenantId, input.principal.tenantId),
                eq(schema.managedConnectorGrant.instanceId, input.principal.instanceId),
                eq(schema.managedConnectorGrant.connectionId, input.request.managedConnectionId),
                eq(schema.managedConnectorGrant.agentId, input.request.agentId),
                eq(schema.managedConnectorGrant.scopeVersion, input.request.grantScopeVersion),
                eq(schema.managedConnectorGrant.active, true),
                isNull(schema.managedConnectorGrant.revokedAt),
                eq(schema.managedConnectorOperationRevision.id, input.authorized.revision.id),
                eq(
                  schema.managedConnectorOperationRevision.id,
                  input.request.revision.hostedRevisionId
                ),
                eq(schema.managedConnectorOperationRevision.current, true),
                eq(
                  schema.managedConnectorOperationRevision.operationSlug,
                  input.request.revision.operationSlug
                ),
                eq(
                  schema.managedConnectorOperationRevision.toolkitVersion,
                  input.request.revision.toolkitVersion
                ),
                eq(
                  schema.managedConnectorOperationRevision.schemaHash,
                  input.request.revision.schemaHash
                )
              )
            )
        )
      )
    )
    .returning({ attemptId: schema.managedConnectorExecutionAttempt.attemptId });
  return updated?.attemptId === input.request.attemptId;
}

async function recoverAbandonedExecutionAttempt(
  db: ManagedConnectorDatabase,
  row: typeof schema.managedConnectorExecutionAttempt.$inferSelect
): Promise<typeof schema.managedConnectorExecutionAttempt.$inferSelect> {
  if (
    row.state !== 'pending' ||
    !row.dispatchClaimedAt ||
    row.dispatchClaimedAt.getTime() > Date.now() - ABANDONED_DISPATCH_MS
  ) {
    return row;
  }
  const now = new Date();
  const [recovered] = await db
    .update(schema.managedConnectorExecutionAttempt)
    .set({
      state: 'recorded',
      outcome: 'outcome_unknown',
      errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
      completedAt: null,
      recordedAt: now,
    })
    .where(
      and(
        eq(schema.managedConnectorExecutionAttempt.tenantId, row.tenantId),
        eq(schema.managedConnectorExecutionAttempt.instanceId, row.instanceId),
        eq(schema.managedConnectorExecutionAttempt.attemptId, row.attemptId),
        eq(schema.managedConnectorExecutionAttempt.requestHash, row.requestHash),
        eq(schema.managedConnectorExecutionAttempt.state, 'pending'),
        isNotNull(schema.managedConnectorExecutionAttempt.dispatchClaimedAt),
        lte(
          schema.managedConnectorExecutionAttempt.dispatchClaimedAt,
          new Date(now.getTime() - ABANDONED_DISPATCH_MS)
        )
      )
    )
    .returning();
  if (recovered) return recovered;
  const [winner] = await db
    .select()
    .from(schema.managedConnectorExecutionAttempt)
    .where(
      and(
        eq(schema.managedConnectorExecutionAttempt.tenantId, row.tenantId),
        eq(schema.managedConnectorExecutionAttempt.instanceId, row.instanceId),
        eq(schema.managedConnectorExecutionAttempt.attemptId, row.attemptId),
        eq(schema.managedConnectorExecutionAttempt.requestHash, row.requestHash)
      )
    )
    .limit(1);
  return winner ?? row;
}

/** Recover only an exact existing attempt without consulting current provider authority. */
export async function findManagedExecutionReplay(
  db: ManagedConnectorDatabase,
  principal: ManagedConnectorPrincipal,
  request: ReturnType<typeof ManagedConnectorExecutionRequestSchema.parse>
): Promise<ManagedConnectorExecutionResponse | null> {
  const requestHash = managedRequestHash(request);
  const [prior] = await db
    .select()
    .from(schema.managedConnectorExecutionAttempt)
    .where(
      and(
        eq(schema.managedConnectorExecutionAttempt.tenantId, principal.tenantId),
        eq(schema.managedConnectorExecutionAttempt.instanceId, principal.instanceId),
        eq(schema.managedConnectorExecutionAttempt.attemptId, request.attemptId)
      )
    )
    .limit(1);
  if (prior) {
    if (prior.requestHash !== requestHash) throw new ManagedExecutionConflictError();
    if (prior.state === 'recorded') {
      return { state: 'receipt_only', receipt: managedExecutionReceiptFromRow(prior) };
    }
    if (prior.dispatchClaimedAt) {
      const recovered = await recoverAbandonedExecutionAttempt(db, prior);
      return recovered.state === 'recorded'
        ? { state: 'receipt_only', receipt: managedExecutionReceiptFromRow(recovered) }
        : { state: 'pending', attemptId: request.attemptId };
    }
    if (prior.leaseExpiresAt > new Date())
      return { state: 'pending', attemptId: request.attemptId };
  }
  return null;
}

/**
 * Claim and execute one attempt. Exact duplicates return only durable status;
 * conflicting duplicates never dispatch. The final SDK hook repeats all live
 * authority immediately before provider dispatch may begin.
 */
export async function executeManagedConnectorOperation(input: {
  db: ManagedConnectorDatabase;
  principal: ManagedConnectorPrincipal;
  rawRequest: unknown;
  accounts: Pick<ComposioManagedAccountClient, 'getAccount'>;
  operations: ComposioOperationClient;
  verifyLiveInstance: () => Promise<boolean>;
  signal: AbortSignal;
}): Promise<ManagedConnectorExecutionResponse> {
  const request = ManagedConnectorExecutionRequestSchema.parse(input.rawRequest);
  const requestHash = managedRequestHash(request);
  const replay = await findManagedExecutionReplay(input.db, input.principal, request);
  if (replay) return replay;
  const authorized = await loadAuthorizedExecution(input.db, input.principal, request);
  if (!authorized) throw new ManagedExecutionUnauthorizedError();
  let account: Awaited<ReturnType<ComposioManagedAccountClient['getAccount']>>;
  try {
    account = await input.accounts.getAccount(
      authorized.connection.externalAccountRef,
      input.signal
    );
  } catch (error) {
    if (error instanceof ComposioManagedAccountError || error instanceof Error) {
      throw new ManagedExecutionProviderUnavailableError();
    }
    throw error;
  }
  if (
    account.connectedAccountId !== authorized.connection.externalAccountRef ||
    account.providerUserId !== authorized.connection.providerUserId ||
    account.toolkit !== authorized.connection.toolkit ||
    account.authConfigId !== authorized.connection.authConfigId ||
    account.status !== 'ACTIVE'
  ) {
    throw new ManagedExecutionUnauthorizedError();
  }

  let executionLeaseToken = randomUUID();
  let [claimed] = await input.db
    .insert(schema.managedConnectorExecutionAttempt)
    .values({
      tenantId: input.principal.tenantId,
      instanceId: input.principal.instanceId,
      attemptId: request.attemptId,
      logicalOperationId: request.logicalOperationId,
      attemptIndex: request.attemptIndex,
      requestHash,
      connectionId: request.managedConnectionId,
      agentId: request.agentId,
      surface: request.attribution.surface,
      actorKind: request.attribution.actorKind,
      actorId: request.attribution.actorId,
      sessionId: request.attribution.sessionId ?? null,
      grantScopeVersion: request.grantScopeVersion,
      operationRevisionId: authorized.revision.id,
      state: 'pending',
      executionLeaseToken,
      leaseExpiresAt: new Date(Date.now() + EXECUTION_LEASE_MS),
    })
    .onConflictDoNothing()
    .returning();
  if (!claimed) {
    const [existing] = await input.db
      .select()
      .from(schema.managedConnectorExecutionAttempt)
      .where(
        and(
          eq(schema.managedConnectorExecutionAttempt.tenantId, input.principal.tenantId),
          eq(schema.managedConnectorExecutionAttempt.instanceId, input.principal.instanceId),
          eq(schema.managedConnectorExecutionAttempt.attemptId, request.attemptId)
        )
      )
      .limit(1);
    if (!existing || existing.requestHash !== requestHash)
      throw new ManagedExecutionConflictError();
    if (existing.state === 'recorded') {
      return { state: 'receipt_only', receipt: managedExecutionReceiptFromRow(existing) };
    }
    const now = new Date();
    if (
      existing.dispatchClaimedAt &&
      existing.dispatchClaimedAt.getTime() <= now.getTime() - ABANDONED_DISPATCH_MS
    ) {
      const recovered = await recoverAbandonedExecutionAttempt(input.db, existing);
      if (recovered.state === 'recorded') {
        return { state: 'receipt_only', receipt: managedExecutionReceiptFromRow(recovered) };
      }
    }
    if (!existing.dispatchClaimedAt && existing.leaseExpiresAt <= now) {
      executionLeaseToken = randomUUID();
      [claimed] = await input.db
        .update(schema.managedConnectorExecutionAttempt)
        .set({
          executionLeaseToken,
          leaseExpiresAt: new Date(now.getTime() + EXECUTION_LEASE_MS),
        })
        .where(
          and(
            eq(schema.managedConnectorExecutionAttempt.tenantId, input.principal.tenantId),
            eq(schema.managedConnectorExecutionAttempt.instanceId, input.principal.instanceId),
            eq(schema.managedConnectorExecutionAttempt.attemptId, request.attemptId),
            eq(schema.managedConnectorExecutionAttempt.requestHash, requestHash),
            eq(schema.managedConnectorExecutionAttempt.state, 'pending'),
            eq(
              schema.managedConnectorExecutionAttempt.executionLeaseToken,
              existing.executionLeaseToken
            ),
            isNull(schema.managedConnectorExecutionAttempt.dispatchClaimedAt),
            lte(schema.managedConnectorExecutionAttempt.leaseExpiresAt, now)
          )
        )
        .returning();
    }
    if (!claimed) return { state: 'pending', attemptId: request.attemptId };
  }

  const result = await input.operations.execute({
    connectedAccountId: authorized.connection.externalAccountRef,
    operation: operationFromRow(authorized.revision),
    arguments: request.arguments,
    signal: input.signal,
    authorizeDispatch: async () => {
      if (!(await input.verifyLiveInstance())) return false;
      return authorizeAndMarkDispatch({
        db: input.db,
        principal: input.principal,
        request,
        requestHash,
        executionLeaseToken,
        authorized,
      });
    },
  });
  const completedAt = result.status === 'outcome_unknown' ? null : new Date();
  const [recorded] = await input.db
    .update(schema.managedConnectorExecutionAttempt)
    .set({
      state: 'recorded',
      outcome: resultOutcome(result),
      errorCode: resultErrorCode(result),
      providerLogId: resultProviderLogId(result),
      completedAt,
      recordedAt: new Date(),
    })
    .where(
      and(
        eq(schema.managedConnectorExecutionAttempt.tenantId, input.principal.tenantId),
        eq(schema.managedConnectorExecutionAttempt.instanceId, input.principal.instanceId),
        eq(schema.managedConnectorExecutionAttempt.attemptId, request.attemptId),
        eq(schema.managedConnectorExecutionAttempt.requestHash, requestHash),
        eq(schema.managedConnectorExecutionAttempt.state, 'pending'),
        eq(schema.managedConnectorExecutionAttempt.executionLeaseToken, executionLeaseToken)
      )
    )
    .returning();
  if (!recorded) {
    const [winner] = await input.db
      .select()
      .from(schema.managedConnectorExecutionAttempt)
      .where(
        and(
          eq(schema.managedConnectorExecutionAttempt.tenantId, input.principal.tenantId),
          eq(schema.managedConnectorExecutionAttempt.instanceId, input.principal.instanceId),
          eq(schema.managedConnectorExecutionAttempt.attemptId, request.attemptId),
          eq(schema.managedConnectorExecutionAttempt.requestHash, requestHash)
        )
      )
      .limit(1);
    if (!winner) throw new ManagedExecutionConflictError();
    return winner.state === 'recorded'
      ? { state: 'receipt_only', receipt: managedExecutionReceiptFromRow(winner) }
      : { state: 'pending', attemptId: request.attemptId };
  }
  return { state: 'completed', result, receipt: managedExecutionReceiptFromRow(recorded) };
}

/** Read a durable hosted receipt without returning arguments or result data. */
export async function getManagedExecutionReceipt(
  db: ManagedConnectorDatabase,
  principal: ManagedConnectorPrincipal,
  attemptId: string
): Promise<
  | { state: 'pending'; attemptId: string }
  | { state: 'recorded'; receipt: ManagedConnectorExecutionReceipt }
  | null
> {
  const [row] = await db
    .select()
    .from(schema.managedConnectorExecutionAttempt)
    .where(
      and(
        eq(schema.managedConnectorExecutionAttempt.tenantId, principal.tenantId),
        eq(schema.managedConnectorExecutionAttempt.instanceId, principal.instanceId),
        eq(schema.managedConnectorExecutionAttempt.attemptId, attemptId)
      )
    )
    .limit(1);
  if (!row) return null;
  const current = await recoverAbandonedExecutionAttempt(db, row);
  return current.state === 'recorded'
    ? { state: 'recorded', receipt: managedExecutionReceiptFromRow(current) }
    : { state: 'pending', attemptId };
}
