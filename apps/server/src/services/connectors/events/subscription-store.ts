/** Durable owner-scoped event consent and private shared-trigger bindings. */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  and,
  connections,
  connectorProviderInstances,
  connectorEventDefinitions,
  connectorEventSubscriptions,
  eq,
  type Db,
} from '@dorkos/db';
import { stableStringify } from '@dorkos/shared/capabilities';
import {
  ConnectionEventSubscriptionSchema,
  type ConnectionEventSubscription,
  ConnectorEventDefinitionSchema,
  ConnectorReceiveScopeSchema,
  type ConnectorEventGrantSelection,
  type ConnectorEventDefinition,
  type ConnectorReceiveScope,
} from '@dorkos/shared/connector-event-schemas';
import { prepareEventReview, approvedEventSelections } from './subscription-review.js';
import type { ConnectorOwnerAuthority } from '../principal/server-principal.js';

/** Payload-free refusal at the explicit receive-consent boundary. */
export class ConnectorSubscriptionError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'definition_changed'
      | 'invalid_filter'
      | 'destination_unavailable'
      | 'events_unavailable'
      | 'review_conflict'
  ) {
    super('The event subscription is unavailable.');
  }
}

/** Stored private connection scope used for current-authority comparisons. */
export interface EventConnectionScope {
  id: string;
  providerInstanceId: string;
  providerGeneration: number;
  externalAccountRef: string;
  toolkit: string;
  mode: 'managed' | 'byo';
  ownerKind: 'user' | 'local_install' | null;
  ownerId: string | null;
}

/** Exact logical subscriber generation and physical scope, selected only from stored authority. */
export interface ActiveEventSubscription extends EventConnectionScope {
  subscriptionId: string;
  subscriptionVersion: number;
  agentId: string;
  destinationKind: 'agent' | 'room' | 'channel';
  destinationId: string;
  definitionId: string;
  bindingId: string;
  definition: ConnectorEventDefinition;
}

/** SQLite consent repository shared by ingress and final dispatch. */
export class ConnectorSubscriptionStore {
  constructor(readonly db: Db) {}

  /** Resolve one currently owned active account; caller input cannot select provider identity. */
  connection(
    owner: ConnectorOwnerAuthority,
    connectionId: string,
    requireActive = true
  ): EventConnectionScope {
    const ownerId = owner.kind === 'user' ? owner.userId : owner.installationId;
    const row = this.db
      .select({
        id: connections.id,
        providerInstanceId: connections.providerInstanceId,
        providerGeneration: connectorProviderInstances.executionConfigGeneration,
        externalAccountRef: connections.externalAccountRef,
        toolkit: connections.toolkit,
        mode: connectorProviderInstances.mode,
        ownerKind: connectorProviderInstances.ownerKind,
        ownerId: connectorProviderInstances.ownerId,
      })
      .from(connections)
      .innerJoin(
        connectorProviderInstances,
        eq(connections.providerInstanceId, connectorProviderInstances.id)
      )
      .where(
        and(
          eq(connections.id, connectionId),
          ...(requireActive
            ? [
                eq(connections.status, 'active'),
                eq(connections.enabled, true),
                eq(connections.lifecycleState, 'connected'),
                eq(connectorProviderInstances.status, 'available'),
              ]
            : []),
          eq(connectorProviderInstances.ownerKind, owner.kind),
          eq(connectorProviderInstances.ownerId, ownerId)
        )
      )
      .get();
    if (!row) throw new ConnectorSubscriptionError('not_found');
    return row;
  }

  /** Reconcile immutable definitions; a changed fingerprint requires fresh owner consent. */
  discover(
    expected: EventConnectionScope,
    definitions: Array<ConnectorEventDefinition & { providerDefinitionRef?: string }>,
    now: string
  ) {
    return this.db.transaction(() => {
      const owner = this.owner(expected);
      if (stableStringify(this.connection(owner, expected.id)) !== stableStringify(expected))
        throw new ConnectorSubscriptionError('definition_changed');
      return definitions.map((value) => {
        const { providerDefinitionRef = '', ...metadata } = value;
        const definition = ConnectorEventDefinitionSchema.parse(metadata);
        if (definition.toolkit !== expected.toolkit)
          throw new ConnectorSubscriptionError('definition_changed');
        const current = this.db.$client
          .prepare(
            'SELECT id, definition_hash, provider_definition_ref FROM connector_event_definitions WHERE provider_instance_id = ? AND toolkit = ? AND event_type = ? AND current = 1'
          )
          .get(expected.providerInstanceId, definition.toolkit, definition.eventType) as
          { id: string; definition_hash: string; provider_definition_ref: string } | undefined;
        if (
          current?.definition_hash === definition.definitionHash &&
          current.provider_definition_ref === providerDefinitionRef
        )
          return { id: current.id, ...definition };
        this.db.$client
          .prepare(
            'UPDATE connector_event_definitions SET current = 0 WHERE provider_instance_id = ? AND toolkit = ? AND event_type = ?'
          )
          .run(expected.providerInstanceId, definition.toolkit, definition.eventType);
        if (current)
          this.db.$client
            .prepare(
              'UPDATE connector_event_subscriptions SET enabled = 0, revoked_at = ?, updated_at = ? WHERE definition_id = ?'
            )
            .run(now, now, current.id);
        const id = randomUUID();
        this.db
          .insert(connectorEventDefinitions)
          .values({
            id,
            providerInstanceId: expected.providerInstanceId,
            toolkit: definition.toolkit,
            eventType: definition.eventType,
            toolkitVersion: definition.toolkitVersion,
            definitionHash: definition.definitionHash,
            providerDefinitionRef,
            definitionJson: JSON.stringify(definition),
            discoveredAt: now,
          })
          .run();
        return { id, ...definition };
      });
    });
  }

  /** Validate a current exact receive scope without creating consent or upstream resources. */
  describe(owner: ConnectorOwnerAuthority, scope: ConnectorReceiveScope) {
    const request = ConnectorReceiveScopeSchema.parse(scope);
    const connection = this.connection(owner, request.connectionId);
    const row = this.db
      .select()
      .from(connectorEventDefinitions)
      .where(
        and(
          eq(connectorEventDefinitions.id, request.definitionId),
          eq(connectorEventDefinitions.providerInstanceId, connection.providerInstanceId),
          eq(connectorEventDefinitions.toolkit, connection.toolkit),
          eq(connectorEventDefinitions.current, true)
        )
      )
      .get();
    if (!row) throw new ConnectorSubscriptionError('definition_changed');
    const definition = ConnectorEventDefinitionSchema.parse(JSON.parse(row.definitionJson));
    this.filter(definition, request.filter);
    return { definitionId: row.id, eventType: definition.eventType };
  }

  /** Prepare a new disabled subscription; only a matching completed binding may open it. */
  propose(owner: ConnectorOwnerAuthority, value: ConnectorReceiveScope, now: string) {
    const request = ConnectorReceiveScopeSchema.parse(value);
    return this.db.transaction(() => {
      const connection = this.connection(owner, request.connectionId);
      const definition = this.db
        .select()
        .from(connectorEventDefinitions)
        .where(
          and(
            eq(connectorEventDefinitions.id, request.definitionId),
            eq(connectorEventDefinitions.providerInstanceId, connection.providerInstanceId),
            eq(connectorEventDefinitions.toolkit, connection.toolkit),
            eq(connectorEventDefinitions.current, true)
          )
        )
        .get();
      if (!definition) throw new ConnectorSubscriptionError('definition_changed');
      const parsed = ConnectorEventDefinitionSchema.parse(JSON.parse(definition.definitionJson));
      const filterJson = this.filter(parsed, request.filter);
      const filterHash = createHash('sha256').update(filterJson).digest('hex');
      const binding = this.db.$client
        .prepare(
          `SELECT id FROM connector_event_bindings WHERE provider_instance_id = ? AND provider_generation = ?
         AND external_account_ref = ? AND definition_id = ? AND filter_hash = ?`
        )
        .get(
          connection.providerInstanceId,
          connection.providerGeneration,
          connection.externalAccountRef,
          definition.id,
          filterHash
        ) as { id: string } | undefined;
      const bindingId = binding?.id ?? randomUUID();
      if (!binding)
        this.db.$client
          .prepare(
            `INSERT INTO connector_event_bindings (id, provider_instance_id, provider_generation, external_account_ref, definition_id, filter_hash, filter_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            bindingId,
            connection.providerInstanceId,
            connection.providerGeneration,
            connection.externalAccountRef,
            definition.id,
            filterHash,
            filterJson,
            now,
            now
          );
      const existing = this.db.$client
        .prepare(
          `SELECT id, scope_version FROM connector_event_subscriptions WHERE connection_id = ? AND event_type = ?
         AND agent_id = ? AND destination_kind = ? AND destination_id = ? AND filter_hash = ?`
        )
        .get(
          connection.id,
          parsed.eventType,
          request.agentId,
          request.destination.kind,
          request.destination.id,
          filterHash
        ) as { id: string; scope_version: number } | undefined;
      const subscriptionId = existing?.id ?? randomUUID();
      const scopeVersion = (existing?.scope_version ?? 0) + 1;
      if (existing)
        this.db.$client
          .prepare(
            `UPDATE connector_event_subscriptions SET definition_id = ?, binding_id = ?, scope_version = ?, enabled = 0, revoked_at = NULL, updated_at = ? WHERE id = ?`
          )
          .run(definition.id, bindingId, scopeVersion, now, subscriptionId);
      else
        this.db
          .insert(connectorEventSubscriptions)
          .values({
            id: subscriptionId,
            connectionId: connection.id,
            agentId: request.agentId,
            destinationKind: request.destination.kind,
            destinationId: request.destination.id,
            eventType: parsed.eventType,
            definitionId: definition.id,
            bindingId,
            scopeVersion,
            filterHash,
            filterJson,
            deliveryMode: parsed.deliveryMode,
            enabled: false,
            createdBy: connection.ownerId!,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      return {
        subscriptionId,
        scopeVersion,
        bindingId,
        connection,
        definition: parsed,
        filter: JSON.parse(filterJson) as Record<string, unknown>,
      };
    });
  }

  /** Atomically select generations once for a server-owned review identity. */
  prepareReview(
    owner: ConnectorOwnerAuthority,
    reviewId: string,
    scopes: ConnectorReceiveScope[],
    manageExistingTriggers: boolean,
    now: string
  ) {
    return prepareEventReview(this, owner, reviewId, scopes, manageExistingTriggers, now);
  }

  /** Read a complete same-owner immutable approval receipt. */
  approvedSelections(owner: ConnectorOwnerAuthority, selections: ConnectorEventGrantSelection[]) {
    return approvedEventSelections(this, owner, selections);
  }

  /** Resolve a reviewed generation without creating, editing, or reopening it. */
  reviewedProposal(
    owner: ConnectorOwnerAuthority,
    selection: ConnectorEventGrantSelection,
    scope: ConnectorReceiveScope
  ): ReturnType<ConnectorSubscriptionStore['propose']> | undefined {
    try {
      const connection = this.connection(owner, scope.connectionId);
      const row = this.db.$client
        .prepare(
          `SELECT s.id, s.scope_version, s.binding_id, d.definition_json, s.filter_json
        FROM connector_event_subscriptions s JOIN connector_event_definitions d ON d.id = s.definition_id
        JOIN connector_event_bindings b ON b.id = s.binding_id
        WHERE s.id = ? AND s.scope_version = ? AND s.definition_id = ? AND s.revoked_at IS NULL AND d.current = 1
        AND s.connection_id = ? AND s.agent_id = ? AND s.destination_kind = ? AND s.destination_id = ?
        AND b.provider_instance_id = ? AND b.provider_generation = ? AND b.external_account_ref = ? AND b.definition_id = d.id
      `
        )
        .get(
          selection.subscriptionId,
          selection.scopeVersion,
          selection.definitionId,
          scope.connectionId,
          scope.agentId,
          scope.destination.kind,
          scope.destination.id,
          connection.providerInstanceId,
          connection.providerGeneration,
          connection.externalAccountRef
        ) as
        | {
            id: string;
            scope_version: number;
            binding_id: string;
            definition_json: string;
            filter_json: string;
          }
        | undefined;
      if (!row || row.filter_json !== stableStringify(scope.filter)) return undefined;
      return {
        subscriptionId: row.id,
        scopeVersion: row.scope_version,
        bindingId: row.binding_id,
        connection,
        definition: ConnectorEventDefinitionSchema.parse(JSON.parse(row.definition_json)),
        filter: JSON.parse(row.filter_json) as Record<string, unknown>,
      };
    } catch {
      return undefined;
    }
  }

  /** Final synchronous authority read used after all destination/provider awaits. */
  active(subscriptionId: string, version?: number): ActiveEventSubscription | undefined {
    const row = this.db.$client
      .prepare(
        `SELECT c.id, c.provider_instance_id, c.external_account_ref, c.toolkit, p.mode, p.owner_kind, p.owner_id,
       p.execution_config_generation AS provider_generation, s.id AS subscription_id, s.scope_version,
       s.agent_id, s.destination_kind, s.destination_id, s.definition_id, s.binding_id, d.definition_json
       FROM connector_event_subscriptions s JOIN connections c ON c.id = s.connection_id
       JOIN connector_provider_instances p ON p.id = c.provider_instance_id
       JOIN connector_event_definitions d ON d.id = s.definition_id
       JOIN connector_event_bindings b ON b.id = s.binding_id
       WHERE s.id = ? AND s.enabled = 1 AND s.revoked_at IS NULL AND c.enabled = 1
       AND c.status = 'active' AND c.lifecycle_state = 'connected' AND p.status = 'available'
       AND d.current = 1 AND b.state = 'ready' AND b.provider_instance_id = p.id
       AND b.provider_generation = p.execution_config_generation AND b.external_account_ref = c.external_account_ref
       AND b.definition_id = d.id AND d.provider_instance_id = p.id AND d.toolkit = c.toolkit`
      )
      .get(subscriptionId) as Record<string, string | number | null> | undefined;
    if (!row || (version !== undefined && row.scope_version !== version)) return undefined;
    return {
      id: String(row.id),
      providerInstanceId: String(row.provider_instance_id),
      providerGeneration: Number(row.provider_generation),
      externalAccountRef: String(row.external_account_ref),
      toolkit: String(row.toolkit),
      mode: row.mode as 'managed' | 'byo',
      ownerKind: row.owner_kind as EventConnectionScope['ownerKind'],
      ownerId: row.owner_id as string | null,
      subscriptionId: String(row.subscription_id),
      subscriptionVersion: Number(row.scope_version),
      agentId: String(row.agent_id),
      destinationKind: row.destination_kind as ActiveEventSubscription['destinationKind'],
      destinationId: String(row.destination_id),
      definitionId: String(row.definition_id),
      bindingId: String(row.binding_id),
      definition: ConnectorEventDefinitionSchema.parse(JSON.parse(String(row.definition_json))),
    };
  }

  /** Close receive authority immediately; shared upstream cleanup is a separate guarded step. */
  revoke(owner: ConnectorOwnerAuthority, subscriptionId: string, now: string): void {
    const subscription = this.db
      .select()
      .from(connectorEventSubscriptions)
      .where(eq(connectorEventSubscriptions.id, subscriptionId))
      .get();
    if (!subscription) throw new ConnectorSubscriptionError('not_found');
    this.connection(owner, subscription.connectionId, false);
    this.db.$client
      .prepare(
        'UPDATE connector_event_subscriptions SET enabled = 0, revoked_at = ?, updated_at = ?, scope_version = scope_version + 1 WHERE id = ? AND revoked_at IS NULL'
      )
      .run(now, now, subscriptionId);
  }

  /** Page payload-free subscription history beneath an exact owned connection. */
  list(owner: ConnectorOwnerAuthority, connectionId: string, cursor?: string) {
    this.connection(owner, connectionId, false);
    const ids = this.db.$client
      .prepare(
        'SELECT id FROM connector_event_subscriptions WHERE connection_id = ? AND id > ? ORDER BY id LIMIT 101'
      )
      .all(connectionId, cursor ?? '') as Array<{ id: string }>;
    const page = ids.slice(0, 100);
    return {
      subscriptions: page.map((row) => this.get(owner, connectionId, row.id)),
      ...(ids.length > 100 ? { nextCursor: page[page.length - 1]!.id } : {}),
    };
  }

  /** Resolve one public subscription without exposing protected content or upstream references. */
  get(
    owner: ConnectorOwnerAuthority,
    connectionId: string,
    subscriptionId: string
  ): ConnectionEventSubscription {
    this.connection(owner, connectionId, false);
    const row = this.db.$client
      .prepare(
        `SELECT s.*, d.definition_json, d.current, b.provider_generation, p.execution_config_generation
      FROM connector_event_subscriptions s JOIN connector_event_definitions d ON d.id = s.definition_id
      JOIN connector_event_bindings b ON b.id = s.binding_id JOIN connections c ON c.id = s.connection_id
      JOIN connector_provider_instances p ON p.id = c.provider_instance_id WHERE s.id = ? AND s.connection_id = ?`
      )
      .get(subscriptionId, connectionId) as
      | {
          id: string;
          connection_id: string;
          definition_id: string;
          definition_json: string;
          current: number;
          provider_generation: number;
          execution_config_generation: number;
          agent_id: string;
          destination_kind: string;
          destination_id: string;
          filter_json: string;
          scope_version: number;
          revoked_at: string | null;
        }
      | undefined;
    if (!row) throw new ConnectorSubscriptionError('not_found');
    const definition = ConnectorEventDefinitionSchema.parse(JSON.parse(row.definition_json));
    let state: ConnectionEventSubscription['state'] = 'pending';
    if (row.revoked_at) state = 'revoked';
    else if (!row.current || row.provider_generation !== row.execution_config_generation)
      state = 'unavailable';
    else {
      try {
        this.connection(owner, connectionId);
      } catch {
        state = 'unavailable';
      }
      if (state !== 'unavailable' && this.active(subscriptionId, row.scope_version))
        state = 'active';
    }
    return ConnectionEventSubscriptionSchema.parse({
      id: row.id,
      connectionId: row.connection_id,
      definitionId: row.definition_id,
      eventType: definition.eventType,
      displayName: definition.displayName,
      deliveryMode: definition.deliveryMode,
      expectedCadenceSeconds: definition.expectedCadenceSeconds,
      agentId: row.agent_id,
      destination: { kind: row.destination_kind, id: row.destination_id },
      filter: JSON.parse(row.filter_json),
      scopeVersion: row.scope_version,
      state,
    });
  }

  /** Recover the owner only from a private, stored connection scope. */
  owner(connection: EventConnectionScope): ConnectorOwnerAuthority {
    if (!connection.ownerId || !connection.ownerKind)
      throw new ConnectorSubscriptionError('not_found');
    return connection.ownerKind === 'user'
      ? { kind: 'user', userId: connection.ownerId }
      : { kind: 'local_install', installationId: connection.ownerId };
  }

  private filter(definition: ConnectorEventDefinition, filter: Record<string, unknown>): string {
    try {
      const serialized = stableStringify(filter);
      if (Buffer.byteLength(serialized) > 32_768) throw new Error();
      const parsed = z.fromJSONSchema(definition.filterSchema).parse(filter);
      if (stableStringify(parsed) !== serialized) throw new Error();
      return serialized;
    } catch {
      throw new ConnectorSubscriptionError('invalid_filter');
    }
  }
}
