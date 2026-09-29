/**
 * Private captured-trigger reconciliation invoked by the existing authenticated
 * cleanup job, and by the cleanup a revoked linked instance is owed.
 *
 * @module lib/connectors/managed/event-cleanup-service
 */
import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  ComposioEventClient,
  createComposioHostedClients,
} from '@dorkos/connector-providers/composio';
import {
  MANAGED_CONNECTOR_AUTHORITY_PERMISSIONS,
  ManagedConnectorAuthorityCommandSchema,
} from '@dorkos/shared/connector-managed-schemas';
import { schema } from '@/db/client';
import { readManagedConnectorConfig, managedCapabilityAvailability } from './config';
import { cleanupManagedEventBinding } from './event-authority-service';
import {
  managedRequestHash,
  type ManagedCleanupPrincipal,
  type ManagedConnectorDatabase,
  type ManagedAuthorityProviderContext,
} from './authority-service';

/**
 * In-process composition seam for background cleanup; it cannot create
 * authority or replace the persisted provider generation. `events` is absent
 * when this deployment does not run managed events.
 */
export type ManagedCleanupProvider = (
  providerUserId: string,
  signal: AbortSignal
) =>
  | Pick<ManagedAuthorityProviderContext, 'events' | 'accounts' | 'executionConfigDigest'>
  | undefined;

/**
 * The deployment's own provider clients for one tenant's background cleanup,
 * or undefined when managed connections are not configured here (the cleanup
 * then stays owed and a later pass retries it).
 *
 * @param providerUserId - The tenant's server-derived provider user id.
 */
export function productionManagedCleanupProvider(
  providerUserId: string
): ReturnType<ManagedCleanupProvider> {
  let config: ReturnType<typeof readManagedConnectorConfig>;
  try {
    config = readManagedConnectorConfig();
  } catch {
    return undefined;
  }
  if (managedCapabilityAvailability(config, 'catalog').status !== 'available') return undefined;
  const clients = createComposioHostedClients({
    apiKey: config.projectApiKey!,
    serverUserId: providerUserId,
    authConfigByToolkit: config.authConfigByToolkit,
    ...(config.apiOrigin && { baseUrl: config.apiOrigin }),
  });
  return {
    accounts: clients.accounts,
    executionConfigDigest: clients.executionConfigDigest,
    ...(managedCapabilityAvailability(config, 'events').status === 'available' && {
      events: new ComposioEventClient({
        apiKey: config.projectApiKey!,
        serverUserId: providerUserId,
        webhookSecret: config.webhookSecret,
        ...(config.apiOrigin && { baseUrl: config.apiOrigin }),
      }),
    }),
  };
}

/**
 * The authority one receipt's cleanup runs under: its instance's revocation
 * when the instance is revoked, otherwise that instance's own exact live key.
 * Returns null when neither holds (a disabled key on a live instance waits).
 */
async function cleanupPrincipal(
  db: ManagedConnectorDatabase,
  receipt: typeof schema.managedConnectorAuthorityCommand.$inferSelect,
  ownerId: string
): Promise<ManagedCleanupPrincipal | null> {
  const identity = { ownerId, tenantId: receipt.tenantId, instanceId: receipt.instanceId };
  const [instance] = await db
    .select({ revokedAt: schema.instance.revokedAt })
    .from(schema.instance)
    .where(and(eq(schema.instance.id, receipt.instanceId), eq(schema.instance.userId, ownerId)))
    .limit(1);
  if (!instance) return null;
  if (instance.revokedAt) return { revokedInstance: true, ...identity };
  // A same-owner sibling key is not this receipt's instance authority. No secret
  // is loaded and no key is created or enabled by maintenance.
  const [key] = await db
    .select({ id: schema.apikey.id })
    .from(schema.apikey)
    .where(
      and(
        eq(schema.apikey.referenceId, ownerId),
        eq(schema.apikey.enabled, true),
        or(isNull(schema.apikey.expiresAt), gt(schema.apikey.expiresAt, new Date())),
        sql`${schema.apikey.metadata}::jsonb @> ${JSON.stringify({ instanceId: receipt.instanceId, scope: 'instance' })}::jsonb`,
        sql`${schema.apikey.permissions}::jsonb @> ${JSON.stringify(MANAGED_CONNECTOR_AUTHORITY_PERMISSIONS)}::jsonb`
      )
    )
    .limit(1);
  return key ? { ...identity, keyId: key.id } : null;
}

/**
 * Reconcile a bounded page of captured trigger cleanup receipts, even while the
 * local instance is offline.
 *
 * A receipt runs under its instance's exact live key, or, once that instance is
 * revoked, under the revocation itself: a revoked machine's triggers are still
 * owed their deletion, and no key will ever come back for it.
 *
 * @param db - The site database.
 * @param signal - Stops the pass between receipts.
 * @param resolveProvider - Provider clients for one tenant.
 * @param limit - Receipts per pass (1-100).
 * @param clock - The pass's notion of now.
 * @param scope - Limit the pass to one linked instance's receipts.
 */
export async function recoverManagedEventCleanup(
  db: ManagedConnectorDatabase,
  signal: AbortSignal,
  resolveProvider: ManagedCleanupProvider = productionManagedCleanupProvider,
  limit = 25,
  clock: () => Date = () => new Date(),
  scope: { instanceId?: string } = {}
): Promise<{ examined: number; completed: number }> {
  if (signal.aborted) return { examined: 0, completed: 0 };
  const now = clock();
  const retryAt = new Date(now.getTime() + 30_000);
  const c = schema.managedConnectorAuthorityCommand;
  const t = schema.connectorTenant;
  const b = schema.managedConnectorEventBinding;
  const p = schema.managedConnectorProvider;
  const rows = await db
    .select({ receipt: c, ownerId: t.ownerUserId, providerUserId: t.providerUserId, provider: p })
    .from(c)
    .innerJoin(t, eq(t.id, c.tenantId))
    .innerJoin(b, and(eq(b.tenantId, c.tenantId), eq(b.id, c.eventBindingId)))
    .innerJoin(
      p,
      and(
        eq(p.tenantId, b.tenantId),
        eq(p.id, b.providerInstanceId),
        eq(p.materialGeneration, b.providerGeneration),
        eq(p.enabled, true)
      )
    )
    .where(
      and(
        eq(c.kind, 'set_event_subscription'),
        inArray(c.state, ['applied', 'superseded']),
        eq(c.externalCleanup, 'pending'),
        or(isNull(c.eventCleanupAfter), lte(c.eventCleanupAfter, now)),
        ...(scope.instanceId ? [eq(c.instanceId, scope.instanceId)] : [])
      )
    )
    .orderBy(
      sql`coalesce(${c.eventCleanupAfter}, ${c.createdAt})`,
      c.tenantId,
      c.instanceId,
      c.commandId
    )
    .limit(Math.max(1, Math.min(100, limit)));
  let completed = 0;
  let examined = 0;
  for (const row of rows) {
    if (signal.aborted) break;
    // A scheduling claim is private retry bookkeeping, not provider authority.
    // Persist it before awaits so blocked rows cannot occupy every future page.
    const [claimed] = await db
      .update(c)
      .set({ eventCleanupAfter: retryAt })
      .where(
        and(
          eq(c.tenantId, row.receipt.tenantId),
          eq(c.instanceId, row.receipt.instanceId),
          eq(c.commandId, row.receipt.commandId),
          eq(c.kind, 'set_event_subscription'),
          eq(c.state, row.receipt.state),
          eq(c.externalCleanup, 'pending'),
          eq(c.requestHash, row.receipt.requestHash),
          or(isNull(c.eventCleanupAfter), lte(c.eventCleanupAfter, now))
        )
      )
      .returning({ commandId: c.commandId });
    if (!claimed) continue;
    examined++;
    try {
      const parsed = ManagedConnectorAuthorityCommandSchema.safeParse(row.receipt.requestPayload);
      if (
        !parsed.success ||
        parsed.data.kind !== 'set_event_subscription' ||
        !(
          (row.receipt.state === 'applied' && !parsed.data.enabled) ||
          (row.receipt.state === 'superseded' && parsed.data.enabled)
        ) ||
        parsed.data.commandId !== row.receipt.commandId ||
        parsed.data.managedConnectionId !== row.receipt.connectionId ||
        managedRequestHash(parsed.data) !== row.receipt.requestHash
      )
        continue;
      const principal = await cleanupPrincipal(db, row.receipt, row.ownerId);
      if (!principal) continue;
      const provider = resolveProvider(row.providerUserId, signal);
      if (!provider?.events || provider.executionConfigDigest !== row.provider.configurationDigest)
        continue;
      await cleanupManagedEventBinding(db, principal, parsed.data, row.receipt, {
        ...provider,
        providerUserId: row.providerUserId,
        materialGeneration: row.provider.materialGeneration,
        signal,
      });
      const [settled] = await db
        .select({ externalCleanup: c.externalCleanup })
        .from(c)
        .where(
          and(
            eq(c.tenantId, row.receipt.tenantId),
            eq(c.instanceId, row.receipt.instanceId),
            eq(c.commandId, row.receipt.commandId),
            eq(c.requestHash, row.receipt.requestHash),
            eq(c.state, row.receipt.state)
          )
        );
      if (settled && ['complete', 'not_required'].includes(settled.externalCleanup)) completed++;
    } catch {
      /* Keep the durable cleanup receipt pending for the next bounded pass. */
    }
  }
  return { examined, completed };
}
