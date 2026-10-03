/** Authoritative, metadata-only delivery observation with database-scoped ownership. */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Db } from '@dorkos/db';
import { assessProcessLiveness } from '@dorkos/shared/process-liveness';
import {
  RELAY_DELIVERY_FAILURE_MESSAGES,
  RelayDeliveryReceiptSchema,
  RelayMessageIdSchema,
  type RelayDeliveryFailureCode,
  type RelayDeliveryReceipt,
} from '@dorkos/shared/relay-schemas';
import { isDetachedAgentSubject } from './lib/detached-agent-subject.js';
import { validateSubject } from './subject-matcher.js';

export const RECEIPT_RETENTION_MS = 604_800_000;
export type ReceiptAvailabilityCode =
  | 'RELAY_RECEIPT_TRANSACTION_ACTIVE'
  | 'RELAY_RECEIPT_OBSERVER_BUSY'
  | 'RELAY_RECEIPT_STORAGE_UNAVAILABLE';

/** A safe public availability error; underlying storage detail stays in its cause. */
export class RelayReceiptUnavailableError extends Error {
  constructor(
    readonly code: ReceiptAvailabilityCode,
    cause?: unknown
  ) {
    super('Delivery receipt status is unavailable.', { cause });
    this.name = 'RelayReceiptUnavailableError';
  }
}

export interface DeliveryReceiptStoreOptions {
  /** Receipt timestamps only. Process lifetime references always use the real wall clock. */
  now?: () => number;
  ownerToken?: string;
}

/** Only closed outcomes can be persisted; safe text is selected by the store. */
export type ReceiptSettlement =
  | { state: 'delivered' }
  | { state: 'failed'; code: Exclude<RelayDeliveryFailureCode, 'observation_lost'> }
  | { state: 'outcome_unknown' };

interface ReceiptRow {
  message_id: string;
  owner_user_id: string | null;
  state: RelayDeliveryReceipt['state'];
  accepted_at: string;
  updated_at: string;
  expires_at: string;
  settled_at: string | null;
  failure_code: RelayDeliveryFailureCode | null;
  failure_message: string | null;
}
interface OwnerRow {
  owner_token: string;
  pid: number;
  hostname: string;
  claimed_at: string;
}
/** Trusted read policy is resolved by the server, never from request data. */
export type RelayReceiptReadContext =
  | { loginEnabled: false }
  | { loginEnabled: true; userId: string; installOwnerUserId: string | null };

/** Each instance observes one database exclusively; it never owns or closes the handle. */
export class DeliveryReceiptStore {
  readonly ownerToken: string;
  private readonly now: () => number;
  private ready = false;
  private closed = false;
  private released = false;

  constructor(
    private readonly db: Db,
    options: DeliveryReceiptStoreOptions = {}
  ) {
    this.ownerToken = options.ownerToken ?? randomUUID();
    this.now = options.now ?? Date.now;
  }

  /** Also used at tracked publish entry, before IDs, initialization or effects. */
  assertOutsideTransaction(): void {
    if (this.db.$client.inTransaction) {
      throw new RelayReceiptUnavailableError('RELAY_RECEIPT_TRANSACTION_ACTIVE');
    }
  }

  /** Acquire and recover atomically. Failed initialization remains retryable and has no effects. */
  ensureReady(): void {
    this.assertOutsideTransaction();
    if (this.closed) throw new RelayReceiptUnavailableError('RELAY_RECEIPT_STORAGE_UNAVAILABLE');
    this.atomic(() => {
      if (this.ready) return this.assertOwner();
      const holder = this.owner();
      if (holder) {
        const claimedAt = new Date(holder.claimed_at);
        // Validate metadata before probing; numeric PID reuse requires lifetime corroboration.
        if (
          !Number.isSafeInteger(holder.pid) ||
          holder.pid <= 0 ||
          holder.pid > 2_147_483_647 ||
          typeof holder.owner_token !== 'string' ||
          holder.owner_token.length === 0 ||
          holder.hostname !== hostname() ||
          !Number.isFinite(claimedAt.getTime()) ||
          holder.claimed_at !== claimedAt.toISOString() ||
          assessProcessLiveness(holder.pid, claimedAt) !== 'gone'
        )
          throw new RelayReceiptUnavailableError('RELAY_RECEIPT_OBSERVER_BUSY');
        this.db.$client
          .prepare('DELETE FROM relay_receipt_observer_owner WHERE owner_token = ?')
          .run(holder.owner_token);
      }
      this.db.$client
        .prepare(
          `INSERT INTO relay_receipt_observer_owner
        (singleton_key, owner_token, pid, hostname, claimed_at) VALUES ('observer', ?, ?, ?, ?)`
        )
        .run(this.ownerToken, process.pid, hostname(), new Date().toISOString());
      this.recoverRows(false);
    });
    this.ready = true;
  }

  /** Commit acceptance independently before the caller starts any delivery effect. */
  create(messageId: string, subject: string, ownerUserId: string | null): RelayDeliveryReceipt {
    this.assertOutsideTransaction();
    this.ensureReady();
    return this.atomic(() => {
      this.assertOwner();
      RelayMessageIdSchema.parse(messageId);
      if (!isDetachedAgentSubject(subject) || !validateSubject(subject).valid) {
        throw new Error('Invalid receipt destination');
      }
      const now = this.now();
      const acceptedAt = new Date(now).toISOString();
      const expiresAt = new Date(now + RECEIPT_RETENTION_MS).toISOString();
      this.db.$client
        .prepare(
          `INSERT INTO relay_delivery_receipts
        (message_id, subject, owner_user_id, state, boot_epoch, accepted_at, updated_at, expires_at)
        VALUES (?, ?, ?, 'accepted', ?, ?, ?, ?)`
        )
        .run(messageId, subject, ownerUserId, this.ownerToken, acceptedAt, acceptedAt, expiresAt);
      return {
        messageId,
        scope: 'agent_delivery',
        state: 'accepted',
        acceptedAt,
        updatedAt: acceptedAt,
        expiresAt,
      };
    });
  }

  /** Uniform absence for unknown, expired and other-owner IDs; never read the derived index. */
  get(messageId: string, context: RelayReceiptReadContext): RelayDeliveryReceipt | null {
    this.assertOutsideTransaction();
    this.ensureReady();
    return this.atomic(() => {
      this.assertOwner();
      const row = this.db.$client
        .prepare('SELECT * FROM relay_delivery_receipts WHERE message_id = ?')
        .get(messageId) as ReceiptRow | undefined;
      if (!row || this.now() >= Date.parse(row.expires_at)) return null;
      if (
        context.loginEnabled &&
        row.owner_user_id !== context.userId &&
        !(row.owner_user_id === null && context.userId === context.installOwnerUserId)
      )
        return null;
      return RelayDeliveryReceiptSchema.parse({
        messageId: row.message_id,
        scope: 'agent_delivery',
        state: row.state,
        acceptedAt: row.accepted_at,
        updatedAt: row.updated_at,
        expiresAt: row.expires_at,
        ...(row.settled_at === null ? {} : { settledAt: row.settled_at }),
        ...(row.failure_code === null
          ? {}
          : { failure: { code: row.failure_code, message: row.failure_message } }),
      });
    });
  }

  /** Compare-and-set only this observer's accepted row. Late closed callbacks are harmless. */
  settle(messageId: string, outcome: ReceiptSettlement): boolean {
    if (this.closed) return false;
    this.assertOutsideTransaction();
    this.ensureReady();
    return this.atomic(() => {
      this.assertOwner();
      const code =
        outcome.state === 'outcome_unknown'
          ? 'observation_lost'
          : outcome.state === 'failed'
            ? outcome.code
            : null;
      const at = new Date(this.now()).toISOString();
      return (
        this.db.$client
          .prepare(
            `UPDATE relay_delivery_receipts
        SET state = ?, updated_at = ?, settled_at = ?, failure_code = ?, failure_message = ?
        WHERE message_id = ? AND boot_epoch = ? AND state = 'accepted' AND expires_at > ?`
          )
          .run(
            outcome.state,
            at,
            at,
            code,
            code === null ? null : RELAY_DELIVERY_FAILURE_MESSAGES[code],
            messageId,
            this.ownerToken,
            at
          ).changes === 1
      );
    });
  }

  /** Metadata-only recovery is legal only after exclusive ownership is established. */
  recover(): number {
    this.assertOutsideTransaction();
    this.ensureReady();
    return this.atomic(() => {
      this.assertOwner();
      return this.recoverRows(false);
    });
  }

  /** GC must not acquire ownership for an unused or closed observer. */
  pruneExpiredIfReady(): number {
    if (!this.ready || this.closed) return 0;
    return this.pruneExpired();
  }

  /** Delete at most 500 expired observations in a deterministic acceptance-expiry order. */
  pruneExpired(): number {
    this.assertOutsideTransaction();
    this.ensureReady();
    return this.atomic(() => {
      this.assertOwner();
      return this.db.$client
        .prepare(
          `DELETE FROM relay_delivery_receipts WHERE message_id IN
        (SELECT message_id FROM relay_delivery_receipts WHERE expires_at <= ?
         ORDER BY expires_at, message_id LIMIT 500)`
        )
        .run(new Date(this.now()).toISOString()).changes;
    });
  }

  /** Latch callbacks first; failed release may retry without reopening observation. */
  close(): void {
    this.closed = true;
    this.assertOutsideTransaction();
    if (this.released) return;
    if (!this.ready) {
      this.released = true;
      return;
    }
    this.atomic(() => {
      this.assertOwner();
      this.recoverRows(true);
      this.db.$client
        .prepare('DELETE FROM relay_receipt_observer_owner WHERE owner_token = ?')
        .run(this.ownerToken);
    });
    this.released = true;
  }

  private owner(): OwnerRow | undefined {
    return this.db.$client
      .prepare("SELECT * FROM relay_receipt_observer_owner WHERE singleton_key = 'observer'")
      .get() as OwnerRow | undefined;
  }

  private assertOwner(): void {
    if (this.owner()?.owner_token !== this.ownerToken) {
      throw new RelayReceiptUnavailableError('RELAY_RECEIPT_OBSERVER_BUSY');
    }
  }

  private recoverRows(own: boolean): number {
    this.assertOwner();
    const at = new Date(this.now()).toISOString();
    return this.db.$client
      .prepare(
        `UPDATE relay_delivery_receipts SET state = 'outcome_unknown',
      updated_at = ?, settled_at = ?, failure_code = 'observation_lost', failure_message = ?
      WHERE state = 'accepted' AND boot_epoch ${own ? '=' : '!='} ?`
      )
      .run(at, at, RELAY_DELIVERY_FAILURE_MESSAGES.observation_lost, this.ownerToken).changes;
  }

  private atomic<T>(operation: () => T): T {
    this.assertOutsideTransaction();
    let begun = false;
    try {
      this.db.$client.exec('BEGIN IMMEDIATE');
      begun = true;
      const result = operation();
      this.db.$client.exec('COMMIT');
      return result;
    } catch (error) {
      if (begun && this.db.$client.inTransaction) {
        try {
          this.db.$client.exec('ROLLBACK');
        } catch (rollbackError) {
          throw new RelayReceiptUnavailableError(
            'RELAY_RECEIPT_STORAGE_UNAVAILABLE',
            rollbackError
          );
        }
      }
      if (error instanceof RelayReceiptUnavailableError) throw error;
      throw new RelayReceiptUnavailableError('RELAY_RECEIPT_STORAGE_UNAVAILABLE', error);
    }
  }
}
