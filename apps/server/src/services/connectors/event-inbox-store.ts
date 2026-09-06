/** Durable local connector event inbox with atomic leases and payload-free receipts. */
import { ulid } from 'ulidx';
import { connectorEventInbox, connectorEventReceipts, type Db } from '@dorkos/db';
import type { ConnectorProviderInstanceId } from '@dorkos/shared/connector-schemas';

/** Minimum Drizzle surface shared by the database and an active transaction. */
type ReceiptWriter = Pick<Db, 'insert'>;

/** Protected payload classification persisted with a normalized event. */
export type ConnectorPayloadProtection = 'minimized' | 'encrypted';

/** Input accepted only after webhook authentication and payload normalization. */
export interface EnqueueConnectorEventInput {
  /** Owning provider instance. */
  providerInstanceId: ConnectorProviderInstanceId;
  /** Explicit event subscription. */
  subscriptionId: string;
  /** Provider deduplication identifier. */
  providerEventId: string;
  /** Version of the normalized payload contract. */
  payloadSchemaVersion: number;
  /** Minimized or encrypted normalized payload. */
  normalizedPayload: string;
  /** How the stored payload is protected. */
  payloadProtection: ConnectorPayloadProtection;
  /** ISO time after which payload retention and dispatch end. */
  expiresAt: string;
  /** ISO receipt time. */
  receivedAt: string;
}

/** One event held by a specific worker lease. */
export interface LeasedConnectorEvent {
  /** Durable inbox identifier. */
  id: string;
  /** Explicit event subscription. */
  subscriptionId: string;
  /** Provider deduplication identifier. */
  providerEventId: string;
  /** Version of the normalized payload contract. */
  payloadSchemaVersion: number;
  /** Protected normalized payload. */
  normalizedPayload: string;
  /** Stored payload protection. */
  payloadProtection: ConnectorPayloadProtection;
  /** Attempt number after this claim. */
  attemptCount: number;
  /** Worker owning the active lease. */
  leaseOwner: string;
  /** ISO lease deadline. */
  leasedUntil: string;
  /** ISO event expiry. */
  expiresAt: string;
}

/** Options for deterministic IDs in tests. */
export interface ConnectorEventInboxStoreOptions {
  /** DorkOS SQLite database. */
  db: Db;
  /** Durable ID factory. */
  createId?: () => string;
}

/** Durable inbox used by later signed ingress and routing workers. */
export class ConnectorEventInboxStore {
  private readonly db: Db;
  private readonly createId: () => string;

  /** Construct the store over the canonical connector tables. */
  constructor(options: ConnectorEventInboxStoreOptions) {
    this.db = options.db;
    this.createId = options.createId ?? ulid;
  }

  /** Persist before acknowledgement, deduplicating provider redelivery. */
  enqueue(input: EnqueueConnectorEventInput): { id: string; inserted: boolean } {
    return this.db.transaction((tx) => {
      const existing = this.db.$client
        .prepare(
          `SELECT id FROM connector_event_inbox
           WHERE provider_instance_id = ? AND subscription_id = ? AND provider_event_id = ?`
        )
        .get(input.providerInstanceId, input.subscriptionId, input.providerEventId) as
        { id: string } | undefined;
      if (existing) return { id: existing.id, inserted: false };

      const id = this.createId();
      tx.insert(connectorEventInbox)
        .values({
          id,
          providerInstanceId: input.providerInstanceId,
          subscriptionId: input.subscriptionId,
          providerEventId: input.providerEventId,
          payloadSchemaVersion: input.payloadSchemaVersion,
          normalizedPayload: input.normalizedPayload,
          payloadProtection: input.payloadProtection,
          state: 'received',
          expiresAt: input.expiresAt,
          receivedAt: input.receivedAt,
        })
        .run();
      this.appendReceipt(tx, {
        inboxId: id,
        subscriptionId: input.subscriptionId,
        providerEventId: input.providerEventId,
        state: 'received',
        recordedAt: input.receivedAt,
      });
      return { id, inserted: true };
    });
  }

  /** Atomically claim the next eligible event and exclude concurrent workers. */
  claimNext(workerId: string, now: string, leasedUntil: string): LeasedConnectorEvent | undefined {
    return this.db.transaction((tx) => {
      this.expireDue(tx, now);
      const row = this.db.$client
        .prepare(
          `UPDATE connector_event_inbox
           SET state = 'leased', attempt_count = attempt_count + 1,
               lease_owner = ?, leased_until = ?, failure_code = NULL
           WHERE id = (
             SELECT id FROM connector_event_inbox
             WHERE expires_at > ? AND (
               (state = 'received' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)) OR
               (state IN ('leased', 'dispatched') AND leased_until <= ?)
             )
             ORDER BY received_at, id
             LIMIT 1
           )
           RETURNING id, subscription_id, provider_event_id, payload_schema_version,
             normalized_payload, payload_protection, attempt_count, lease_owner,
             leased_until, expires_at`
        )
        .get(workerId, leasedUntil, now, now, now) as
        | {
            id: string;
            subscription_id: string;
            provider_event_id: string;
            payload_schema_version: number;
            normalized_payload: string;
            payload_protection: ConnectorPayloadProtection;
            attempt_count: number;
            lease_owner: string;
            leased_until: string;
            expires_at: string;
          }
        | undefined;
      if (!row) return undefined;
      this.appendReceipt(tx, {
        inboxId: row.id,
        subscriptionId: row.subscription_id,
        providerEventId: row.provider_event_id,
        state: 'leased',
        recordedAt: now,
      });
      return {
        id: row.id,
        subscriptionId: row.subscription_id,
        providerEventId: row.provider_event_id,
        payloadSchemaVersion: row.payload_schema_version,
        normalizedPayload: row.normalized_payload,
        payloadProtection: row.payload_protection,
        attemptCount: row.attempt_count,
        leaseOwner: row.lease_owner,
        leasedUntil: row.leased_until,
        expiresAt: row.expires_at,
      };
    });
  }

  /** Record that the leased event reached its durable destination boundary. */
  markDispatched(inboxId: string, workerId: string, now: string): boolean {
    return this.transitionOwned(inboxId, workerId, 'dispatched', now);
  }

  /** Record completion and an optional destination receipt identifier. */
  complete(inboxId: string, workerId: string, now: string, destinationReceiptId?: string): boolean {
    return this.db.transaction((tx) => {
      const row = this.db.$client
        .prepare(
          `UPDATE connector_event_inbox
           SET state = 'completed', completed_at = ?, lease_owner = NULL, leased_until = NULL
           WHERE id = ? AND state = 'dispatched' AND lease_owner = ? AND leased_until > ?
           RETURNING subscription_id, provider_event_id`
        )
        .get(now, inboxId, workerId, now) as
        { subscription_id: string; provider_event_id: string } | undefined;
      if (!row) return false;
      this.appendReceipt(tx, {
        inboxId,
        subscriptionId: row.subscription_id,
        providerEventId: row.provider_event_id,
        state: 'completed',
        recordedAt: now,
        destinationReceiptId,
      });
      return true;
    });
  }

  /** Release an owned lease for retry, or terminate it when no retry remains. */
  fail(
    inboxId: string,
    workerId: string,
    now: string,
    failureCode: string,
    nextAttemptAt?: string
  ): boolean {
    return this.db.transaction((tx) => {
      const current = this.db.$client
        .prepare(
          `SELECT subscription_id, provider_event_id, expires_at
           FROM connector_event_inbox
           WHERE id = ? AND state IN ('leased', 'dispatched') AND lease_owner = ?
             AND leased_until > ?`
        )
        .get(inboxId, workerId, now) as
        { subscription_id: string; provider_event_id: string; expires_at: string } | undefined;
      if (!current) return false;
      const retry = nextAttemptAt !== undefined && nextAttemptAt < current.expires_at;
      this.db.$client
        .prepare(
          `UPDATE connector_event_inbox
           SET state = ?, next_attempt_at = ?, lease_owner = NULL, leased_until = NULL,
               failure_code = ?
           WHERE id = ?`
        )
        .run(retry ? 'received' : 'failed', retry ? nextAttemptAt : null, failureCode, inboxId);
      this.appendReceipt(tx, {
        inboxId,
        subscriptionId: current.subscription_id,
        providerEventId: current.provider_event_id,
        state: retry ? 'retry_scheduled' : 'failed',
        recordedAt: now,
        failureCode,
      });
      return true;
    });
  }

  private transitionOwned(
    inboxId: string,
    workerId: string,
    state: 'dispatched',
    now: string
  ): boolean {
    return this.db.transaction((tx) => {
      const row = this.db.$client
        .prepare(
          `UPDATE connector_event_inbox
           SET state = ?, dispatched_at = ?
           WHERE id = ? AND state = 'leased' AND lease_owner = ? AND leased_until > ?
           RETURNING subscription_id, provider_event_id`
        )
        .get(state, now, inboxId, workerId, now) as
        { subscription_id: string; provider_event_id: string } | undefined;
      if (!row) return false;
      this.appendReceipt(tx, {
        inboxId,
        subscriptionId: row.subscription_id,
        providerEventId: row.provider_event_id,
        state,
        recordedAt: now,
      });
      return true;
    });
  }

  private expireDue(db: ReceiptWriter, now: string): void {
    const rows = this.db.$client
      .prepare(
        `UPDATE connector_event_inbox
         SET state = 'expired', normalized_payload = '', lease_owner = NULL, leased_until = NULL,
             next_attempt_at = NULL
         WHERE expires_at <= ? AND state NOT IN ('completed', 'failed', 'expired')
         RETURNING id, subscription_id, provider_event_id`
      )
      .all(now) as Array<{ id: string; subscription_id: string; provider_event_id: string }>;
    for (const row of rows) {
      this.appendReceipt(db, {
        inboxId: row.id,
        subscriptionId: row.subscription_id,
        providerEventId: row.provider_event_id,
        state: 'expired',
        recordedAt: now,
      });
    }
  }

  private appendReceipt(
    db: ReceiptWriter,
    receipt: {
      inboxId: string;
      subscriptionId: string;
      providerEventId: string;
      state: string;
      recordedAt: string;
      destinationReceiptId?: string;
      failureCode?: string;
    }
  ): void {
    db.insert(connectorEventReceipts)
      .values({ id: this.createId(), ...receipt })
      .run();
  }
}
