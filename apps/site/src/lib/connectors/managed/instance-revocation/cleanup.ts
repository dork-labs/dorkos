/**
 * Ending a revoked linked instance's app sign-ins at the service.
 *
 * Revoking a machine's link deletes its key, so the machine can never again
 * send the disconnects that would end its managed connections. Before this,
 * nothing else did either: the connections stayed active, their grants and
 * event subscriptions stayed on, and the provider accounts (a person's Gmail
 * sign-in, say) and triggers stayed live at the service with no way left to
 * reach them. So the service ends them itself, in two steps:
 *
 * 1. **Close** (`./close`), in one transaction under a lock on the revoked instance row:
 *    every connection the instance created is disconnected through the same
 *    durable `set_connection_lifecycle` receipt the instance would have sent,
 *    every grant it holds is revoked, every event subscription it targets is
 *    turned off through a `set_event_subscription` receipt, and any command
 *    still pending for it is superseded (its key is gone, so it can never
 *    finish).
 * 2. **Clean up** at the service (this module), through the very paths a live disconnect
 *    uses: triggers first ({@link recoverManagedEventCleanup}), then the
 *    provider accounts ({@link finishDisconnectCleanup}, leased, idempotent and
 *    retried). Both run under {@link RevokedInstanceCleanupPrincipal}, which can
 *    only remove access.
 *
 * A revoke runs both at once ({@link endRevokedInstanceConnections}); the
 * scheduled {@link sweepRevokedInstances} finishes any revoke that did not, and
 * closes instances revoked by any other path. Erasing an account runs both for
 * every instance first and refuses the erasure while a provider account is
 * still live (`./erasure`), because the erasure
 * would delete the only record of it.
 *
 * @module lib/connectors/managed/instance-revocation/cleanup
 */
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { ManagedConnectorAuthorityCommandSchema } from '@dorkos/shared/connector-managed-schemas';

import { schema } from '@/db/client';
import {
  finishDisconnectCleanup,
  getManagedAuthorityCommandStatus,
  managedRequestHash,
  type ManagedConnectorDatabase,
  type RevokedInstanceCleanupPrincipal,
} from '../authority-service';
import { recoverManagedEventCleanup } from '../event-cleanup-service';
import { closeRevokedInstance } from './close';
import {
  revokedInstanceConnectionsDue,
  withDefaults,
  type RevokedInstanceCleanupOptions,
} from './policy';

const commands = schema.managedConnectorAuthorityCommand;
const tenants = schema.connectorTenant;

/**
 * Delete the provider accounts that revoked instances' disconnects still owe,
 * least recently tried first. Returns how many it examined and completed.
 */
async function finishRevokedDisconnects(
  db: ManagedConnectorDatabase,
  options: Required<RevokedInstanceCleanupOptions> & { instanceId?: string; limit: number }
): Promise<{ examined: number; completed: number }> {
  const rows = await db
    .select({
      receipt: commands,
      ownerId: schema.instance.userId,
      providerUserId: tenants.providerUserId,
    })
    .from(commands)
    .innerJoin(
      schema.instance,
      and(eq(schema.instance.id, commands.instanceId), isNotNull(schema.instance.revokedAt))
    )
    .innerJoin(
      tenants,
      and(eq(tenants.id, commands.tenantId), eq(tenants.ownerUserId, schema.instance.userId))
    )
    .where(
      and(
        eq(commands.kind, 'set_connection_lifecycle'),
        eq(commands.state, 'applied'),
        inArray(commands.externalCleanup, ['pending', 'failed']),
        isNotNull(commands.cleanupBinding),
        ...(options.instanceId ? [eq(commands.instanceId, options.instanceId)] : [])
      )
    )
    .orderBy(asc(commands.updatedAt), commands.tenantId, commands.instanceId, commands.commandId)
    .limit(Math.max(1, Math.min(100, options.limit)));
  let examined = 0;
  let completed = 0;
  for (const { receipt, ownerId, providerUserId } of rows) {
    if (options.signal.aborted) break;
    examined++;
    const parsed = ManagedConnectorAuthorityCommandSchema.safeParse(receipt.requestPayload);
    const binding = receipt.cleanupBinding;
    if (
      !binding ||
      !parsed.success ||
      parsed.data.kind !== 'set_connection_lifecycle' ||
      parsed.data.lifecycle !== 'disconnected' ||
      managedRequestHash(parsed.data) !== receipt.requestHash
    )
      continue;
    const principal: RevokedInstanceCleanupPrincipal = {
      revokedInstance: true,
      ownerId,
      tenantId: receipt.tenantId,
      instanceId: receipt.instanceId,
    };
    // Move the receipt to the back of the queue before any await, so one that
    // can never finish does not hold the front of every later pass.
    await db
      .update(commands)
      .set({ updatedAt: options.clock() })
      .where(
        and(
          eq(commands.tenantId, receipt.tenantId),
          eq(commands.instanceId, receipt.instanceId),
          eq(commands.commandId, receipt.commandId)
        )
      );
    try {
      const [providerRow] = await db
        .select({ materialGeneration: schema.managedConnectorProvider.materialGeneration })
        .from(schema.managedConnectorProvider)
        .where(
          and(
            eq(schema.managedConnectorProvider.tenantId, receipt.tenantId),
            eq(schema.managedConnectorProvider.id, binding.providerInstanceId)
          )
        );
      const clients = options.resolveProvider(providerUserId, options.signal);
      if (!providerRow || !clients) continue;
      const previous = await getManagedAuthorityCommandStatus(db, principal, receipt.commandId);
      if (!previous) continue;
      const { status } = await finishDisconnectCleanup(
        db,
        principal,
        parsed.data,
        receipt.requestHash,
        binding,
        previous,
        {
          ...clients,
          providerUserId,
          materialGeneration: providerRow.materialGeneration,
          signal: options.signal,
        }
      );
      if (status.state === 'applied' && status.externalCleanup === 'complete') completed++;
    } catch {
      /* The receipt stays owed; the next pass claims it again. */
    }
  }
  return { examined, completed };
}

/** Clean one revoked instance up at the service: triggers first, then accounts. */
export async function cleanUpRevokedInstance(
  db: ManagedConnectorDatabase,
  instanceId: string,
  options: Required<RevokedInstanceCleanupOptions>
): Promise<void> {
  // Triggers watch an account, so they go before the account does.
  await recoverManagedEventCleanup(
    db,
    options.signal,
    options.resolveProvider,
    100,
    options.clock,
    { instanceId }
  );
  await finishRevokedDisconnects(db, { ...options, instanceId, limit: 100 });
}

/**
 * End a just-revoked instance's managed connections: close them now, then
 * clean them up at the service as far as the signal allows. Whatever is left
 * owed, {@link sweepRevokedInstances} finishes later.
 *
 * @param db - The site database.
 * @param instanceId - The instance whose link was just revoked.
 * @param options - Signal, provider seam and clock.
 */
export async function endRevokedInstanceConnections(
  db: ManagedConnectorDatabase,
  instanceId: string,
  options: RevokedInstanceCleanupOptions
): Promise<void> {
  const resolved = withDefaults(options);
  await closeRevokedInstance(db, instanceId, resolved.clock());
  await cleanUpRevokedInstance(db, instanceId, resolved);
}

/**
 * Finish revokes that did not finish: close every due revoked instance that
 * still has something open (whatever path revoked it) and delete its triggers,
 * then retry the provider accounts revoked instances' disconnects still owe.
 * A trigger whose deletion has to wait is retried by
 * {@link recoverManagedEventCleanup}, which the same job calls first; its
 * account is not held back for it, because ending the sign-in comes first.
 *
 * @param db - The site database.
 * @param options - Signal, provider seam, clock, and a per-pass bound.
 * @returns How many instances it closed and how many accounts it examined and completed.
 */
export async function sweepRevokedInstances(
  db: ManagedConnectorDatabase,
  options: RevokedInstanceCleanupOptions & { limit?: number }
): Promise<{ instancesClosed: number; accountsExamined: number; accountsCompleted: number }> {
  const resolved = withDefaults(options);
  const limit = Math.max(1, Math.min(100, options.limit ?? 25));
  const now = resolved.clock();
  const candidates = await db
    .selectDistinct({ id: schema.instance.id, revokedAt: schema.instance.revokedAt })
    .from(schema.instance)
    .where(
      and(
        isNotNull(schema.instance.revokedAt),
        sql`(
          EXISTS (SELECT 1 FROM managed_connector_connection c
            WHERE c.originating_instance_id = ${schema.instance.id} AND c.lifecycle <> 'disconnected')
          OR EXISTS (SELECT 1 FROM managed_connector_event_subscription s
            WHERE s.target_instance_id = ${schema.instance.id} AND s.revoked_at IS NULL)
        )`
      )
    )
    .orderBy(asc(schema.instance.revokedAt), asc(schema.instance.id))
    .limit(limit);
  let instancesClosed = 0;
  for (const candidate of candidates) {
    if (resolved.signal.aborted) break;
    if (!candidate.revokedAt || !revokedInstanceConnectionsDue(candidate.revokedAt, now)) continue;
    try {
      if ((await closeRevokedInstance(db, candidate.id, now)) > 0) {
        instancesClosed++;
        // The close just wrote this instance's trigger receipts; delete those
        // triggers before the accounts they watch go below.
        await recoverManagedEventCleanup(
          db,
          resolved.signal,
          resolved.resolveProvider,
          100,
          resolved.clock,
          { instanceId: candidate.id }
        );
      }
    } catch {
      /* Whatever is left is retried on the next pass. */
    }
  }
  const accounts = resolved.signal.aborted
    ? { examined: 0, completed: 0 }
    : await finishRevokedDisconnects(db, { ...resolved, limit });
  return {
    instancesClosed,
    accountsExamined: accounts.examined,
    accountsCompleted: accounts.completed,
  };
}
