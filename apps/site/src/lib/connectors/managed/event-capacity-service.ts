/** Tenant-scoped hosted event admission policy and capacity locking. */
import { eq, sql } from 'drizzle-orm';
import { schema } from '@/db/client';
import type { ManagedConnectorDatabase } from './authority-service';

type Transaction = Parameters<Parameters<ManagedConnectorDatabase['transaction']>[0]>[0];

/** Fixed hosted safety ceilings. They are not owner-configurable entitlements. */
export interface ManagedEventCapacityPolicy {
  rateLimit: number;
  bindingSubscriptionLimit: number;
  retainedRowLimit: number;
  protectedByteLimit: number;
  overloadRetrySeconds: number;
  cleanupPageSize: number;
  cleanupMaxPages: number;
  cleanupMaxDurationMs: number;
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  cleanupStatementTimeoutMs: number;
}

/** Production hosted event safety policy. */
export const MANAGED_EVENT_CAPACITY_POLICY: Readonly<ManagedEventCapacityPolicy> = Object.freeze({
  rateLimit: 600,
  bindingSubscriptionLimit: 100,
  retainedRowLimit: 100_000,
  protectedByteLimit: 256 * 1_024 * 1_024,
  overloadRetrySeconds: 60,
  cleanupPageSize: 100,
  cleanupMaxPages: 100,
  cleanupMaxDurationMs: 20_000,
  lockTimeoutMs: 1_000,
  statementTimeoutMs: 5_000,
  cleanupStatementTimeoutMs: 2_000,
});

/** Fail-closed signal for a missing or inconsistent tenant capacity ledger. */
export class ManagedEventCapacityUnavailableError extends Error {
  constructor() {
    super('Managed event capacity is unavailable.');
    this.name = 'ManagedEventCapacityUnavailableError';
  }
}

/** Apply transaction-local wait ceilings before acquiring a capacity-bearing lock. */
export async function setManagedEventTransactionTimeouts(
  tx: Transaction,
  policy: ManagedEventCapacityPolicy = MANAGED_EVENT_CAPACITY_POLICY
): Promise<void> {
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${Math.max(1, policy.lockTimeoutMs)}ms'`));
  await tx.execute(
    sql.raw(`SET LOCAL statement_timeout = '${Math.max(1, policy.statementTimeoutMs)}ms'`)
  );
}

/** Lock the required tenant ledger before any subscription or inbox row. */
export async function lockManagedEventCapacity(
  tx: Transaction,
  tenantId: string,
  policy: ManagedEventCapacityPolicy = MANAGED_EVENT_CAPACITY_POLICY
): Promise<typeof schema.managedConnectorEventCapacity.$inferSelect> {
  await setManagedEventTransactionTimeouts(tx, policy);
  const [capacity] = await tx
    .select()
    .from(schema.managedConnectorEventCapacity)
    .where(eq(schema.managedConnectorEventCapacity.tenantId, tenantId))
    .for('update');
  if (!capacity) throw new ManagedEventCapacityUnavailableError();
  return capacity;
}

/** Whether Postgres refused a bounded row-lock wait. */
export function isManagedEventCapacityContention(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String(error.code) : '';
  if (code === '55P03') return true;
  return 'cause' in error && isManagedEventCapacityContention(error.cause);
}

/** Summary returned only after every tenant ledger matches its retained inbox aggregate. */
export interface ManagedEventCapacityCutoverResult {
  tenantsVerified: number;
  retainedRows: number;
  protectedPayloadBytes: number;
}

/** Verify the quiesced pre-readiness cutover without repairing or truncating tenant state. */
export async function verifyManagedEventCapacityCutover(
  db: ManagedConnectorDatabase,
  policy: ManagedEventCapacityPolicy = MANAGED_EVENT_CAPACITY_POLICY
): Promise<ManagedEventCapacityCutoverResult> {
  const tenants = await db
    .select({ id: schema.connectorTenant.id })
    .from(schema.connectorTenant)
    .orderBy(schema.connectorTenant.id);
  const total: ManagedEventCapacityCutoverResult = {
    tenantsVerified: 0,
    retainedRows: 0,
    protectedPayloadBytes: 0,
  };
  for (const tenant of tenants) {
    const aggregate = await db.transaction(async (tx) => {
      const capacity = await lockManagedEventCapacity(tx, tenant.id, policy);
      const [actual] = await tx
        .select({
          retainedRows: sql<number>`count(*)::int`,
          protectedPayloadBytes: sql<number>`coalesce(sum(octet_length(${schema.managedConnectorEventInbox.protectedPayload})) filter (where ${schema.managedConnectorEventInbox.protectedPayload} <> ''), 0)::bigint`,
          nextCleanupAt: sql<Date | null>`min(case when ${schema.managedConnectorEventInbox.protectedPayload} <> '' then least(${schema.managedConnectorEventInbox.expiresAt}, ${schema.managedConnectorEventInbox.metadataExpiresAt}) else ${schema.managedConnectorEventInbox.metadataExpiresAt} end)`,
        })
        .from(schema.managedConnectorEventInbox)
        .where(eq(schema.managedConnectorEventInbox.tenantId, tenant.id));
      const actualBytes = Number(actual.protectedPayloadBytes);
      const actualNextCleanupAt =
        actual.nextCleanupAt === null ? null : new Date(actual.nextCleanupAt);
      const sameNextCleanup =
        capacity.nextCleanupAt === null
          ? actualNextCleanupAt === null
          : actualNextCleanupAt !== null &&
            capacity.nextCleanupAt.getTime() === actualNextCleanupAt.getTime();
      if (
        capacity.retainedRows !== actual.retainedRows ||
        capacity.protectedPayloadBytes !== actualBytes ||
        !sameNextCleanup ||
        actual.retainedRows > policy.retainedRowLimit ||
        actualBytes > policy.protectedByteLimit
      )
        throw new ManagedEventCapacityUnavailableError();
      return { retainedRows: actual.retainedRows, protectedPayloadBytes: actualBytes };
    });
    total.tenantsVerified++;
    total.retainedRows += aggregate.retainedRows;
    total.protectedPayloadBytes += aggregate.protectedPayloadBytes;
  }
  return total;
}
