/** Explicit receive-consent lifecycle with reference-safe upstream trigger reconciliation. */
import { randomUUID } from 'node:crypto';
import {
  ConnectorEventDefinitionSchema,
  type ConnectorEventDestination,
  type ConnectorReceiveScope,
} from '@dorkos/shared/connector-event-schemas';
import type {
  ConnectorEventCapability,
  ConnectorPhysicalTrigger,
} from '@dorkos/shared/connector-events';
import type { ConnectorProviderInstanceId } from '@dorkos/shared/connector-schemas';
import type { ConnectorOwnerAuthority } from '../principal/server-principal.js';
import type { ConnectorRegistry } from '../registry.js';
import { ConnectorSubscriptionError, ConnectorSubscriptionStore } from './subscription-store.js';

/** Existing owner, agent and destination policies resolved before consent or dispatch. */
export interface ConnectorEventDestinationPolicy {
  authorize(
    owner: ConnectorOwnerAuthority,
    agentId: string,
    destination: ConnectorEventDestination
  ): boolean | Promise<boolean>;
}

/** Owner-only subscription orchestration; agent proposals reach this only after explicit review. */
export class ConnectorSubscriptionService {
  constructor(
    private readonly store: ConnectorSubscriptionStore,
    private readonly registry: Pick<ConnectorRegistry, 'resolveProviderInstance'>,
    private readonly destinations: ConnectorEventDestinationPolicy,
    private readonly now = () => new Date().toISOString()
  ) {}

  /** Discover bounded immutable definitions for one owned account. */
  async discover(
    owner: ConnectorOwnerAuthority,
    connectionId: string,
    cursor: string | undefined,
    signal: AbortSignal
  ) {
    const connection = this.store.connection(owner, connectionId);
    const provider = this.registry.resolveProviderInstance(
      connection.providerInstanceId as ConnectorProviderInstanceId
    );
    if (!provider?.events) throw new ConnectorSubscriptionError('events_unavailable');
    const version = await provider.resolveToolkitVersion(connection.toolkit, signal);
    if (version.status !== 'ok') throw new ConnectorSubscriptionError('events_unavailable');
    const page = await provider.events.listDefinitions({
      toolkit: connection.toolkit,
      toolkitVersion: version.toolkitVersion,
      cursor,
      limit: 100,
      signal,
    });
    return {
      definitions: this.store.discover(connection, page.definitions, this.now()),
      nextCursor: page.nextCursor,
    };
  }

  /** Add explicit consent, adopting a borrowed exact match without modifying another owner's trigger. */
  async create(
    owner: ConnectorOwnerAuthority,
    request: ConnectorReceiveScope,
    signal: AbortSignal,
    manageExistingTrigger = false
  ): Promise<{ id: string; state: 'active' | 'pending' | 'needs_review' }> {
    if (!(await this.destinations.authorize(owner, request.agentId, request.destination)))
      throw new ConnectorSubscriptionError('destination_unavailable');
    const proposed = this.store.propose(owner, request, this.now());
    return this.activateReviewed(owner, request, proposed, signal, manageExistingTrigger);
  }

  /** Resume an already-reviewed generation; this method never reproposes consent. */
  async activateReviewed(
    owner: ConnectorOwnerAuthority,
    request: ConnectorReceiveScope,
    proposed: ReturnType<ConnectorSubscriptionStore['propose']>,
    signal: AbortSignal,
    manageExistingTrigger = false
  ): Promise<{ id: string; state: 'active' | 'pending' | 'needs_review' }> {
    if (proposed.connection.mode !== 'byo')
      throw new ConnectorSubscriptionError('events_unavailable');
    const capability = this.registry.resolveProviderInstance(
      proposed.connection.providerInstanceId as ConnectorProviderInstanceId
    )?.events;
    if (!capability) throw new ConnectorSubscriptionError('events_unavailable');
    const worker = randomUUID();
    const leaseUntil = new Date(Date.parse(this.now()) + 60_000).toISOString();
    const claim = this.store.db.$client
      .prepare(
        `UPDATE connector_event_bindings SET lease_owner = ?, leased_until = ? WHERE id = ?
       AND (lease_owner IS NULL OR leased_until <= ?) RETURNING state, provider_trigger_ref`
      )
      .get(worker, leaseUntil, proposed.bindingId, this.now()) as
      { state: string; provider_trigger_ref: string | null } | undefined;
    if (!claim) return { id: proposed.subscriptionId, state: 'pending' };
    try {
      const scope = {
        externalAccountRef: proposed.connection.externalAccountRef,
        definition: proposed.definition,
        filter: proposed.filter,
        signal,
      };
      const current = () => this.currentProposal(owner, proposed, worker);
      const authorizeDispatch = async () => {
        if (!(await this.destinations.authorize(owner, request.agentId, request.destination)))
          return false;
        return current();
      };
      // Readback precedes every retry. A missing/ambiguous response is never
      // permission to assume a previous mutation did not happen.
      const found = await capability.reconcileTrigger(scope);
      if (!current()) return { id: proposed.subscriptionId, state: 'pending' };
      if (found.status === 'unavailable' || found.status === 'ambiguous')
        return { id: proposed.subscriptionId, state: 'pending' };
      let trigger: ConnectorPhysicalTrigger;
      if (found.status === 'found') {
        trigger = found.trigger;
        if (!trigger.enabled) {
          if (!manageExistingTrigger) return { id: proposed.subscriptionId, state: 'needs_review' };
          const enabled = await capability.setTriggerEnabled({
            providerTriggerRef: trigger.providerTriggerRef,
            enabled: true,
            signal,
            authorizeDispatch,
          });
          if (enabled.status !== 'ok') {
            this.unknown(proposed.bindingId, worker, enabled.status === 'outcome_unknown');
            return { id: proposed.subscriptionId, state: 'pending' };
          }
          trigger = { ...trigger, enabled: true };
        }
      } else {
        if (claim.state === 'outcome_unknown')
          return { id: proposed.subscriptionId, state: 'pending' };
        const created = await capability.createTrigger({ ...scope, authorizeDispatch });
        if (created.status !== 'ready') {
          this.unknown(proposed.bindingId, worker, created.status === 'outcome_unknown');
          return { id: proposed.subscriptionId, state: 'pending' };
        }
        // Upsert does not provide nano/UUID account pairs or ownership proof.
        // Read back the exact registered binding before accepting webhooks.
        const confirmed = await capability.reconcileTrigger(scope);
        if (
          confirmed.status !== 'found' ||
          ![confirmed.trigger.providerTriggerRef, confirmed.trigger.providerTriggerUuid].includes(
            created.providerTriggerRef
          )
        ) {
          this.unknown(proposed.bindingId, worker, true);
          return { id: proposed.subscriptionId, state: 'pending' };
        }
        trigger = confirmed.trigger;
      }
      if (!(await this.destinations.authorize(owner, request.agentId, request.destination)))
        return { id: proposed.subscriptionId, state: 'pending' };
      return this.store.db.transaction(() => {
        if (!current() || !trigger.enabled)
          return { id: proposed.subscriptionId, state: 'pending' as const };
        this.store.db.$client
          .prepare(
            `UPDATE connector_event_bindings SET state = 'ready', provider_trigger_ref = ?, provider_trigger_uuid = ?,
           external_account_uuid = ?, ownership = CASE WHEN ? THEN 'operator_managed' ELSE ownership END,
           updated_at = ? WHERE id = ? AND lease_owner = ?`
          )
          .run(
            trigger.providerTriggerRef,
            trigger.providerTriggerUuid ?? null,
            trigger.externalAccountUuid ?? null,
            manageExistingTrigger ? 1 : 0,
            this.now(),
            proposed.bindingId,
            worker
          );
        this.store.db.$client
          .prepare(
            'UPDATE connector_event_subscriptions SET enabled = 1, updated_at = ? WHERE id = ? AND scope_version = ? AND revoked_at IS NULL'
          )
          .run(this.now(), proposed.subscriptionId, proposed.scopeVersion);
        return { id: proposed.subscriptionId, state: 'active' as const };
      });
    } finally {
      this.store.db.$client
        .prepare(
          'UPDATE connector_event_bindings SET lease_owner = NULL, leased_until = NULL WHERE id = ? AND lease_owner = ?'
        )
        .run(proposed.bindingId, worker);
    }
  }

  /** Revoke locally first; another logical subscriber's shared resource stays intact. */
  async revoke(
    owner: ConnectorOwnerAuthority,
    subscriptionId: string,
    signal: AbortSignal
  ): Promise<void> {
    const row = this.store.db.$client
      .prepare('SELECT binding_id FROM connector_event_subscriptions WHERE id = ?')
      .get(subscriptionId) as { binding_id: string | null } | undefined;
    this.store.revoke(owner, subscriptionId, this.now());
    if (!row?.binding_id) return;
    const binding = this.store.db.$client
      .prepare(
        'SELECT provider_instance_id, provider_trigger_ref, ownership FROM connector_event_bindings WHERE id = ?'
      )
      .get(row.binding_id) as
      | { provider_instance_id: string; provider_trigger_ref: string | null; ownership: string }
      | undefined;
    // Borrowed BYO triggers remain under the operator's existing management.
    if (!binding?.provider_trigger_ref || binding.ownership === 'borrowed') return;
    const capability = this.registry.resolveProviderInstance(
      binding.provider_instance_id as ConnectorProviderInstanceId
    )?.events;
    if (!capability) return;
    await this.cleanupOwnedBinding(
      row.binding_id,
      binding.provider_trigger_ref,
      capability,
      signal
    );
  }

  /** Reconcile abandoned owned cleanup through existing maintenance, never reactivating subscriptions. */
  async recoverCleanup(signal: AbortSignal, limit = 25): Promise<void> {
    const rows = this.store.db.$client
      .prepare(
        `SELECT b.id, b.provider_instance_id, b.provider_trigger_ref
      FROM connector_event_bindings b JOIN connector_provider_instances p ON p.id = b.provider_instance_id
      WHERE p.mode = 'byo' AND p.status = 'available' AND b.provider_generation = p.execution_config_generation
      AND b.ownership = 'operator_managed' AND b.state <> 'retired' AND b.provider_trigger_ref IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM connector_event_subscriptions s WHERE s.binding_id = b.id AND s.revoked_at IS NULL)
      ORDER BY b.updated_at, b.id LIMIT ?`
      )
      .all(Math.min(100, Math.max(1, limit))) as Array<{
      id: string;
      provider_instance_id: string;
      provider_trigger_ref: string;
    }>;
    for (const row of rows) {
      if (signal.aborted) return;
      const capability = this.registry.resolveProviderInstance(
        row.provider_instance_id as ConnectorProviderInstanceId
      )?.events;
      if (capability)
        await this.cleanupOwnedBinding(row.id, row.provider_trigger_ref, capability, signal);
    }
  }

  private async cleanupOwnedBinding(
    bindingId: string,
    providerTriggerRef: string,
    capability: ConnectorEventCapability,
    signal: AbortSignal
  ) {
    const worker = randomUUID();
    const until = new Date(Date.parse(this.now()) + 60_000).toISOString();
    const claim = this.store.db.$client
      .prepare(
        `UPDATE connector_event_bindings SET lease_owner = ?, leased_until = ? WHERE id = ? AND provider_trigger_ref = ?
       AND state <> 'retired' AND ownership = 'operator_managed'
       AND (lease_owner IS NULL OR leased_until <= ?) AND NOT EXISTS
       (SELECT 1 FROM connector_event_subscriptions s JOIN connector_event_bindings other ON other.id = s.binding_id WHERE other.provider_instance_id = connector_event_bindings.provider_instance_id AND other.external_account_ref = connector_event_bindings.external_account_ref AND (other.id = ? OR other.provider_trigger_ref = connector_event_bindings.provider_trigger_ref) AND s.revoked_at IS NULL) RETURNING id`
      )
      .get(worker, until, bindingId, providerTriggerRef, this.now(), bindingId);
    if (!claim) return;
    try {
      const authorizeDispatch = () =>
        Boolean(
          this.store.db.$client
            .prepare(
              `SELECT b.id FROM connector_event_bindings b JOIN connector_provider_instances p ON p.id = b.provider_instance_id
         WHERE b.id = ? AND b.lease_owner = ? AND b.leased_until > ? AND b.provider_trigger_ref = ?
         AND b.provider_generation = p.execution_config_generation AND p.status = 'available'
         AND NOT EXISTS (SELECT 1 FROM connector_event_subscriptions s JOIN connector_event_bindings other ON other.id = s.binding_id WHERE other.provider_instance_id = b.provider_instance_id AND other.external_account_ref = b.external_account_ref AND (other.id = b.id OR other.provider_trigger_ref = b.provider_trigger_ref) AND s.revoked_at IS NULL)`
            )
            .get(bindingId, worker, this.now(), providerTriggerRef)
        );
      if (!authorizeDispatch()) return;
      const scope = this.store.db.$client
        .prepare(
          `SELECT b.external_account_ref, b.filter_json, d.definition_json FROM connector_event_bindings b JOIN connector_event_definitions d ON d.id = b.definition_id WHERE b.id = ?`
        )
        .get(bindingId) as {
        external_account_ref: string;
        filter_json: string;
        definition_json: string;
      };
      const found = await capability.reconcileTrigger({
        externalAccountRef: scope.external_account_ref,
        definition: ConnectorEventDefinitionSchema.parse(JSON.parse(scope.definition_json)),
        filter: JSON.parse(scope.filter_json),
        signal,
      });
      if (!authorizeDispatch()) return;
      if (found.status === 'unavailable' || found.status === 'ambiguous') return;
      if (found.status === 'found' && found.trigger.providerTriggerRef !== providerTriggerRef)
        return;
      const result =
        found.status === 'absent'
          ? { status: 'ok' as const }
          : await capability.deleteTrigger({ providerTriggerRef, signal, authorizeDispatch });
      if (result.status === 'ok')
        this.store.db.$client
          .prepare(
            "UPDATE connector_event_bindings SET state = 'retired', updated_at = ? WHERE id = ? AND lease_owner = ?"
          )
          .run(this.now(), bindingId, worker);
      else this.unknown(bindingId, worker, result.status === 'outcome_unknown');
    } finally {
      this.store.db.$client
        .prepare(
          'UPDATE connector_event_bindings SET lease_owner = NULL, leased_until = NULL WHERE id = ? AND lease_owner = ?'
        )
        .run(bindingId, worker);
    }
  }

  private currentProposal(
    owner: ConnectorOwnerAuthority,
    proposed: ReturnType<ConnectorSubscriptionStore['propose']>,
    worker: string
  ): boolean {
    try {
      const current = this.store.connection(owner, proposed.connection.id);
      if (
        current.providerGeneration !== proposed.connection.providerGeneration ||
        current.externalAccountRef !== proposed.connection.externalAccountRef
      )
        return false;
      return Boolean(
        this.store.db.$client
          .prepare(
            `SELECT s.id FROM connector_event_subscriptions s JOIN connector_event_definitions d ON d.id = s.definition_id
         JOIN connector_event_bindings b ON b.id = s.binding_id WHERE s.id = ? AND s.scope_version = ?
         AND s.revoked_at IS NULL AND d.current = 1 AND b.id = ? AND b.lease_owner = ? AND b.leased_until > ?`
          )
          .get(
            proposed.subscriptionId,
            proposed.scopeVersion,
            proposed.bindingId,
            worker,
            this.now()
          )
      );
    } catch {
      return false;
    }
  }

  private unknown(bindingId: string, worker: string, ambiguous: boolean) {
    if (ambiguous)
      this.store.db.$client
        .prepare(
          "UPDATE connector_event_bindings SET state = 'outcome_unknown', updated_at = ? WHERE id = ? AND lease_owner = ?"
        )
        .run(this.now(), bindingId, worker);
  }
}
