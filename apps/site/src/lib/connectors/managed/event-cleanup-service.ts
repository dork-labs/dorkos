/** Private disable-only reconciliation invoked by the existing authenticated cleanup job. */
import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
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
  type ManagedConnectorDatabase,
  type ManagedAuthorityProviderContext,
} from './authority-service';

/** In-process composition seam; it cannot create authority or replace the persisted provider generation. */
export type ManagedEventCleanupProvider = (
  providerUserId: string,
  signal: AbortSignal
) =>
  | Pick<ManagedAuthorityProviderContext, 'events' | 'accounts' | 'executionConfigDigest'>
  | undefined;

function productionProvider(providerUserId: string) {
  const config = readManagedConnectorConfig();
  if (managedCapabilityAvailability(config, 'events').status !== 'available') return undefined;
  const clients = createComposioHostedClients({
    apiKey: config.projectApiKey!,
    serverUserId: providerUserId,
    authConfigByToolkit: config.authConfigByToolkit,
    ...(config.apiOrigin && { baseUrl: config.apiOrigin }),
  });
  return {
    accounts: clients.accounts,
    executionConfigDigest: clients.executionConfigDigest,
    events: new ComposioEventClient({
      apiKey: config.projectApiKey!,
      serverUserId: providerUserId,
      webhookSecret: config.webhookSecret,
      ...(config.apiOrigin && { baseUrl: config.apiOrigin }),
    }),
  };
}

/** Reconcile a bounded page of already-applied disable receipts, even while the local instance is offline. */
export async function recoverManagedEventCleanup(
  db: ManagedConnectorDatabase,
  signal: AbortSignal,
  resolveProvider: ManagedEventCleanupProvider = productionProvider,
  limit = 25,
  clock: () => Date = () => new Date()
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
        eq(c.state, 'applied'),
        eq(c.externalCleanup, 'pending'),
        or(isNull(c.eventCleanupAfter), lte(c.eventCleanupAfter, now))
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
          eq(c.state, 'applied'),
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
        parsed.data.enabled ||
        parsed.data.commandId !== row.receipt.commandId ||
        parsed.data.managedConnectionId !== row.receipt.connectionId ||
        managedRequestHash(parsed.data) !== row.receipt.requestHash
      )
        continue;
      // A same-owner sibling key is not this receipt's instance authority. No secret
      // is loaded and no key is created or enabled by maintenance.
      const [key] = await db
        .select({ id: schema.apikey.id })
        .from(schema.apikey)
        .innerJoin(
          schema.instance,
          and(
            eq(schema.instance.id, row.receipt.instanceId),
            eq(schema.instance.userId, row.ownerId),
            isNull(schema.instance.revokedAt)
          )
        )
        .where(
          and(
            eq(schema.apikey.referenceId, row.ownerId),
            eq(schema.apikey.enabled, true),
            or(isNull(schema.apikey.expiresAt), gt(schema.apikey.expiresAt, new Date())),
            sql`${schema.apikey.metadata}::jsonb @> ${JSON.stringify({ instanceId: row.receipt.instanceId, scope: 'instance' })}::jsonb`,
            sql`${schema.apikey.permissions}::jsonb @> ${JSON.stringify(MANAGED_CONNECTOR_AUTHORITY_PERMISSIONS)}::jsonb`
          )
        )
        .limit(1);
      if (!key) continue;
      const provider = resolveProvider(row.providerUserId, signal);
      if (!provider?.events || provider.executionConfigDigest !== row.provider.configurationDigest)
        continue;
      const result = await cleanupManagedEventBinding(
        db,
        {
          ownerId: row.ownerId,
          tenantId: row.receipt.tenantId,
          instanceId: row.receipt.instanceId,
          keyId: key.id,
        },
        parsed.data,
        row.receipt,
        {
          ...provider,
          providerUserId: row.providerUserId,
          materialGeneration: row.provider.materialGeneration,
          signal,
        }
      );
      if (
        result.state === 'applied' &&
        ['complete', 'not_required'].includes(result.externalCleanup)
      )
        completed++;
    } catch {
      /* Keep the durable cleanup receipt pending for the next bounded pass. */
    }
  }
  return { examined, completed };
}
