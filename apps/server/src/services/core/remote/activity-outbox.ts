/**
 * The durable outbox of managed remote access activity reports (DOR-2086),
 * over the `remote_event_outbox` table.
 *
 * Every batch is written here, with the `Idempotency-Key` it will be sent
 * under, BEFORE it is sent ({@link ActivityOutbox.enqueue}). A row is never
 * edited: a retry after a timeout, a lost answer or a restart sends the very
 * same body under the very same key, and new activity goes into a new row with
 * a new key. That is the whole of "change the key only when the contents
 * change". A row leaves the outbox only once Cloud accepted it
 * ({@link ActivityOutbox.retire}), or when it is dropped by the bounds below.
 *
 * Bounded: at most {@link OUTBOX_MAX_ROWS} rows, oldest dropped first, and none
 * older than {@link OUTBOX_RETENTION_MS}. A report that cannot get through
 * never grows the database without end, and never blocks anything local.
 *
 * Nothing here holds a Cloud bearer, a credential value or a secret: a batch
 * is counts, times, reasons and ids.
 *
 * @module services/core/remote/activity-outbox
 */
import { randomUUID } from 'node:crypto';
import { asc, eq, lt, notInArray, sql } from 'drizzle-orm';
import { remoteEventOutbox, type Db } from '@dorkos/db';
import { RemoteEventBatchSchema } from '@dork-labs/cloud-api';
import type { z } from 'zod';

/** One `POST /v1/remote/events` body, as the published schema reads it. */
export type RemoteEventBatch = z.infer<typeof RemoteEventBatchSchema>;

/** The most batches kept waiting; the oldest go first past it. */
export const OUTBOX_MAX_ROWS = 200;

/** How long a batch may wait before it is dropped unsent. */
export const OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** One batch waiting to be sent. */
export interface OutboxBatch {
  /** Local id of the row. */
  id: string;
  /** The `Idempotency-Key` it is always sent under. */
  idempotencyKey: string;
  /** The body, exactly as stored. */
  batch: RemoteEventBatch;
  /** How many times it was sent. */
  attempts: number;
}

/** The outbox. One per process, over the server's database. */
export class ActivityOutbox {
  /**
   * Build the outbox.
   *
   * @param db - The server's database.
   * @param now - The clock.
   * @param newKey - A key Cloud has never seen; one per batch.
   */
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
    private readonly newKey: () => string = randomUUID
  ) {}

  /**
   * Persist a batch and the key it will be sent under, before anything sends
   * it. An empty batch is never written: there is nothing to report.
   *
   * @param batch - The body to send; checked against the published schema.
   * @returns The stored row, or `null` for an empty batch.
   * @throws When the batch does not match the published schema.
   */
  enqueue(batch: RemoteEventBatch): OutboxBatch | null {
    const parsed = RemoteEventBatchSchema.parse(batch);
    if (parsed.activity.length === 0 && parsed.closeReports.length === 0) return null;
    const row = {
      id: randomUUID(),
      idempotencyKey: this.newKey(),
      instanceId: parsed.instanceId,
      batch: JSON.stringify(parsed),
      createdAt: new Date(this.now()).toISOString(),
    };
    this.db.insert(remoteEventOutbox).values(row).run();
    this.prune();
    return { id: row.id, idempotencyKey: row.idempotencyKey, batch: parsed, attempts: 0 };
  }

  /**
   * The batches waiting for `instanceId`, oldest first. A row this build
   * cannot read is dropped rather than retried forever.
   *
   * @param instanceId - The Cloud instance id of the link that sends them.
   * @param limit - At most this many.
   */
  pending(instanceId: string, limit = 20): OutboxBatch[] {
    const rows = this.db
      .select()
      .from(remoteEventOutbox)
      .where(eq(remoteEventOutbox.instanceId, instanceId))
      // `rowid` breaks a tie between batches written in the same millisecond.
      .orderBy(asc(remoteEventOutbox.createdAt), sql`rowid`)
      .limit(limit)
      .all();
    const batches: OutboxBatch[] = [];
    for (const row of rows) {
      const parsed = RemoteEventBatchSchema.safeParse(safeJson(row.batch));
      if (!parsed.success) {
        this.retire(row.id);
        continue;
      }
      batches.push({
        id: row.id,
        idempotencyKey: row.idempotencyKey,
        batch: parsed.data,
        attempts: row.attempts,
      });
    }
    return batches;
  }

  /** How many batches are waiting, for every link. */
  size(): number {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(remoteEventOutbox)
      .get();
    return row?.count ?? 0;
  }

  /**
   * Record that a batch is about to be sent. Its body and key are unchanged.
   *
   * @param id - The row.
   */
  noteAttempt(id: string): void {
    this.db
      .update(remoteEventOutbox)
      .set({
        attempts: sql`${remoteEventOutbox.attempts} + 1`,
        lastAttemptAt: new Date(this.now()).toISOString(),
      })
      .where(eq(remoteEventOutbox.id, id))
      .run();
  }

  /**
   * Remove a batch: Cloud accepted it (or had already), or it is given up on.
   *
   * @param id - The row.
   */
  retire(id: string): void {
    this.db.delete(remoteEventOutbox).where(eq(remoteEventOutbox.id, id)).run();
  }

  /**
   * Drop batches past the age limit, then the oldest past the row limit.
   *
   * @returns How many were dropped.
   */
  prune(): number {
    const cutoff = new Date(this.now() - OUTBOX_RETENTION_MS).toISOString();
    const aged = this.db
      .delete(remoteEventOutbox)
      .where(lt(remoteEventOutbox.createdAt, cutoff))
      .run().changes;
    const keep = this.db
      .select({ id: remoteEventOutbox.id })
      .from(remoteEventOutbox)
      .orderBy(sql`${remoteEventOutbox.createdAt} DESC`, sql`rowid DESC`)
      .limit(OUTBOX_MAX_ROWS);
    const over = this.db
      .delete(remoteEventOutbox)
      .where(notInArray(remoteEventOutbox.id, keep))
      .run().changes;
    return aged + over;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
