/** Event metadata transitions preserve history and close superseded receive consent atomically. */
import { and, eq } from 'drizzle-orm';
import { ConnectorEventDefinitionSchema } from '@dorkos/shared/connector-event-schemas';
import type {
  ConnectorEventCapability,
  ConnectorEventPageRequest,
} from '@dorkos/shared/connector-events';
import { schema } from '@/db/client';
import { lockLiveAuthorityPrincipal } from './authority-service';
import { lockManagedEventCapacity } from './event-capacity-service';
import type { ManagedConnectorRequestContext } from './request-context';

/** Return exact server-owned event identities only after current provider material is rechecked. */
export async function listManagedEventDefinitions(
  context: Pick<
    Extract<ManagedConnectorRequestContext, { status: 'ok' }>,
    'principal' | 'db' | 'materialGeneration' | 'executionConfigDigest'
  > & { events?: Pick<ConnectorEventCapability, 'listDefinitions'> },
  request: ConnectorEventPageRequest
) {
  if (!context.events) throw new Error('Account events are unavailable.');
  const page = await context.events.listDefinitions(request);
  return context.db.transaction(async (tx) => {
    await lockManagedEventCapacity(tx, context.principal.tenantId);
    await lockLiveAuthorityPrincipal(tx, context.principal);
    const [provider] = await tx
      .select()
      .from(schema.managedConnectorProvider)
      .where(
        and(
          eq(schema.managedConnectorProvider.tenantId, context.principal.tenantId),
          eq(schema.managedConnectorProvider.id, 'managed:composio'),
          eq(schema.managedConnectorProvider.materialGeneration, context.materialGeneration),
          eq(schema.managedConnectorProvider.configurationDigest, context.executionConfigDigest),
          eq(schema.managedConnectorProvider.enabled, true)
        )
      )
      .for('update');
    if (!provider) throw new Error('Account events are unavailable.');
    // The provider row serializes discovery transitions across sibling instances.
    const result = [];
    for (const raw of page.definitions) {
      const definition = ConnectorEventDefinitionSchema.parse(raw);
      if (
        definition.toolkit !== request.toolkit ||
        definition.toolkitVersion !== request.toolkitVersion
      )
        throw new Error('Event definition changed.');
      const table = schema.managedConnectorEventDefinition;
      const identity = and(
        eq(table.tenantId, context.principal.tenantId),
        eq(table.providerInstanceId, provider.id),
        eq(table.toolkit, definition.toolkit),
        eq(table.eventType, definition.eventType)
      );
      const [prior] = await tx
        .select()
        .from(table)
        .where(and(identity, eq(table.current, true)));
      if (prior?.definitionHash === definition.definitionHash) {
        result.push({ ...definition, hostedDefinitionId: prior.id });
        continue;
      }
      await tx.update(table).set({ current: false }).where(identity);
      if (prior) {
        const oldBindings = await tx
          .select({ id: schema.managedConnectorEventBinding.id })
          .from(schema.managedConnectorEventBinding)
          .where(
            and(
              eq(schema.managedConnectorEventBinding.tenantId, context.principal.tenantId),
              eq(schema.managedConnectorEventBinding.definitionId, prior.id)
            )
          );
        for (const binding of oldBindings)
          await tx
            .update(schema.managedConnectorEventSubscription)
            .set({ enabled: false, revokedAt: new Date(), updatedAt: new Date() })
            .where(
              and(
                eq(schema.managedConnectorEventSubscription.tenantId, context.principal.tenantId),
                eq(schema.managedConnectorEventSubscription.bindingId, binding.id)
              )
            );
      }
      const [created] = await tx
        .insert(table)
        .values({
          tenantId: context.principal.tenantId,
          providerInstanceId: provider.id,
          toolkit: definition.toolkit,
          eventType: definition.eventType,
          definitionHash: definition.definitionHash,
          definition,
        })
        .returning();
      result.push({ ...definition, hostedDefinitionId: created.id });
    }
    return { definitions: result, ...(page.nextCursor && { nextCursor: page.nextCursor }) };
  });
}
