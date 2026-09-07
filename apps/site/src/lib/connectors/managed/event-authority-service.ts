/** Existing authority-command receipts govern hosted event consent and physical trigger setup. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { stableStringify } from '@dorkos/shared/capabilities';
import { ConnectorEventDefinitionSchema } from '@dorkos/shared/connector-event-schemas';
import type { ConnectorPhysicalTrigger } from '@dorkos/shared/connector-events';
import type {
  ManagedConnectorAuthorityCommand,
  ManagedConnectorAuthorityCommandStatus,
} from '@dorkos/shared/connector-managed-schemas';
import { schema } from '@/db/client';
import {
  lockLiveAuthorityPrincipal,
  managedRequestHash,
  type ManagedConnectorDatabase,
  type ManagedConnectorPrincipal,
  type ManagedAuthorityProviderContext,
} from './authority-service';

type EventCommand = Extract<ManagedConnectorAuthorityCommand, { kind: 'set_event_subscription' }>;
type Transaction = Parameters<Parameters<ManagedConnectorDatabase['transaction']>[0]>[0];
const commands = schema.managedConnectorAuthorityCommand;
const subscriptions = schema.managedConnectorEventSubscription;
const bindings = schema.managedConnectorEventBinding;
const definitions = schema.managedConnectorEventDefinition;

function status(row: typeof commands.$inferSelect): ManagedConnectorAuthorityCommandStatus {
  const base = {
    version: 1 as const,
    commandId: row.commandId,
    managedConnectionId: row.connectionId,
    scopeVersion: row.scopeVersion,
  };
  if (row.state === 'applied')
    return {
      ...base,
      state: 'applied',
      appliedEventScopeHash: row.appliedEventScopeHash ?? undefined,
      externalCleanup: row.externalCleanup,
    };
  if (row.state === 'rejected')
    return {
      ...base,
      state: 'rejected',
      rejectionCode: row.rejectionCode as Extract<
        ManagedConnectorAuthorityCommandStatus,
        { state: 'rejected' }
      >['rejectionCode'],
    };
  return { ...base, state: row.state };
}
function commandWhere(principal: ManagedConnectorPrincipal, command: EventCommand) {
  return and(
    eq(commands.tenantId, principal.tenantId),
    eq(commands.instanceId, principal.instanceId),
    eq(commands.commandId, command.commandId)
  );
}

async function current(
  tx: Transaction,
  principal: ManagedConnectorPrincipal,
  command: EventCommand,
  bindingId: string,
  worker: string,
  provider: ManagedAuthorityProviderContext
) {
  await lockLiveAuthorityPrincipal(tx, principal);
  const c = schema.managedConnectorConnection;
  const p = schema.managedConnectorProvider;
  const [row] = await tx
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .innerJoin(
      bindings,
      and(eq(bindings.tenantId, subscriptions.tenantId), eq(bindings.id, subscriptions.bindingId))
    )
    .innerJoin(
      definitions,
      and(eq(definitions.tenantId, bindings.tenantId), eq(definitions.id, bindings.definitionId))
    )
    .innerJoin(c, and(eq(c.tenantId, subscriptions.tenantId), eq(c.id, subscriptions.connectionId)))
    .innerJoin(p, and(eq(p.tenantId, bindings.tenantId), eq(p.id, bindings.providerInstanceId)))
    .innerJoin(
      commands,
      and(
        eq(commands.tenantId, subscriptions.tenantId),
        eq(commands.connectionId, subscriptions.connectionId),
        commandWhere(principal, command)
      )
    )
    .where(
      and(
        eq(subscriptions.tenantId, principal.tenantId),
        eq(subscriptions.id, command.subscriptionId),
        eq(subscriptions.scopeVersion, command.subscriptionVersion),
        isNull(subscriptions.revokedAt),
        eq(subscriptions.targetInstanceId, principal.instanceId),
        eq(bindings.id, bindingId),
        eq(bindings.leaseOwner, worker),
        sql`${bindings.leasedUntil} > now()`,
        eq(definitions.id, command.hostedDefinitionId),
        eq(definitions.current, true),
        eq(c.originatingInstanceId, principal.instanceId),
        eq(c.lifecycle, 'active'),
        eq(c.authenticationStatus, 'active'),
        eq(c.bindingGeneration, subscriptions.connectionGeneration),
        eq(c.externalAccountRef, bindings.externalAccountRef),
        eq(c.providerUserId, provider.providerUserId),
        eq(c.materialGeneration, provider.materialGeneration),
        eq(bindings.providerGeneration, provider.materialGeneration),
        eq(p.materialGeneration, provider.materialGeneration),
        eq(p.configurationDigest, provider.executionConfigDigest),
        eq(p.enabled, true),
        eq(commands.state, 'pending'),
        // A later event command must supersede this setup even before it finishes.
        sql`NOT EXISTS (SELECT 1 FROM managed_connector_authority_command newer WHERE newer.tenant_id = ${principal.tenantId} AND newer.instance_id = ${principal.instanceId}
        AND newer.connection_id = ${command.managedConnectionId} AND newer.scope_key = ${`event:${command.subscriptionId}`} AND newer.scope_version > ${command.scopeVersion})`
      )
    )
    .for('update');
  return Boolean(row);
}

/** Apply receive consent beneath the existing exact instance key and command ledger. */
export async function applyManagedEventAuthorityCommand(
  db: ManagedConnectorDatabase,
  principal: ManagedConnectorPrincipal,
  command: EventCommand,
  provider?: ManagedAuthorityProviderContext
): Promise<{ status: ManagedConnectorAuthorityCommandStatus; conflict: boolean }> {
  const requestHash = managedRequestHash(command);
  const claim = await db.transaction(async (tx) => {
    await lockLiveAuthorityPrincipal(tx, principal);
    const [tenant] = await tx
      .select()
      .from(schema.connectorTenant)
      .where(
        and(
          eq(schema.connectorTenant.id, principal.tenantId),
          eq(schema.connectorTenant.ownerUserId, principal.ownerId)
        )
      );
    if (!tenant) throw new Error('Event authority unavailable.');
    const [existing] = await tx.select().from(commands).where(commandWhere(principal, command));
    if (existing) return { row: existing, conflict: existing.requestHash !== requestHash };
    const [connection] = await tx
      .select()
      .from(schema.managedConnectorConnection)
      .where(
        and(
          eq(schema.managedConnectorConnection.tenantId, principal.tenantId),
          eq(schema.managedConnectorConnection.id, command.managedConnectionId),
          eq(schema.managedConnectorConnection.originatingInstanceId, principal.instanceId),
          eq(schema.managedConnectorConnection.providerUserId, tenant.providerUserId)
        )
      )
      .for('update');
    const [latest] = await tx
      .select()
      .from(commands)
      .where(
        and(
          eq(commands.tenantId, principal.tenantId),
          eq(commands.instanceId, principal.instanceId),
          eq(commands.connectionId, command.managedConnectionId),
          eq(commands.scopeKey, `event:${command.subscriptionId}`)
        )
      )
      .orderBy(desc(commands.scopeVersion))
      .limit(1);
    let state: 'pending' | 'applied' | 'rejected' | 'superseded' = command.enabled
      ? 'pending'
      : 'applied';
    let rejectionCode: string | null = null;
    if (!connection) {
      state = 'rejected';
      rejectionCode = 'connection_unavailable';
    } else if (latest && latest.scopeVersion >= command.scopeVersion) state = 'superseded';
    const [priorSubscription] = await tx
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.tenantId, principal.tenantId),
          eq(subscriptions.id, command.subscriptionId)
        )
      )
      .for('update');
    if (
      priorSubscription &&
      (priorSubscription.connectionId !== command.managedConnectionId ||
        priorSubscription.targetInstanceId !== principal.instanceId ||
        priorSubscription.scopeVersion >= command.subscriptionVersion)
    ) {
      state = 'rejected';
      rejectionCode = 'scope_conflict';
    }
    const now = new Date();
    if (state === 'pending' && connection) {
      const [definition] = await tx
        .select()
        .from(definitions)
        .where(
          and(
            eq(definitions.tenantId, principal.tenantId),
            eq(definitions.id, command.hostedDefinitionId),
            eq(definitions.providerInstanceId, connection.providerInstanceId),
            eq(definitions.toolkit, connection.toolkit),
            eq(definitions.current, true)
          )
        )
        .for('update');
      if (!definition) {
        state = 'rejected';
        rejectionCode = 'event_definition_unavailable';
      } else if (
        connection.lifecycle !== 'active' ||
        connection.authenticationStatus !== 'active'
      ) {
        state = 'rejected';
        rejectionCode = 'connection_unavailable';
      } else {
        const metadata = ConnectorEventDefinitionSchema.parse(definition.definition);
        const filter = stableStringify(command.filter);
        try {
          if (
            Buffer.byteLength(filter) > 32_768 ||
            stableStringify(z.fromJSONSchema(metadata.filterSchema).parse(command.filter)) !==
              filter
          )
            throw new Error();
        } catch {
          state = 'rejected';
          rejectionCode = 'invalid_event_filter';
        }
        if (state === 'pending') {
          const filterHash = managedRequestHash(command.filter);
          const scope = and(
            eq(bindings.tenantId, principal.tenantId),
            eq(bindings.providerInstanceId, connection.providerInstanceId),
            eq(bindings.providerGeneration, connection.materialGeneration),
            eq(bindings.externalAccountRef, connection.externalAccountRef),
            eq(bindings.definitionId, definition.id),
            eq(bindings.filterHash, filterHash)
          );
          await tx
            .insert(bindings)
            .values({
              tenantId: principal.tenantId,
              providerInstanceId: connection.providerInstanceId,
              providerGeneration: connection.materialGeneration,
              externalAccountRef: connection.externalAccountRef,
              definitionId: definition.id,
              filterHash,
              filter: command.filter,
            })
            .onConflictDoNothing();
          const [binding] = await tx.select().from(bindings).where(scope).for('update');
          if (!binding) throw new Error('Event binding unavailable.');
          const value = {
            connectionId: connection.id,
            targetInstanceId: principal.instanceId,
            bindingId: binding.id,
            agentId: command.agentId,
            destinationKind: command.destination.kind,
            destinationId: command.destination.id,
            scopeVersion: command.subscriptionVersion,
            connectionGeneration: connection.bindingGeneration,
            enabled: false,
            revokedAt: null,
            updatedAt: now,
          };
          await tx
            .insert(subscriptions)
            .values({ tenantId: principal.tenantId, id: command.subscriptionId, ...value })
            .onConflictDoUpdate({ target: [subscriptions.tenantId, subscriptions.id], set: value });
        }
      }
    }
    if (state === 'applied' && !command.enabled && priorSubscription)
      await tx
        .update(subscriptions)
        .set({
          enabled: false,
          scopeVersion: command.subscriptionVersion,
          revokedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(subscriptions.tenantId, principal.tenantId),
            eq(subscriptions.id, command.subscriptionId)
          )
        );
    const [row] = await tx
      .insert(commands)
      .values({
        tenantId: principal.tenantId,
        instanceId: principal.instanceId,
        commandId: command.commandId,
        requestHash,
        connectionId: command.managedConnectionId,
        kind: command.kind,
        agentId: command.agentId,
        scopeKey: `event:${command.subscriptionId}`,
        scopeVersion: command.scopeVersion,
        requestPayload: command as unknown as Record<string, unknown>,
        state,
        rejectionCode,
        appliedEventScopeHash: state === 'applied' ? requestHash : null,
        eventBindingId: !command.enabled ? (priorSubscription?.bindingId ?? null) : null,
        externalCleanup:
          state === 'applied' && !command.enabled && priorSubscription ? 'pending' : 'not_required',
      })
      .returning();
    return { row, conflict: false };
  });
  if (
    !claim.conflict &&
    claim.row.state === 'applied' &&
    !command.enabled &&
    claim.row.externalCleanup === 'pending' &&
    provider?.events
  ) {
    return {
      status: await cleanupManagedEventBinding(db, principal, command, claim.row, provider),
      conflict: false,
    };
  }
  if (claim.conflict || claim.row.state !== 'pending' || !provider?.events)
    return { status: status(claim.row), conflict: claim.conflict };
  const worker = randomUUID();
  const claimedAt = new Date();
  const binding = await db.transaction(async (tx) => {
    await lockLiveAuthorityPrincipal(tx, principal);
    const [subscription] = await tx
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.tenantId, principal.tenantId),
          eq(subscriptions.id, command.subscriptionId),
          eq(subscriptions.scopeVersion, command.subscriptionVersion),
          isNull(subscriptions.revokedAt)
        )
      );
    if (!subscription) return undefined;
    const [held] = await tx
      .update(bindings)
      .set({ leaseOwner: worker, leasedUntil: new Date(claimedAt.getTime() + 60_000) })
      .where(
        and(
          eq(bindings.tenantId, principal.tenantId),
          eq(bindings.id, subscription.bindingId),
          or(isNull(bindings.leaseOwner), lte(bindings.leasedUntil, claimedAt))
        )
      )
      .returning();
    return held;
  });
  if (!binding) return { status: status(claim.row), conflict: false };
  try {
    const [definition] = await db
      .select()
      .from(definitions)
      .where(
        and(eq(definitions.tenantId, principal.tenantId), eq(definitions.id, binding.definitionId))
      );
    const scope = {
      externalAccountRef: binding.externalAccountRef,
      definition: ConnectorEventDefinitionSchema.parse(definition.definition),
      filter: binding.filter,
      signal: provider.signal,
    };
    const authorizeDispatch = () =>
      db.transaction((tx) => current(tx, principal, command, binding.id, worker, provider));
    if (!(await authorizeDispatch())) return { status: status(claim.row), conflict: false };
    // Current local account state is insufficient proof of remote authentication.
    // Recheck the exact account before the trigger mutation, without exposing its body.
    try {
      const account = await provider.accounts.getAccount(
        binding.externalAccountRef,
        provider.signal
      );
      const [connection] = await db
        .select()
        .from(schema.managedConnectorConnection)
        .where(
          and(
            eq(schema.managedConnectorConnection.tenantId, principal.tenantId),
            eq(schema.managedConnectorConnection.id, command.managedConnectionId)
          )
        );
      if (
        !connection ||
        account.connectedAccountId !== binding.externalAccountRef ||
        account.providerUserId !== provider.providerUserId ||
        account.status !== 'ACTIVE' ||
        account.toolkit !== connection.toolkit ||
        account.authConfigId !== connection.authConfigId
      )
        return { status: status(claim.row), conflict: false };
    } catch {
      return { status: status(claim.row), conflict: false };
    }
    const found = await provider.events.reconcileTrigger(scope);
    if (found.status === 'ambiguous' || found.status === 'unavailable')
      return { status: status(claim.row), conflict: false };
    let trigger: ConnectorPhysicalTrigger;
    if (found.status === 'found') {
      trigger = found.trigger;
      if (!trigger.enabled) {
        const enabled = await provider.events.setTriggerEnabled({
          providerTriggerRef: trigger.providerTriggerRef,
          enabled: true,
          signal: provider.signal,
          authorizeDispatch,
        });
        if (enabled.status !== 'ok') {
          if (enabled.status === 'outcome_unknown') await unknown();
          return { status: status(claim.row), conflict: false };
        }
        trigger = { ...trigger, enabled: true };
      }
    } else {
      if (binding.state === 'outcome_unknown')
        return { status: status(claim.row), conflict: false };
      const created = await provider.events.createTrigger({ ...scope, authorizeDispatch });
      if (created.status !== 'ready') {
        if (created.status === 'outcome_unknown') await unknown();
        return { status: status(claim.row), conflict: false };
      }
      const confirmed = await provider.events.reconcileTrigger(scope);
      if (
        confirmed.status !== 'found' ||
        ![confirmed.trigger.providerTriggerRef, confirmed.trigger.providerTriggerUuid].includes(
          created.providerTriggerRef
        )
      ) {
        await unknown();
        return { status: status(claim.row), conflict: false };
      }
      trigger = confirmed.trigger;
    }
    const finished = await db.transaction(async (tx) => {
      if (
        !trigger.enabled ||
        !(await current(tx, principal, command, binding.id, worker, provider))
      )
        return claim.row;
      await tx
        .update(bindings)
        .set({
          state: 'ready',
          providerTriggerRef: trigger.providerTriggerRef,
          providerTriggerUuid: trigger.providerTriggerUuid ?? null,
          externalAccountUuid: trigger.externalAccountUuid ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(bindings.tenantId, principal.tenantId),
            eq(bindings.id, binding.id),
            eq(bindings.leaseOwner, worker)
          )
        );
      await tx
        .update(subscriptions)
        .set({ enabled: true, updatedAt: new Date() })
        .where(
          and(
            eq(subscriptions.tenantId, principal.tenantId),
            eq(subscriptions.id, command.subscriptionId),
            eq(subscriptions.scopeVersion, command.subscriptionVersion),
            isNull(subscriptions.revokedAt)
          )
        );
      const [row] = await tx
        .update(commands)
        .set({ state: 'applied', appliedEventScopeHash: requestHash, updatedAt: new Date() })
        .where(commandWhere(principal, command))
        .returning();
      return row;
    });
    return { status: status(finished), conflict: false };
  } finally {
    await db
      .update(bindings)
      .set({ leaseOwner: null, leasedUntil: null })
      .where(
        and(
          eq(bindings.tenantId, principal.tenantId),
          eq(bindings.id, binding.id),
          eq(bindings.leaseOwner, worker)
        )
      );
  }
  async function unknown() {
    await db
      .update(bindings)
      .set({ state: 'outcome_unknown', updatedAt: new Date() })
      .where(
        and(
          eq(bindings.tenantId, principal.tenantId),
          eq(bindings.id, binding!.id),
          eq(bindings.leaseOwner, worker)
        )
      );
  }
}

/** Last-reference cleanup uses the captured physical identity, never a later subscription binding. */
export async function cleanupManagedEventBinding(
  db: ManagedConnectorDatabase,
  principal: ManagedConnectorPrincipal,
  command: EventCommand,
  receipt: typeof commands.$inferSelect,
  provider: ManagedAuthorityProviderContext
): Promise<ManagedConnectorAuthorityCommandStatus> {
  if (!receipt.eventBindingId || !provider.events) return status(receipt);
  const worker = randomUUID();
  const [binding] = await db
    .update(bindings)
    .set({ leaseOwner: worker, leasedUntil: new Date(Date.now() + 60_000) })
    .where(
      and(
        eq(bindings.tenantId, principal.tenantId),
        eq(bindings.id, receipt.eventBindingId),
        or(isNull(bindings.leaseOwner), lte(bindings.leasedUntil, new Date()))
      )
    )
    .returning();
  if (!binding) return status(receipt);
  const hasSubscribers = async (tx: Transaction) => {
    const active = await tx
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .innerJoin(
        bindings,
        and(eq(bindings.tenantId, subscriptions.tenantId), eq(bindings.id, subscriptions.bindingId))
      )
      .where(
        and(
          eq(bindings.tenantId, principal.tenantId),
          eq(bindings.providerInstanceId, binding.providerInstanceId),
          eq(bindings.externalAccountRef, binding.externalAccountRef),
          isNull(subscriptions.revokedAt),
          or(
            eq(bindings.id, binding.id),
            ...(binding.providerTriggerRef
              ? [eq(bindings.providerTriggerRef, binding.providerTriggerRef)]
              : [])
          )
        )
      )
      .limit(1);
    return active.length > 0;
  };
  const liveClaim = async (tx: Transaction) => {
    await lockLiveAuthorityPrincipal(tx, principal);
    const [live] = await tx
      .select({ id: bindings.id })
      .from(bindings)
      .innerJoin(
        schema.managedConnectorProvider,
        and(
          eq(schema.managedConnectorProvider.tenantId, bindings.tenantId),
          eq(schema.managedConnectorProvider.id, bindings.providerInstanceId)
        )
      )
      .where(
        and(
          eq(bindings.tenantId, principal.tenantId),
          eq(bindings.id, binding.id),
          eq(bindings.leaseOwner, worker),
          sql`${bindings.leasedUntil} > now()`,
          eq(bindings.providerGeneration, provider.materialGeneration),
          eq(schema.managedConnectorProvider.materialGeneration, provider.materialGeneration),
          eq(schema.managedConnectorProvider.configurationDigest, provider.executionConfigDigest),
          eq(schema.managedConnectorProvider.enabled, true)
        )
      )
      .for('update');
    return Boolean(live);
  };
  const authorizeDispatch = () =>
    db.transaction(async (tx) => (await liveClaim(tx)) && !(await hasSubscribers(tx)));
  const finish = (externalCleanup: 'complete' | 'not_required') =>
    db.transaction(async (tx) => {
      if (!(await liveClaim(tx))) return status(receipt);
      const subscribersRemain = await hasSubscribers(tx);
      if (externalCleanup === 'complete' && subscribersRemain) return status(receipt);
      if (externalCleanup === 'complete')
        await tx
          .update(bindings)
          .set({ state: 'retired', updatedAt: new Date() })
          .where(
            and(
              eq(bindings.tenantId, principal.tenantId),
              eq(bindings.id, binding.id),
              eq(bindings.leaseOwner, worker)
            )
          );
      const [row] = await tx
        .update(commands)
        .set({ externalCleanup, updatedAt: new Date() })
        .where(
          and(
            commandWhere(principal, command),
            eq(commands.state, 'applied'),
            eq(commands.requestHash, receipt.requestHash),
            eq(commands.eventBindingId, binding.id),
            eq(commands.externalCleanup, 'pending')
          )
        )
        .returning();
      return status(row ?? receipt);
    });
  try {
    if (
      await db.transaction(async (tx) => {
        await lockLiveAuthorityPrincipal(tx, principal);
        return hasSubscribers(tx);
      })
    )
      return finish('not_required');
    if (!(await authorizeDispatch())) return status(receipt);
    if (!binding.providerTriggerRef) return finish('not_required');
    const [definition] = await db
      .select()
      .from(definitions)
      .where(
        and(eq(definitions.tenantId, principal.tenantId), eq(definitions.id, binding.definitionId))
      );
    const found = await provider.events.reconcileTrigger({
      externalAccountRef: binding.externalAccountRef,
      definition: ConnectorEventDefinitionSchema.parse(definition.definition),
      filter: binding.filter,
      signal: provider.signal,
    });
    if (found.status === 'absent') return finish('complete');
    if (
      found.status !== 'found' ||
      found.trigger.providerTriggerRef !== binding.providerTriggerRef ||
      (found.trigger.providerTriggerUuid ?? null) !== binding.providerTriggerUuid
    )
      return status(receipt);
    const deleted = await provider.events.deleteTrigger({
      providerTriggerRef: binding.providerTriggerRef,
      signal: provider.signal,
      authorizeDispatch,
    });
    if (deleted.status !== 'ok') return status(receipt);
    return finish('complete');
  } finally {
    await db
      .update(bindings)
      .set({ leaseOwner: null, leasedUntil: null })
      .where(
        and(
          eq(bindings.tenantId, principal.tenantId),
          eq(bindings.id, binding.id),
          eq(bindings.leaseOwner, worker)
        )
      );
  }
}
