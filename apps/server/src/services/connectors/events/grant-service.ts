/** Reconcile exact durable owner-reviewed event selections against current authority. */
import { createHash } from 'node:crypto';
import { stableStringify } from '@dorkos/shared/capabilities';
import type {
  ConnectorEventGrantSelection,
  ConnectorReceiveScope,
} from '@dorkos/shared/connector-event-schemas';
import type { ConnectorOwnerAuthority } from '../principal/server-principal.js';
import { recoverEventReview, storedEventReview } from './subscription-review.js';
import { ConnectorSubscriptionStore } from './subscription-store.js';
import {
  ConnectorSubscriptionService,
  type ConnectorEventDestinationPolicy,
} from './subscription-service.js';
import type {
  ConnectorEventGrantPort,
  ConnectorEventGrantReview,
  ConnectorEventGrantResult,
  ManagedEventConsentAuthority,
  ManagedEventConsentStaging,
} from './grant-port.js';

/** Idempotent owner approval; replay of superseded/revoked consent can never revive it. */
export class ConnectorEventGrantService implements ConnectorEventGrantPort {
  constructor(
    private readonly store: ConnectorSubscriptionStore,
    private readonly subscriptions: ConnectorSubscriptionService,
    private readonly destinations: ConnectorEventDestinationPolicy,
    private readonly managed: ManagedEventConsentAuthority & ManagedEventConsentStaging,
    private readonly now = () => new Date().toISOString()
  ) {}

  /** Read exact stored event types before checking an agent request's proposed slugs. */
  describe(owner: ConnectorOwnerAuthority, scopes: ConnectorReceiveScope[]) {
    return scopes.map((scope) => this.store.describe(owner, scope));
  }

  /** Resolve current exact durable receive authority inside the caller's final dispatch transaction. */
  ready(
    owner: ConnectorOwnerAuthority,
    selections: ConnectorEventGrantSelection[],
    appliedEventScopeHash: string
  ): boolean {
    try {
      const selected = this.store.approvedSelections(owner, selections);
      if (!selected) return false;
      const expectedHash = createHash('sha256')
        .update(
          stableStringify(
            [...selections].sort((a, b) => a.subscriptionId.localeCompare(b.subscriptionId))
          )
        )
        .digest('hex');
      if (expectedHash !== appliedEventScopeHash) return false;
      return selected.every(({ selection }) => {
        const active = this.store.active(selection.subscriptionId, selection.scopeVersion);
        return Boolean(
          active &&
          (active.mode !== 'managed' ||
            this.managed.ready(selection.subscriptionId, selection.scopeVersion))
        );
      });
    } catch {
      return false;
    }
  }

  /** Resume a bounded due page of durable BYO owner consent after an outage or restart. */
  async recoverPending(
    signal: AbortSignal,
    limit = 25
  ): Promise<{ examined: number; ready: number }> {
    if (signal.aborted) return { examined: 0, ready: 0 };
    const now = this.now();
    const retryAt = new Date(Date.parse(now) + 30_000).toISOString();
    const rows = this.store.db.transaction(() => {
      const due = this.store.db.$client
        .prepare(
          `SELECT owner_kind,owner_id,review_id,request_hash,selections_json
        FROM connector_event_consent_commands c WHERE (c.recovery_after IS NULL OR c.recovery_after <= ?)
        AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(c.selections_json) THEN c.selections_json ELSE '[]' END) item
          JOIN connector_event_subscriptions s ON s.id = json_extract(item.value,'$.selection.subscriptionId')
          JOIN connections account ON account.id = s.connection_id
          JOIN connector_provider_instances p ON p.id = account.provider_instance_id
          JOIN connector_event_definitions d ON d.id = s.definition_id
          JOIN connector_event_bindings b ON b.id = s.binding_id
          WHERE p.mode = 'byo' AND p.owner_kind = c.owner_kind AND p.owner_id = c.owner_id
          AND s.revoked_at IS NULL AND s.enabled = 0 AND s.scope_version = json_extract(item.value,'$.selection.scopeVersion')
          AND d.current = 1 AND b.provider_generation = p.execution_config_generation)
        ORDER BY COALESCE(c.recovery_after,c.created_at),c.owner_kind,c.owner_id,c.review_id LIMIT ?`
        )
        .all(now, Math.max(1, Math.min(100, Math.floor(limit)))) as Array<{
        owner_kind: 'user' | 'local_install';
        owner_id: string;
        review_id: string;
        request_hash: string;
        selections_json: string;
      }>;
      // Persist scheduling before awaits; restart and competing workers see the
      // advanced due time. This is not authority to mutate a physical trigger.
      return due.filter(
        (row) =>
          this.store.db.$client
            .prepare(
              `UPDATE connector_event_consent_commands SET recovery_after = ?
        WHERE owner_kind = ? AND owner_id = ? AND review_id = ? AND request_hash = ?
        AND (recovery_after IS NULL OR recovery_after <= ?)`
            )
            .run(retryAt, row.owner_kind, row.owner_id, row.review_id, row.request_hash, now)
            .changes === 1
      );
    });
    let examined = 0;
    let ready = 0;
    for (const row of rows) {
      if (signal.aborted) break;
      examined++;
      try {
        const owner: ConnectorOwnerAuthority =
          row.owner_kind === 'user'
            ? { kind: 'user', userId: row.owner_id }
            : { kind: 'local_install', installationId: row.owner_id };
        const review = recoverEventReview(row);
        const selected = this.store.approvedSelections(
          owner,
          review.selected.map((item) => item.selection)
        );
        if (!selected) continue;
        const result = await this.reconcileSelected(
          owner,
          selected,
          review.manageExistingTriggers,
          signal
        );
        if (result.state === 'ready') ready++;
      } catch {
        /* Original consent remains pending; the next due page can still progress. */
      }
    }
    return { examined, ready };
  }

  /**
   * Take a review back so everything is as it was before it, in one
   * transaction (DOR-2503): a subscription the review created is stopped and
   * leaves the owner's list; one it took over gets its earlier state back (on
   * or off, stopped or not, on the list or not, definition, binding); one it
   * used as it was is left alone. Then the review's consent is forgotten, so a
   * different pick can be approved under the same review.
   *
   * On a managed account a generation only ever moves forward: the review's
   * own generation may already be on its way to the hosted side, so the
   * earlier state is written at a new, higher generation and that
   * generation's command is staged in this same transaction for the outbox to
   * deliver, so hosted events always carry the version the local row has.
   * Any other account gets its exact earlier generation back, so the person's
   * own review names it again and its recovery can resume it. A managed row put back on waits, off, for that command's receipt,
   * as any managed change does. A generation that has moved on since (the
   * owner changed it) is never touched. Any trigger at the service no live
   * subscription uses is retired by the existing cleanup maintenance
   * (`ConnectorSubscriptionService.recoverCleanup`).
   */
  withdraw(owner: ConnectorOwnerAuthority, reviewId: string, now: string): void {
    const ownerId = owner.kind === 'user' ? owner.userId : owner.installationId;
    this.store.db.transaction(() => {
      const command = this.store.db.$client
        .prepare(
          'SELECT selections_json FROM connector_event_consent_commands WHERE owner_kind = ? AND owner_id = ? AND review_id = ?'
        )
        .get(owner.kind, ownerId, reviewId) as { selections_json: string } | undefined;
      if (!command) return;
      const mode = this.store.db.$client.prepare(
        `SELECT p.mode FROM connector_event_subscriptions s JOIN connections c ON c.id = s.connection_id
         JOIN connector_provider_instances p ON p.id = c.provider_instance_id WHERE s.id = ?`
      );
      const stop = this.store.db.$client.prepare(
        `UPDATE connector_event_subscriptions SET enabled = 0, revoked_at = ?, removed_at = ?,
         updated_at = ?, scope_version = scope_version + 1
         WHERE id = ? AND scope_version = ? AND revoked_at IS NULL`
      );
      const restore = this.store.db.$client.prepare(
        `UPDATE connector_event_subscriptions SET scope_version = ?, enabled = ?,
         revoked_at = ?, removed_at = ?, definition_id = ?, binding_id = ?, updated_at = ?
         WHERE id = ? AND scope_version = ?`
      );
      for (const item of storedEventReview(command.selections_json)) {
        const { subscriptionId, scopeVersion } = item.selection;
        if (item.adopted) continue;
        const managed =
          (mode.get(subscriptionId) as { mode: string } | undefined)?.mode === 'managed';
        // A managed row moves forward, because the pick's generation may already
        // be on its way to the hosted side and hosted events carry it. Any
        // other row goes back to its exact earlier generation: that is the one
        // the person's own review names, so its recovery can resume it. Only
        // the withdrawn pick's generation is given up, and its consent goes
        // below.
        const restoredVersion = managed ? scopeVersion + 1 : item.prior?.scopeVersion;
        const changed = item.prior
          ? restore.run(
              restoredVersion,
              // A managed row is on only once the hosted side confirms it.
              item.prior.enabled && !managed ? 1 : 0,
              item.prior.revokedAt,
              item.prior.removedAt,
              item.prior.definitionId,
              item.prior.bindingId,
              now,
              subscriptionId,
              scopeVersion
            ).changes
          : stop.run(now, now, now, subscriptionId, scopeVersion).changes;
        if (changed === 1 && managed) this.managed.stage(subscriptionId, scopeVersion + 1);
      }
      this.store.db.$client
        .prepare(
          'DELETE FROM connector_event_consent_commands WHERE owner_kind = ? AND owner_id = ? AND review_id = ?'
        )
        .run(owner.kind, ownerId, reviewId);
    });
  }

  /** Persist exact reviewed selections once, then reconcile only those generations. */
  async approve(
    owner: ConnectorOwnerAuthority,
    review: ConnectorEventGrantReview,
    signal: AbortSignal
  ): Promise<ConnectorEventGrantResult> {
    for (const scope of review.scopes)
      if (!(await this.destinations.authorize(owner, scope.agentId, scope.destination)))
        return { state: 'unavailable', selections: [] };
    const selected = this.store.prepareReview(
      owner,
      review.reviewId,
      review.scopes,
      review.manageExistingTriggers ?? false,
      this.now()
    );
    return this.reconcileSelected(owner, selected, review.manageExistingTriggers ?? false, signal);
  }

  private async reconcileSelected(
    owner: ConnectorOwnerAuthority,
    selected: ReturnType<ConnectorSubscriptionStore['prepareReview']>,
    manageExistingTriggers: boolean,
    signal: AbortSignal
  ): Promise<ConnectorEventGrantResult> {
    const selections = selected.map((item) => item.selection);
    for (const { scope } of selected)
      if (!(await this.destinations.authorize(owner, scope.agentId, scope.destination)))
        return { state: 'unavailable', selections };
    // A recovered command may disappear while destination resolution awaits.
    // Never re-enter prepareReview here: it can create a new generation.
    if (!this.store.approvedSelections(owner, selections))
      return { state: 'unavailable', selections };
    for (const { selection, scope } of selected) {
      const proposed = this.store.reviewedProposal(owner, selection, scope);
      if (!proposed) return { state: 'unavailable', selections };
      if (proposed.connection.mode === 'managed')
        await this.managed.reconcile(selection.subscriptionId, selection.scopeVersion, signal);
      else if (!this.store.active(selection.subscriptionId, selection.scopeVersion))
        await this.subscriptions.activateReviewed(
          owner,
          scope,
          proposed,
          signal,
          manageExistingTriggers
        );
    }
    // Resolve every asynchronous destination check before the final synchronous
    // generation/ACK check, so an earlier await cannot reopen stale authority.
    for (const { scope } of selected)
      if (!(await this.destinations.authorize(owner, scope.agentId, scope.destination)))
        return { state: 'unavailable', selections };
    if (!this.store.approvedSelections(owner, selections))
      return { state: 'unavailable', selections };
    for (const { selection, scope } of selected) {
      if (!this.store.reviewedProposal(owner, selection, scope))
        return { state: 'unavailable', selections };
      const active = this.store.active(selection.subscriptionId, selection.scopeVersion);
      if (
        !active ||
        (active.mode === 'managed' &&
          !this.managed.ready(selection.subscriptionId, selection.scopeVersion))
      )
        return { state: 'pending', selections };
    }
    const appliedEventScopeHash = createHash('sha256')
      .update(
        stableStringify(
          [...selections].sort((a, b) => a.subscriptionId.localeCompare(b.subscriptionId))
        )
      )
      .digest('hex');
    return { state: 'ready', selections, appliedEventScopeHash };
  }
}
