/** Bounded event routing through existing rooms, Relay and private-session acceptance. */
import { randomUUID } from 'node:crypto';
import { stableStringify } from '@dorkos/shared/capabilities';
import type { ConnectorEventContent } from '@dorkos/shared/connector-event-schemas';
import type { DbTransaction } from '@dorkos/db';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import type { ConnectorOwnerAuthority } from '../principal/server-principal.js';
import type { ConnectorEventInboxStore, LeasedConnectorEvent } from '../event-inbox-store.js';
import type { PrivateSessionMessageAcceptanceService } from '../../session/private-messages/acceptance.js';
import type { ConnectorEventProtectionPort } from './ingress-service.js';
import type { ActiveEventSubscription, ConnectorSubscriptionStore } from './subscription-store.js';
import type { ManagedEventConsentAuthority } from './grant-port.js';
import type { ConnectorEventSessionSourceAdapter } from './session-source-adapter.js';

/** Fixed room destination boundary; callbacks run in RoomStore's append transaction. */
export interface ConnectorEventRoomDestination {
  postServiceNotification(
    roomId: string,
    entryId: string,
    text: string,
    within: (tx: DbTransaction) => void,
    bind: (tx: DbTransaction, seq: number) => void
  ): RoomEntry;
}

/** Fixed native messaging boundary, with exact source authority checked at the last effect. */
export interface ConnectorEventChannelDestination {
  deliver(
    scope: ActiveEventSubscription,
    content: ConnectorEventContent,
    authorizeDispatch: () => boolean
  ): Promise<{ state: 'delivered'; receiptId: string } | { state: 'refused' | 'outcome_unknown' }>;
}

/** Production routing dependencies share one database, one inbox and one acceptance coordinator. */
export interface ConnectorEventDeliveryOptions {
  subscriptions: ConnectorSubscriptionStore;
  inbox: ConnectorEventInboxStore;
  protection: ConnectorEventProtectionPort;
  managed: ManagedEventConsentAuthority;
  sessions: ConnectorEventSessionSourceAdapter;
  acceptance: PrivateSessionMessageAcceptanceService;
  /** Existing shared private-session dispatcher nudge; recovery owns retries. */
  nudgeSession(sessionId: string): void;
  rooms: ConnectorEventRoomDestination;
  channels: ConnectorEventChannelDestination;
  /** Current owner/agent/destination permission; synchronous for the final transaction. */
  authorize(owner: ConnectorOwnerAuthority, scope: ActiveEventSubscription): boolean;
  now?: () => string;
}

/** Existing maintenance calls this bounded worker; it creates no timers or parallel queue. */
export class ConnectorEventDeliveryService {
  private running: Promise<number> | undefined;
  private readonly now: () => string;
  constructor(private readonly options: ConnectorEventDeliveryOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Reconcile up to one bounded page, sharing concurrent maintenance calls. */
  recover(signal: AbortSignal, limit = 25): Promise<number> {
    if (this.running) return this.running;
    this.running = this.recoverOnce(signal, Math.min(100, Math.max(1, limit))).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async recoverOnce(signal: AbortSignal, limit: number): Promise<number> {
    this.options.sessions.sweepPreparations(this.now());
    let count = 0;
    for (; count < limit && !signal.aborted; count++) {
      const now = this.now();
      const row = this.options.inbox.claimNext(
        randomUUID(),
        now,
        new Date(Date.parse(now) + 60_000).toISOString()
      );
      if (!row) break;
      try {
        await this.deliver(row, signal);
      } catch {
        // Once marked dispatched, fail quarantines instead of retrying an
        // uncertain external effect. Before dispatch this is a bounded retry.
        this.options.inbox.fail(
          row.id,
          row.leaseOwner,
          this.now(),
          'event_destination_unavailable',
          new Date(
            Date.parse(this.now()) + Math.min(300_000, 1_000 * 2 ** Math.min(row.attemptCount, 8))
          ).toISOString()
        );
      }
    }
    return count;
  }

  private async deliver(row: LeasedConnectorEvent, signal: AbortSignal): Promise<void> {
    const scope = this.current(row);
    if (!scope) {
      this.options.inbox.fail(row.id, row.leaseOwner, this.now(), 'event_authority_changed');
      return;
    }
    if (scope.destinationKind === 'agent') {
      const ref = {
        kind: 'connector_event' as const,
        inboxId: row.id,
        sourceGeneration: String(row.subscriptionVersion),
        leaseOwner: row.leaseOwner,
      };
      await this.options.sessions.prepareTarget(ref);
      if (signal.aborted) return;
      const accepted = this.options.sessions.acceptPrepared(this.options.acceptance, ref);
      if (accepted.receipt.state === 'accepted') {
        try {
          this.options.nudgeSession(accepted.receipt.sessionId);
        } catch {
          /* Durable acceptance survives; the shared dispatcher recovery will nudge again. */
        }
      }
      return;
    }
    const protector = await this.options.protection.resolve(row.providerInstanceId);
    if (!protector || row.payloadProtection !== 'encrypted')
      throw new Error('Event content unavailable.');
    const content = protector.reveal(row.normalizedPayload, row, Date.parse(this.now()));
    const expected = stableStringify(scope);
    const authorize = () => !signal.aborted && stableStringify(this.current(row)) === expected;
    if (!authorize()) {
      this.options.inbox.fail(row.id, row.leaseOwner, this.now(), 'event_authority_changed');
      return;
    }
    if (scope.destinationKind === 'room') {
      const entryId = row.id;
      this.options.rooms.postServiceNotification(
        scope.destinationId,
        entryId,
        `${content.title}\n\n${content.text}`,
        () => {
          if (
            !authorize() ||
            !this.options.inbox.markDispatched(row.id, row.leaseOwner, this.now())
          )
            throw new Error('Event authority changed.');
        },
        () => {
          if (
            !this.options.inbox.complete(
              row.id,
              row.leaseOwner,
              this.now(),
              `room:${scope.destinationId}:${entryId}`
            )
          )
            throw new Error('Event receipt unavailable.');
        }
      );
      return;
    }
    const result = await this.options.channels.deliver(scope, content, () => {
      if (!authorize()) return false;
      const state = this.options.subscriptions.db.$client
        .prepare('SELECT state FROM connector_event_inbox WHERE id = ?')
        .get(row.id) as { state: string };
      return (
        state.state === 'dispatched' ||
        this.options.inbox.markDispatched(row.id, row.leaseOwner, this.now())
      );
    });
    if (result.state === 'delivered') {
      if (!this.options.inbox.complete(row.id, row.leaseOwner, this.now(), result.receiptId))
        this.options.inbox.quarantine(row.id, this.now());
    } else if (result.state === 'outcome_unknown')
      this.options.inbox.quarantine(row.id, this.now());
    else this.options.inbox.fail(row.id, row.leaseOwner, this.now(), 'event_destination_refused');
  }

  private current(row: LeasedConnectorEvent): ActiveEventSubscription | undefined {
    const current = this.options.subscriptions.db.$client
      .prepare(
        `SELECT state, normalized_payload FROM connector_event_inbox
      WHERE id = ? AND subscription_version = ? AND lease_owner = ? AND lease_boot_epoch = ? AND leased_until > ? AND expires_at > ?`
      )
      .get(
        row.id,
        row.subscriptionVersion,
        row.leaseOwner,
        this.options.inbox.bootEpoch,
        this.now(),
        this.now()
      ) as { state: string; normalized_payload: string } | undefined;
    if (
      !current ||
      !['leased', 'dispatched'].includes(current.state) ||
      current.normalized_payload !== row.normalizedPayload
    )
      return undefined;
    const scope = this.options.subscriptions.active(row.subscriptionId, row.subscriptionVersion);
    if (
      !scope ||
      scope.providerInstanceId !== row.providerInstanceId ||
      !this.options.authorize(this.options.subscriptions.owner(scope), scope) ||
      (scope.mode === 'managed' &&
        !this.options.managed.ready(scope.subscriptionId, scope.subscriptionVersion))
    )
      return undefined;
    return scope;
  }
}
