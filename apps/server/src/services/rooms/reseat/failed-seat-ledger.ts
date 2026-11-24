/**
 * The durable half of failed room-chat recovery (DOR-4626). A room chat's turn that fails with a
 * server error leaves its recovery authority on the live session (`priorServerFailure`) and its
 * level in `turn-levels.ts`, both process memory, so a restart used to leave the seat with no way
 * back. This ledger keeps one server-written row per failed chat so a LATER server process can
 * still run that one recovery, and refuses everything else.
 *
 * ## What a row may authorize
 *
 * Only a process that did not write it may restore from it: while the writing process lives, its
 * memory stays the only authority, exactly as before. A row older than {@link
 * FAILED_SEAT_RESTORE_MAX_MS}, from the future, unreadable, or already claimed restores nothing.
 * A claim is one-shot and durable, so a recovery a restart interrupted never runs twice. The row
 * is never proof on its own: the caller still matches it against the session's latest durable
 * turn and every current guard.
 *
 * ## Crash loops and cold chats (decided for DOR-4626)
 *
 * A restart must never unlock what the writing process refused: when that process's crash
 * policy refuses the chat (its process keeps dying), the row is spent there and then
 * ({@link FailedSeatLedger.consume} from `session-crash-recovery.ts`), so no later process
 * restores it. A chat whose process was merely gone (reaped while idle, or evicted) is `'cold'`,
 * not refused, and may recover once after a restart.
 *
 * ## One process per data folder
 *
 * "Another process" means "an earlier one" only because DorkOS holds an instance lock on the
 * data folder (`lib/instance-lock.ts`), so two servers never share this table at once. The lock
 * is off behind `DORKOS_SKIP_INSTANCE_LOCK` and inert under `NODE_ENV=test`; with it off, two
 * live servers on one data folder would each read the other's rows as restorable.
 *
 * @module services/rooms/reseat/failed-seat-ledger
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { and, eq, isNull, lt, ne, roomSeatFailures, type Db, type DbTransaction } from '@dorkos/db';
import type { AsideCarry } from '../room-trigger/aside.js';

/**
 * How long after a failure a later process may still restore it: the hand-off wait bound
 * (`HANDOFF_WAIT_MAX_MS`), since a waiting hand-off is what asks for the recovery. Pinned equal
 * by a test rather than imported, so this storage module stays free of the hand-off service.
 */
export const FAILED_SEAT_RESTORE_MAX_MS = 60 * 60_000;

/** One id per server process; a module reload in a test is a new process. */
const PROCESS_BOOT_ID = randomUUID();

const levelSchema = z
  .object({
    asks: z.enum(['always', 'when-risky', 'never']),
    reach: z.enum(['read', 'edit', 'workspace', 'everything']),
    auto: z.literal(true).optional(),
    outsider: z.literal(true).optional(),
    teammate: z
      .array(z.object({ roomId: z.string().min(1), authorId: z.string().min(1) }).strict())
      .optional(),
  })
  .strict();
const boundSchema = z.union([levelSchema, z.literal('runtime-default')]);

const payloadSchema = z
  .object({
    version: z.literal(1),
    dispatchId: z.string().min(1),
    entryId: z.string().min(1),
    root: z.string().min(1),
    inference: z.enum(['credits', 'own-account']),
    billing: z.enum(['subscription', 'per-token']),
    // The failed turn's own carry with its level joined in: never optional, since a failure whose
    // level was unknown is not recorded at all.
    carry: z
      .object({
        externalAuthor: z.boolean(),
        permissionCeiling: z.union([boundSchema, z.array(boundSchema).min(1)]),
        teammate: z.literal(true).optional(),
        outsider: z.literal(true).optional(),
        outsideWords: z.literal(true).optional(),
      })
      .strict(),
  })
  .strict();

/** What the server saw when a room chat's turn failed, with nothing a caller supplied. */
export interface FailedSeatRecord {
  dispatchId: string;
  entryId: string;
  root: string;
  inference: 'credits' | 'own-account';
  billing: 'subscription' | 'per-token';
  /** The failed turn's carry, its level joined into the ceiling. */
  carry: AsideCarry & { permissionCeiling: NonNullable<AsideCarry['permissionCeiling']> };
}

/** Durable, one-shot restart records for failed room chats. */
export class FailedSeatLedger {
  /** Claims this process holds, so the attempt that claimed a row can still read it. */
  private readonly claims = new Set<string>();

  /**
   * Bind the ledger to the app database for one server process.
   *
   * @param db - The app database.
   * @param bootId - This process's id; tests pass another to stand for a later process.
   */
  constructor(
    private readonly db: Db | DbTransaction,
    private readonly bootId: string = PROCESS_BOOT_ID
  ) {}

  /**
   * Keep a failed turn's record, replacing the chat's earlier one, and drop rows too old to use.
   *
   * @param sessionId - The chat whose turn failed.
   * @param record - What the server saw.
   * @param now - The clock, for tests.
   */
  record(sessionId: string, record: FailedSeatRecord, now = Date.now()): void {
    const payload = JSON.stringify(payloadSchema.parse({ version: 1, ...record }));
    this.dropOlderThan(now);
    this.db
      .insert(roomSeatFailures)
      .values({ sessionId, bootId: this.bootId, payload, recordedAt: now, consumedAt: null })
      .onConflictDoUpdate({
        target: roomSeatFailures.sessionId,
        set: { bootId: this.bootId, payload, recordedAt: now, consumedAt: null },
      })
      .run();
  }

  /**
   * A failure an earlier process recorded, or `null` for anything missing, corrupt, too old,
   * written by this process, or claimed by an attempt that is not this process's own.
   *
   * @param sessionId - The failed chat.
   * @param now - The clock, for tests.
   */
  restore(sessionId: string, now = Date.now()): FailedSeatRecord | null {
    const row = this.db
      .select()
      .from(roomSeatFailures)
      .where(eq(roomSeatFailures.sessionId, sessionId))
      .get();
    if (!row || row.bootId === this.bootId) return null;
    if (row.recordedAt > now || now - row.recordedAt > FAILED_SEAT_RESTORE_MAX_MS) {
      // Too old ever to restore: drop it here rather than wait for the next failure's write.
      if (row.recordedAt <= now) this.dropOlderThan(now);
      return null;
    }
    if (row.consumedAt !== null && !this.claims.has(sessionId)) return null;
    let parsed: z.infer<typeof payloadSchema>;
    try {
      parsed = payloadSchema.parse(JSON.parse(row.payload));
    } catch {
      return null;
    }
    if (parsed.root !== resolve(parsed.root)) return null;
    const { version: _version, ...record } = parsed;
    return record;
  }

  /**
   * Spend a restorable row for one recovery attempt. Durable before the attempt runs, so a
   * restart mid-attempt never grants a second one.
   *
   * @param sessionId - The failed chat.
   * @param now - The clock, for tests.
   * @returns Whether this attempt holds the claim.
   */
  claim(sessionId: string, now = Date.now()): boolean {
    if (this.restore(sessionId, now) === null) return false;
    const claimed = this.db
      .update(roomSeatFailures)
      .set({ consumedAt: now })
      .where(
        and(
          eq(roomSeatFailures.sessionId, sessionId),
          isNull(roomSeatFailures.consumedAt),
          ne(roomSeatFailures.bootId, this.bootId)
        )
      )
      .run();
    if (claimed.changes !== 1) return false;
    this.claims.add(sessionId);
    return true;
  }

  /**
   * Whether this process's current attempt holds the chat's claim.
   *
   * @param sessionId - The failed chat.
   */
  holdsClaim(sessionId: string): boolean {
    return this.claims.has(sessionId);
  }

  /** Drop rows too old ever to restore. */
  private dropOlderThan(now: number): void {
    this.db
      .delete(roomSeatFailures)
      .where(lt(roomSeatFailures.recordedAt, now - FAILED_SEAT_RESTORE_MAX_MS))
      .run();
  }

  /**
   * End this process's attempt. The row stays spent.
   *
   * @param sessionId - The failed chat.
   */
  endClaim(sessionId: string): void {
    this.claims.delete(sessionId);
  }

  /**
   * Spend a chat's row after any recovery moved its seat, whichever process recorded it, or when
   * this process refuses the chat for a crash loop.
   *
   * @param sessionId - The chat the seat moved away from.
   * @param now - The clock, for tests.
   */
  consume(sessionId: string, now = Date.now()): void {
    this.db
      .update(roomSeatFailures)
      .set({ consumedAt: now })
      .where(and(eq(roomSeatFailures.sessionId, sessionId), isNull(roomSeatFailures.consumedAt)))
      .run();
  }
}
