/** Authenticated exact-instance event handoff and bounded hosted content maintenance. */
import { randomUUID } from 'node:crypto';
import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { ConnectorEventPayloadProtector } from '@dorkos/connector-providers';
import { MANAGED_CONNECTOR_EVENTS_PERMISSIONS } from '@dorkos/shared/connector-managed-schemas';
import {
  CONNECTOR_EVENT_BATCH_LIMIT,
  type ManagedConnectorEventDelivery,
} from '@dorkos/shared/connector-event-schemas';
import { schema } from '@/db/client';
import {
  ManagedAuthorityUnauthorizedError,
  type ManagedConnectorDatabase,
  type ManagedConnectorPrincipal,
} from './authority-service';
import {
  lockManagedEventCapacity,
  MANAGED_EVENT_CAPACITY_POLICY,
  type ManagedEventCapacityPolicy,
} from './event-capacity-service';

type Transaction = Parameters<Parameters<ManagedConnectorDatabase['transaction']>[0]>[0];

/** Recheck key, link and owner after the tenant capacity row has been locked. */
async function lockEventPrincipal(
  tx: Transaction,
  principal: ManagedConnectorPrincipal,
  now: Date
) {
  const [live] = await tx
    .select({ id: schema.instance.id })
    .from(schema.instance)
    .innerJoin(
      schema.apikey,
      and(
        eq(schema.apikey.id, principal.keyId),
        eq(schema.apikey.referenceId, principal.ownerId),
        eq(schema.apikey.enabled, true),
        or(isNull(schema.apikey.expiresAt), gt(schema.apikey.expiresAt, now)),
        sql`${schema.apikey.metadata}::jsonb @> ${JSON.stringify({ instanceId: principal.instanceId, scope: 'instance' })}::jsonb`,
        sql`${schema.apikey.permissions}::jsonb @> ${JSON.stringify(MANAGED_CONNECTOR_EVENTS_PERMISSIONS)}::jsonb`
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
  const [tenant] = await tx
    .select({ id: schema.connectorTenant.id })
    .from(schema.connectorTenant)
    .where(
      and(
        eq(schema.connectorTenant.id, principal.tenantId),
        eq(schema.connectorTenant.ownerUserId, principal.ownerId)
      )
    );
  if (!live || !tenant) throw new ManagedAuthorityUnauthorizedError();
}

/** Lease buffered events without requiring a working vendor SDK configuration. */
export async function pullManagedConnectorEvents(
  db: ManagedConnectorDatabase,
  principal: ManagedConnectorPrincipal,
  protector: ConnectorEventPayloadProtector,
  limit: number,
  now = new Date(),
  policy: ManagedEventCapacityPolicy = MANAGED_EVENT_CAPACITY_POLICY
): Promise<{ events: ManagedConnectorEventDelivery[] }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > CONNECTOR_EVENT_BATCH_LIMIT)
    throw new Error('Invalid event batch limit.');
  const inbox = schema.managedConnectorEventInbox;
  const subscription = schema.managedConnectorEventSubscription;
  const binding = schema.managedConnectorEventBinding;
  const definition = schema.managedConnectorEventDefinition;
  const connection = schema.managedConnectorConnection;
  const provider = schema.managedConnectorProvider;
  return db.transaction(async (tx) => {
    await lockManagedEventCapacity(tx, principal.tenantId, policy);
    await lockEventPrincipal(tx, principal, now);
    const rows = await tx
      .select({ inbox, providerInstanceId: binding.providerInstanceId })
      .from(inbox)
      .innerJoin(
        subscription,
        and(eq(subscription.tenantId, inbox.tenantId), eq(subscription.id, inbox.subscriptionId))
      )
      .innerJoin(
        binding,
        and(eq(binding.tenantId, subscription.tenantId), eq(binding.id, subscription.bindingId))
      )
      .innerJoin(
        definition,
        and(eq(definition.tenantId, binding.tenantId), eq(definition.id, binding.definitionId))
      )
      .innerJoin(
        connection,
        and(
          eq(connection.tenantId, subscription.tenantId),
          eq(connection.id, subscription.connectionId)
        )
      )
      .innerJoin(
        provider,
        and(eq(provider.tenantId, binding.tenantId), eq(provider.id, binding.providerInstanceId))
      )
      .where(
        and(
          eq(inbox.tenantId, principal.tenantId),
          eq(inbox.targetInstanceId, principal.instanceId),
          eq(subscription.targetInstanceId, principal.instanceId),
          eq(connection.originatingInstanceId, principal.instanceId),
          eq(subscription.enabled, true),
          isNull(subscription.revokedAt),
          eq(subscription.scopeVersion, inbox.subscriptionVersion),
          eq(subscription.connectionGeneration, connection.bindingGeneration),
          eq(binding.state, 'ready'),
          eq(definition.current, true),
          eq(connection.lifecycle, 'active'),
          eq(connection.authenticationStatus, 'active'),
          eq(provider.enabled, true),
          eq(binding.providerGeneration, provider.materialGeneration),
          eq(connection.materialGeneration, provider.materialGeneration),
          eq(binding.externalAccountRef, connection.externalAccountRef),
          eq(binding.providerInstanceId, connection.providerInstanceId),
          gt(inbox.expiresAt, now),
          or(
            eq(inbox.state, 'received'),
            and(eq(inbox.state, 'leased'), lte(inbox.leasedUntil, now))
          )
        )
      )
      .orderBy(inbox.receivedAt, inbox.id)
      .limit(limit)
      .for('update', { skipLocked: true });
    const events: ManagedConnectorEventDelivery[] = [];
    for (const { inbox: row, providerInstanceId } of rows) {
      const expiresAt = row.expiresAt.toISOString();
      const content = protector.reveal(
        row.protectedPayload,
        {
          tenantId: row.tenantId,
          providerInstanceId,
          subscriptionId: row.subscriptionId,
          providerEventId: row.providerEventId,
          expiresAt,
        },
        now.getTime()
      );
      const leaseToken = randomUUID();
      await tx
        .update(inbox)
        .set({
          state: 'leased',
          leaseToken,
          leaseKeyId: principal.keyId,
          leasedUntil: new Date(Math.min(now.getTime() + 60_000, row.expiresAt.getTime())),
        })
        .where(and(eq(inbox.tenantId, principal.tenantId), eq(inbox.id, row.id)));
      events.push({
        id: row.id,
        subscriptionId: row.subscriptionId,
        subscriptionVersion: row.subscriptionVersion,
        providerEventId: row.providerEventId,
        leaseToken,
        receivedAt: row.receivedAt.toISOString(),
        expiresAt,
        content,
      });
    }
    return { events };
  });
}

/** ACK means durable local acceptance; clear hosted content and release its stored bytes once. */
export async function acknowledgeManagedConnectorEvents(
  db: ManagedConnectorDatabase,
  principal: ManagedConnectorPrincipal,
  events: Array<{ id: string; leaseToken: string }>,
  now = new Date(),
  policy: ManagedEventCapacityPolicy = MANAGED_EVENT_CAPACITY_POLICY
): Promise<{ acknowledged: number }> {
  if (events.length < 1 || events.length > CONNECTOR_EVENT_BATCH_LIMIT)
    throw new Error('Invalid event batch limit.');
  const inbox = schema.managedConnectorEventInbox;
  return db.transaction(async (tx) => {
    const capacity = await lockManagedEventCapacity(tx, principal.tenantId, policy);
    await lockEventPrincipal(tx, principal, now);
    let acknowledged = 0;
    let releasedBytes = 0;
    for (const event of events) {
      const [row] = await tx
        .select({ state: inbox.state, protectedPayload: inbox.protectedPayload })
        .from(inbox)
        .where(
          and(
            eq(inbox.tenantId, principal.tenantId),
            eq(inbox.id, event.id),
            eq(inbox.targetInstanceId, principal.instanceId),
            eq(inbox.leaseKeyId, principal.keyId),
            eq(inbox.leaseToken, event.leaseToken),
            or(
              and(eq(inbox.state, 'leased'), gt(inbox.leasedUntil, now)),
              eq(inbox.state, 'acknowledged')
            )
          )
        )
        .for('update');
      if (!row) continue;
      acknowledged++;
      if (row.state === 'acknowledged') continue;
      releasedBytes += Buffer.byteLength(row.protectedPayload);
      await tx
        .update(inbox)
        .set({
          state: 'acknowledged',
          protectedPayload: '',
          acknowledgedAt: now,
          leasedUntil: null,
        })
        .where(and(eq(inbox.tenantId, principal.tenantId), eq(inbox.id, event.id)));
    }
    if (releasedBytes > capacity.protectedPayloadBytes)
      throw new Error('Managed event byte capacity is inconsistent.');
    if (releasedBytes > 0)
      await tx
        .update(schema.managedConnectorEventCapacity)
        .set({
          protectedPayloadBytes: capacity.protectedPayloadBytes - releasedBytes,
          updatedAt: now,
        })
        .where(eq(schema.managedConnectorEventCapacity.tenantId, principal.tenantId));
    return { acknowledged };
  });
}

/** Controls one bounded retention sweep without exposing tenant capacity publicly. */
export interface ManagedEventRetentionOptions {
  now?: Date;
  tenantId?: string;
  maxPages?: number;
  signal?: AbortSignal;
  policy?: ManagedEventCapacityPolicy;
  monotonicClock?: () => number;
  databaseClock?: (tx: Transaction) => Promise<Date>;
}

/** Aggregate counts from committed tenant cleanup pages. */
export interface ManagedEventRetentionResult {
  pages: number;
  contentRowsCleared: number;
  metadataRowsDeleted: number;
  protectedBytesCleared: number;
}

interface CleanupBudget {
  deadline: number;
  signal?: AbortSignal;
  clock: () => number;
  policy: ManagedEventCapacityPolicy;
}

function assertCleanupBudget(budget: CleanupBudget): number {
  if (budget.signal?.aborted) throw new DOMException('Cleanup aborted.', 'AbortError');
  const remaining = budget.deadline - budget.clock();
  if (remaining <= 0) throw new DOMException('Cleanup deadline reached.', 'TimeoutError');
  return remaining;
}

async function runBudgetedStatement<T>(
  tx: Transaction,
  budget: CleanupBudget,
  operation: () => Promise<T>
): Promise<T> {
  const remaining = assertCleanupBudget(budget);
  const timeout = Math.max(1, Math.min(budget.policy.cleanupStatementTimeoutMs, remaining));
  await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeout}ms'`));
  assertCleanupBudget(budget);
  const result = await operation();
  assertCleanupBudget(budget);
  return result;
}

async function databaseClock(tx: Transaction): Promise<Date> {
  const result = await tx.execute(sql`select clock_timestamp() as now`);
  return new Date((result.rows[0] as { now: string | Date }).now);
}

/** Fair, fixed-statement cleanup for due tenant pages. */
export async function sweepManagedConnectorEventRetention(
  db: ManagedConnectorDatabase,
  input: ManagedEventRetentionOptions | Date = {}
): Promise<ManagedEventRetentionResult> {
  const options: ManagedEventRetentionOptions = input instanceof Date ? { now: input } : input;
  const policy = options.policy ?? MANAGED_EVENT_CAPACITY_POLICY;
  const monotonicClock = options.monotonicClock ?? (() => performance.now());
  const budget: CleanupBudget = {
    deadline: monotonicClock() + policy.cleanupMaxDurationMs,
    signal: options.signal,
    clock: monotonicClock,
    policy,
  };
  const maximumPages = Math.max(0, Math.min(options.maxPages ?? policy.cleanupMaxPages, 100));
  const result: ManagedEventRetentionResult = {
    pages: 0,
    contentRowsCleared: 0,
    metadataRowsDeleted: 0,
    protectedBytesCleared: 0,
  };
  for (let page = 0; page < maximumPages; page++) {
    if (budget.signal?.aborted || monotonicClock() >= budget.deadline) break;
    try {
      const committed = await db.transaction(async (tx) => {
        assertCleanupBudget(budget);
        await tx.execute(
          sql.raw(`SET LOCAL lock_timeout = '${Math.max(1, policy.lockTimeoutMs)}ms'`)
        );
        assertCleanupBudget(budget);
        await tx.execute(
          sql.raw(
            `SET LOCAL statement_timeout = '${Math.max(1, policy.cleanupStatementTimeoutMs)}ms'`
          )
        );
        const now =
          options.now ??
          (await runBudgetedStatement(tx, budget, () =>
            (options.databaseClock ?? databaseClock)(tx)
          ));
        const capacityTable = schema.managedConnectorEventCapacity;
        const [capacity] = options.tenantId
          ? await runBudgetedStatement(tx, budget, () =>
              tx
                .select()
                .from(capacityTable)
                .where(
                  and(
                    eq(capacityTable.tenantId, options.tenantId!),
                    lte(capacityTable.nextCleanupAt, now)
                  )
                )
                .for('update')
            )
          : await runBudgetedStatement(tx, budget, () =>
              tx
                .select()
                .from(capacityTable)
                .where(lte(capacityTable.nextCleanupAt, now))
                .orderBy(
                  sql`${capacityTable.lastCleanupAt} asc nulls first`,
                  capacityTable.nextCleanupAt,
                  capacityTable.tenantId
                )
                .limit(1)
                .for('update', { skipLocked: true })
            );
        if (!capacity) return undefined;
        const inbox = schema.managedConnectorEventInbox;
        const contentResult = await runBudgetedStatement(tx, budget, () =>
          tx.execute(sql`
            with candidates as materialized (
              select ${inbox.id} as id, octet_length(${inbox.protectedPayload})::bigint as bytes
              from ${inbox}
              where ${inbox.tenantId} = ${capacity.tenantId}
                and ${inbox.expiresAt} <= ${now}
                and (${inbox.protectedPayload} <> '' or ${inbox.state} in ('received', 'leased'))
              order by ${inbox.expiresAt}, ${inbox.id}
              limit ${policy.cleanupPageSize}
              for update
            ), updated as (
              update ${inbox} target
              set protected_payload = '',
                  state = case when target.state = 'acknowledged' then 'acknowledged' else 'expired' end,
                  leased_until = null
              from candidates
              where target.tenant_id = ${capacity.tenantId} and target.id = candidates.id
              returning target.id
            )
            select count(updated.id)::int as rows,
                   coalesce(sum(candidates.bytes), 0)::bigint as bytes
            from candidates inner join updated on updated.id = candidates.id
          `)
        );
        const contentAggregate = contentResult.rows[0] as { rows: number; bytes: string | number };
        const contentRows = Number(contentAggregate.rows);
        const contentBytes = Number(contentAggregate.bytes);
        const metadataResult = await runBudgetedStatement(tx, budget, () =>
          tx.execute(sql`
            with candidates as materialized (
              select ${inbox.id} as id, octet_length(${inbox.protectedPayload})::bigint as bytes
              from ${inbox}
              where ${inbox.tenantId} = ${capacity.tenantId}
                and ${inbox.metadataExpiresAt} <= ${now}
              order by ${inbox.metadataExpiresAt}, ${inbox.id}
              limit ${policy.cleanupPageSize}
              for update
            ), deleted as (
              delete from ${inbox} target
              using candidates
              where target.tenant_id = ${capacity.tenantId} and target.id = candidates.id
              returning target.id
            )
            select count(deleted.id)::int as rows,
                   coalesce(sum(candidates.bytes), 0)::bigint as bytes
            from candidates inner join deleted on deleted.id = candidates.id
          `)
        );
        const metadataAggregate = metadataResult.rows[0] as {
          rows: number;
          bytes: string | number;
        };
        const metadataRows = Number(metadataAggregate.rows);
        const metadataBytes = Number(metadataAggregate.bytes);
        const [next] = await runBudgetedStatement(tx, budget, () =>
          tx
            .select({
              at: sql<Date | null>`min(case when ${inbox.protectedPayload} <> '' then least(${inbox.expiresAt}, ${inbox.metadataExpiresAt}) else ${inbox.metadataExpiresAt} end)`,
            })
            .from(inbox)
            .where(eq(inbox.tenantId, capacity.tenantId))
        );
        const releasedBytes = contentBytes + metadataBytes;
        const nextCleanupAt = next.at === null ? null : new Date(next.at);
        if (releasedBytes > capacity.protectedPayloadBytes || metadataRows > capacity.retainedRows)
          throw new Error('Managed event capacity is inconsistent.');
        const finishedAt =
          options.now ??
          (await runBudgetedStatement(tx, budget, () =>
            (options.databaseClock ?? databaseClock)(tx)
          ));
        await runBudgetedStatement(tx, budget, () =>
          tx
            .update(capacityTable)
            .set({
              protectedPayloadBytes: capacity.protectedPayloadBytes - releasedBytes,
              retainedRows: capacity.retainedRows - metadataRows,
              nextCleanupAt,
              lastCleanupAt: finishedAt,
              updatedAt: finishedAt,
            })
            .where(eq(capacityTable.tenantId, capacity.tenantId))
        );
        return {
          contentRowsCleared: contentRows,
          metadataRowsDeleted: metadataRows,
          protectedBytesCleared: releasedBytes,
        };
      });
      if (!committed) break;
      result.pages++;
      result.contentRowsCleared += committed.contentRowsCleared;
      result.metadataRowsDeleted += committed.metadataRowsDeleted;
      result.protectedBytesCleared += committed.protectedBytesCleared;
    } catch (error) {
      if (
        budget.signal?.aborted ||
        monotonicClock() >= budget.deadline ||
        (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name))
      )
        break;
      throw error;
    }
  }
  return result;
}
