/**
 * The durable acknowledgement journal for managed remote access commands
 * (DOR-2086), over the `remote_command_journal` table.
 *
 * The dispatcher writes a row for every leased command BEFORE it acts on it
 * ({@link CommandJournal.record}), records the outcome once the effect is done
 * ({@link CommandJournal.settle}), and the acknowledgement sender works through
 * what is still pending ({@link CommandJournal.pendingAcks}). Because the row
 * exists before the effect runs, a command id seen again (a redelivery after a
 * lost acknowledgement, a restart, a reconnect) is recognised and answered with
 * the recorded outcome instead of acting twice.
 *
 * Nothing here ever holds a Cloud bearer, a tunnel credential value or an edge
 * proof secret. The lease token is kept because an acknowledgement presents
 * it; it is never logged.
 *
 * @module services/core/remote/command-journal
 */
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notInArray,
  sql,
} from 'drizzle-orm';
import { remoteCommandJournal, type Db, type RemoteCommandJournalRow } from '@dorkos/db';
import type { RemoteCommandOutcome } from '@dork-labs/cloud-api';

/** How long a journal row is kept, settled or not: far past any lease. */
export const JOURNAL_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** How many finished rows (acknowledged, rejected or unconfirmed) are kept at most. */
export const JOURNAL_MAX_FINISHED_ROWS = 500;

/** The leased command kinds a row can hold. */
export type JournalVerb = RemoteCommandJournalRow['verb'];

/** What {@link CommandJournal.record} found. */
export type JournalRecordResult =
  /** First sighting: the row is written and the effect may run. */
  | { kind: 'new' }
  /**
   * Seen before. `outcome` is what was recorded, or `null` while the first
   * delivery is still being acted on. Either way the effect must not run again.
   */
  | { kind: 'duplicate'; outcome: RemoteCommandOutcome | null };

/** One acknowledgement still owed to Cloud. */
export interface PendingAck {
  id: string;
  leaseToken: string;
  outcome: RemoteCommandOutcome;
  attempts: number;
}

/** The journal. One per process, built over the server's database. */
export class CommandJournal {
  /**
   * Build the journal.
   *
   * @param db - The server's database.
   * @param now - The clock, for timestamps and pruning.
   */
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Journal a leased command before acting on it, or recognise it.
   *
   * A redelivery under a new lease token replaces the stored token and puts a
   * settled row's acknowledgement back to pending, because the old lease can no
   * longer be settled and the new one must be.
   *
   * @param input.commandId - Cloud's command id.
   * @param input.leaseToken - The lease token this delivery carried.
   * @param input.verb - The command kind.
   * @param input.instanceId - The Cloud instance id of the link it arrived on.
   */
  record(input: {
    commandId: string;
    leaseToken: string;
    verb: JournalVerb;
    instanceId: string;
  }): JournalRecordResult {
    const at = new Date(this.now()).toISOString();
    return this.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(remoteCommandJournal)
        .where(eq(remoteCommandJournal.commandId, input.commandId))
        .get();
      if (!existing) {
        tx.insert(remoteCommandJournal)
          .values({ ...input, receivedAt: at })
          .run();
        return { kind: 'new' } as const;
      }
      if (existing.leaseToken !== input.leaseToken) {
        tx.update(remoteCommandJournal)
          .set({
            leaseToken: input.leaseToken,
            ...(existing.outcome !== null ? { ackState: 'pending' as const, ackedAt: null } : {}),
          })
          .where(eq(remoteCommandJournal.commandId, input.commandId))
          .run();
      }
      return {
        kind: 'duplicate',
        outcome: existing.outcome as RemoteCommandOutcome | null,
      } as const;
    });
  }

  /**
   * Record what was done with a command. Only the first outcome counts: a
   * command already settled keeps the outcome it had.
   *
   * @param commandId - Cloud's command id.
   * @param outcome - What this computer did.
   */
  settle(commandId: string, outcome: RemoteCommandOutcome): void {
    this.db
      .update(remoteCommandJournal)
      .set({ outcome, settledAt: new Date(this.now()).toISOString() })
      .where(
        and(eq(remoteCommandJournal.commandId, commandId), isNull(remoteCommandJournal.outcome))
      )
      .run();
  }

  /**
   * Settle every row left without an outcome as `failed`: they were
   * interrupted mid-effect by a crash or a restart, and repeating the effect
   * blind could repeat something destructive. Cloud learns the truth from the
   * acknowledgement, and can send a fresh command.
   *
   * @returns How many rows were settled.
   */
  settleInterrupted(): number {
    return this.db
      .update(remoteCommandJournal)
      .set({ outcome: 'failed', settledAt: new Date(this.now()).toISOString() })
      .where(isNull(remoteCommandJournal.outcome))
      .run().changes;
  }

  /**
   * The settled commands whose acknowledgement Cloud has not accepted yet,
   * oldest first, for the link with this instance id only.
   *
   * @param instanceId - The current link's instance id.
   * @param limit - At most this many (the ack route takes a hundred).
   */
  pendingAcks(instanceId: string, limit = 100): PendingAck[] {
    const rows = this.db
      .select()
      .from(remoteCommandJournal)
      .where(
        and(
          eq(remoteCommandJournal.ackState, 'pending'),
          eq(remoteCommandJournal.instanceId, instanceId),
          isNotNull(remoteCommandJournal.outcome)
        )
      )
      .orderBy(asc(remoteCommandJournal.receivedAt))
      .limit(limit)
      .all();
    return rows.map((row) => ({
      id: row.commandId,
      leaseToken: row.leaseToken,
      outcome: row.outcome as RemoteCommandOutcome,
      attempts: row.ackAttempts,
    }));
  }

  /**
   * Count an acknowledgement attempt for these commands.
   *
   * @param commandIds - The commands just sent.
   */
  noteAttempt(commandIds: string[]): void {
    if (commandIds.length === 0) return;
    this.db
      .update(remoteCommandJournal)
      .set({ ackAttempts: sql`${remoteCommandJournal.ackAttempts} + 1` })
      .where(inArray(remoteCommandJournal.commandId, commandIds))
      .run();
  }

  /**
   * Mark acknowledgements finished, but only for the lease tokens that were
   * sent: a redelivery that replaced a token meanwhile stays pending.
   *
   * @param items - The commands and the lease tokens their acknowledgement carried.
   * @param state - `acked` (Cloud settled it), `rejected` (Cloud refused the
   *   lease outright) or `unconfirmed` (Cloud settled nothing for it).
   */
  finish(
    items: ReadonlyArray<{ id: string; leaseToken: string }>,
    state: 'acked' | 'rejected' | 'unconfirmed'
  ): void {
    const at = new Date(this.now()).toISOString();
    for (const item of items) {
      this.db
        .update(remoteCommandJournal)
        .set({ ackState: state, ackedAt: at })
        .where(
          and(
            eq(remoteCommandJournal.commandId, item.id),
            eq(remoteCommandJournal.leaseToken, item.leaseToken)
          )
        )
        .run();
    }
  }

  /**
   * Keep the journal bounded: drop every row older than
   * {@link JOURNAL_RETENTION_MS}, and every finished row beyond the newest
   * {@link JOURNAL_MAX_FINISHED_ROWS}.
   *
   * @returns How many rows were removed.
   */
  prune(): number {
    const cutoff = new Date(this.now() - JOURNAL_RETENTION_MS).toISOString();
    let removed = this.db
      .delete(remoteCommandJournal)
      .where(lt(remoteCommandJournal.receivedAt, cutoff))
      .run().changes;
    const keep = this.db
      .select({ id: remoteCommandJournal.commandId })
      .from(remoteCommandJournal)
      .where(ne(remoteCommandJournal.ackState, 'pending'))
      .orderBy(desc(remoteCommandJournal.receivedAt))
      .limit(JOURNAL_MAX_FINISHED_ROWS)
      .all()
      .map((row) => row.id);
    removed += this.db
      .delete(remoteCommandJournal)
      .where(
        and(
          ne(remoteCommandJournal.ackState, 'pending'),
          keep.length > 0 ? notInArray(remoteCommandJournal.commandId, keep) : undefined
        )
      )
      .run().changes;
    return removed;
  }

  /**
   * Read rows by command id, for tests and diagnostics. Never logged as is:
   * a row carries its lease token.
   *
   * @param commandIds - The ids to read.
   */
  read(commandIds: string[]): RemoteCommandJournalRow[] {
    if (commandIds.length === 0) return [];
    return this.db
      .select()
      .from(remoteCommandJournal)
      .where(inArray(remoteCommandJournal.commandId, commandIds))
      .all();
  }
}
