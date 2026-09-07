/** Durable local connector event inbox with atomic leases and payload-free receipts. */
import { ulid } from 'ulidx';
import {
  CONNECTOR_EVENT_BATCH_LIMIT,
  CONNECTOR_EVENT_METADATA_WINDOW_MS,
} from '@dorkos/shared/connector-event-schemas';
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
  /** Immutable receive-consent generation observed at ingress. */
  subscriptionVersion?: number;
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
  /** Exact configured provider and consent generation. */
  providerInstanceId: ConnectorProviderInstanceId;
  subscriptionVersion: number;
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
  /** Server boot that issued the lease; separate from stable inbox identity. */
  leaseBootEpoch: string;
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
  /** Fixed process epoch shared with private session acceptance. */
  bootEpoch?: string;
}

/** Durable inbox used by later signed ingress and routing workers. */
export class ConnectorEventInboxStore {
  private readonly db: Db;
  private readonly createId: () => string;
  readonly bootEpoch: string;

  /** Construct the store over the canonical connector tables. */
  constructor(options: ConnectorEventInboxStoreOptions) {
    this.db = options.db;
    this.createId = options.createId ?? ulid;
    this.bootEpoch = options.bootEpoch ?? ulid();
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
          subscriptionVersion: input.subscriptionVersion ?? 1,
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
    if (
      !Number.isFinite(Date.parse(now)) ||
      !Number.isFinite(Date.parse(leasedUntil)) ||
      Date.parse(leasedUntil) <= Date.parse(now)
    )
      throw new Error('Invalid event lease.');
    return this.db.transaction((tx) => {
      this.expireDue(tx, now);
      this.quarantineUnobserved(now);
      const exhausted = this.db.$client
        .prepare(
          `SELECT id, subscription_id, provider_event_id FROM connector_event_inbox
        WHERE attempt_count >= 8 AND (state = 'received' OR (state = 'leased' AND leased_until <= ?))
        AND NOT EXISTS (SELECT 1 FROM session_message_acceptance_receipts r WHERE r.source_kind = 'connector_event' AND r.source_id = connector_event_inbox.id)
        ORDER BY received_at, id LIMIT 100`
        )
        .all(now) as Array<{ id: string; subscription_id: string; provider_event_id: string }>;
      for (const terminal of exhausted) {
        this.db.$client
          .prepare(
            "UPDATE connector_event_inbox SET state = 'failed', normalized_payload = '', lease_owner = NULL, leased_until = NULL, failure_code = 'attempts_exhausted' WHERE id = ?"
          )
          .run(terminal.id);
        this.appendReceipt(tx, {
          inboxId: terminal.id,
          subscriptionId: terminal.subscription_id,
          providerEventId: terminal.provider_event_id,
          state: 'failed',
          failureCode: 'attempts_exhausted',
          recordedAt: now,
        });
      }
      const row = this.db.$client
        .prepare(
          `UPDATE connector_event_inbox
           SET state = 'leased', attempt_count = attempt_count + 1,
               lease_owner = ?, lease_boot_epoch = ?, leased_until = MIN(?, expires_at), failure_code = NULL
           WHERE id = (
             SELECT id FROM connector_event_inbox
             WHERE attempt_count < 8 AND expires_at > ? AND (
               (state = 'received' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)) OR
               (state = 'leased' AND leased_until <= ?)
             ) AND NOT EXISTS (SELECT 1 FROM session_message_acceptance_receipts acceptance WHERE acceptance.source_kind = 'connector_event' AND acceptance.source_id = connector_event_inbox.id)
             ORDER BY received_at, id
             LIMIT 1
           )
           RETURNING id, provider_instance_id, subscription_id, subscription_version, provider_event_id, payload_schema_version,
             normalized_payload, payload_protection, attempt_count, lease_owner, lease_boot_epoch,
             leased_until, expires_at`
        )
        .get(workerId, this.bootEpoch, leasedUntil, now, now, now) as
        | {
            id: string;
            provider_instance_id: ConnectorProviderInstanceId;
            subscription_version: number;
            subscription_id: string;
            provider_event_id: string;
            payload_schema_version: number;
            normalized_payload: string;
            payload_protection: ConnectorPayloadProtection;
            attempt_count: number;
            lease_owner: string;
            lease_boot_epoch: string;
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
        providerInstanceId: row.provider_instance_id,
        subscriptionVersion: row.subscription_version,
        subscriptionId: row.subscription_id,
        providerEventId: row.provider_event_id,
        payloadSchemaVersion: row.payload_schema_version,
        normalizedPayload: row.normalized_payload,
        payloadProtection: row.payload_protection,
        attemptCount: row.attempt_count,
        leaseOwner: row.lease_owner,
        leaseBootEpoch: row.lease_boot_epoch,
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
           SET state = 'completed', completed_at = ?, lease_owner = NULL, leased_until = NULL,
               normalized_payload = '', next_attempt_at = NULL
           WHERE id = ? AND state = 'dispatched' AND lease_owner = ? AND lease_boot_epoch = ? AND leased_until > ?
           RETURNING subscription_id, provider_event_id`
        )
        .get(now, inboxId, workerId, this.bootEpoch, now) as
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
          `SELECT subscription_id, provider_event_id, expires_at, state, attempt_count
           FROM connector_event_inbox
           WHERE id = ? AND state IN ('leased', 'dispatched') AND lease_owner = ? AND lease_boot_epoch = ?
             AND leased_until > ?`
        )
        .get(inboxId, workerId, this.bootEpoch, now) as
        | {
            subscription_id: string;
            provider_event_id: string;
            expires_at: string;
            state: string;
            attempt_count: number;
          }
        | undefined;
      if (!current) return false;
      if (current.state === 'dispatched') return this.quarantine(inboxId, now, failureCode);
      const retry =
        current.attempt_count < 8 &&
        nextAttemptAt !== undefined &&
        nextAttemptAt < current.expires_at;
      this.db.$client
        .prepare(
          `UPDATE connector_event_inbox
           SET state = ?, next_attempt_at = ?, lease_owner = NULL, leased_until = NULL,
               failure_code = ?, normalized_payload = CASE WHEN ? THEN normalized_payload ELSE '' END
           WHERE id = ?`
        )
        .run(
          retry ? 'received' : 'failed',
          retry ? nextAttemptAt : null,
          failureCode,
          retry ? 1 : 0,
          inboxId
        );
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

  /** Quarantine an uncertain external effect without making its source retryable. */
  quarantine(inboxId: string, now: string, failureCode = 'dispatch_outcome_unknown'): boolean {
    return this.db.transaction((tx) => {
      const row = this.db.$client
        .prepare(
          `UPDATE connector_event_inbox SET state = 'failed', failure_code = ?,
        lease_owner = NULL, leased_until = NULL, next_attempt_at = NULL
        WHERE id = ? AND state = 'dispatched' RETURNING subscription_id, provider_event_id`
        )
        .get(failureCode, inboxId) as
        { subscription_id: string; provider_event_id: string } | undefined;
      if (!row) return false;
      this.appendReceipt(tx, {
        inboxId,
        subscriptionId: row.subscription_id,
        providerEventId: row.provider_event_id,
        state: 'outcome_unknown',
        recordedAt: now,
        failureCode,
      });
      return true;
    });
  }

  private quarantineUnobserved(now: string): void {
    const rows = this.db.$client
      .prepare(
        `SELECT id FROM connector_event_inbox WHERE state = 'dispatched'
      AND (leased_until <= ? OR lease_boot_epoch <> ?) AND NOT EXISTS
      (SELECT 1 FROM session_message_acceptance_receipts a WHERE a.source_kind = 'connector_event' AND a.source_id = connector_event_inbox.id)
      ORDER BY received_at, id LIMIT ?`
      )
      .all(now, this.bootEpoch, CONNECTOR_EVENT_BATCH_LIMIT) as Array<{ id: string }>;
    for (const row of rows) this.quarantine(row.id, now);
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
           WHERE id = ? AND state = 'leased' AND lease_owner = ? AND lease_boot_epoch = ? AND leased_until > ? AND expires_at > ?
           RETURNING subscription_id, provider_event_id`
        )
        .get(state, now, inboxId, workerId, this.bootEpoch, now, now) as
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

  /** Erase expired content in every state without rewriting completed/failed delivery truth. */
  sweepRetention(now: string): { cleared: number; expired: number } {
    return this.db.transaction((tx) => this.expireDue(tx, now));
  }

  /** Delete only expired payload-free inbox/receipt metadata after the bounded dedupe window. */
  sweepMetadata(now: string): number {
    const deadline = new Date(Date.parse(now) - CONNECTOR_EVENT_METADATA_WINDOW_MS).toISOString();
    return this.db.$client
      .prepare(
        `DELETE FROM connector_event_inbox WHERE id IN
      (SELECT id FROM connector_event_inbox WHERE received_at <= ? AND expires_at <= ? AND normalized_payload = ''
       AND state IN ('completed', 'failed', 'expired') ORDER BY received_at, id LIMIT ?)`
      )
      .run(deadline, now, CONNECTOR_EVENT_BATCH_LIMIT).changes;
  }

  private expireDue(db: ReceiptWriter, now: string): { cleared: number; expired: number } {
    const rows = this.db.$client
      .prepare(
        `SELECT id, subscription_id, provider_event_id, state, normalized_payload
       FROM connector_event_inbox WHERE expires_at <= ?
       AND (normalized_payload <> '' OR state NOT IN ('completed', 'failed', 'expired'))
       ORDER BY expires_at, id LIMIT ?`
      )
      .all(now, CONNECTOR_EVENT_BATCH_LIMIT) as Array<{
      id: string;
      subscription_id: string;
      provider_event_id: string;
      state: string;
      normalized_payload: string;
    }>;
    let cleared = 0;
    let expired = 0;
    const update = this.db.$client.prepare(
      `UPDATE connector_event_inbox SET normalized_payload = '', state = ?,
       lease_owner = NULL, leased_until = NULL, next_attempt_at = NULL WHERE id = ?`
    );
    for (const row of rows) {
      if (row.normalized_payload !== '') cleared++;
      const terminal = ['completed', 'failed', 'expired'].includes(row.state);
      update.run(terminal ? row.state : 'expired', row.id);
      if (!terminal) {
        expired++;
        this.appendReceipt(db, {
          inboxId: row.id,
          subscriptionId: row.subscription_id,
          providerEventId: row.provider_event_id,
          state: 'expired',
          recordedAt: now,
        });
      }
    }
    return { cleared, expired };
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
