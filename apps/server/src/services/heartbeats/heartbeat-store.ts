/**
 * The three heartbeat tables, read and written in one place (spec `heartbeats`
 * §11): `heartbeat_state` (the facts behind each agent's next beat),
 * `heartbeat_beats` (one row per beat, the measures' store) and
 * `heartbeat_outbox` (what beats raised, until it reaches its reader).
 *
 * @module services/heartbeats/heartbeat-store
 */
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import {
  heartbeatBeats,
  heartbeatOutbox,
  heartbeatState,
  type Db,
  type HeartbeatBeatRow,
  type HeartbeatOutboxRow,
  type HeartbeatStateRow,
} from '@dorkos/db';
import { REPORT_KEY_PREFIX } from './raises/raise-store.js';

/** A patch to one agent's state row. */
export type HeartbeatStatePatch = Partial<Omit<HeartbeatStateRow, 'agentId'>>;

/** A new beat row. */
export type NewBeat = Pick<HeartbeatBeatRow, 'id' | 'agentId' | 'startedAt' | 'kind' | 'wake'>;

/** What finishing a beat writes. */
export type BeatFinish = Partial<
  Pick<
    HeartbeatBeatRow,
    | 'endedAt'
    | 'outcome'
    | 'changes'
    | 'triage'
    | 'turnSessionId'
    | 'turnUsage'
    | 'raises'
    | 'bypass'
    | 'summary'
    | 'auditSeq'
    | 'kind'
  >
>;

/** A new outbox row. */
export type NewOutboxRow = Omit<HeartbeatOutboxRow, 'deliveredEntryId' | 'closedAt' | 'attempts'>;

/** What makes two held raises the same raise. */
export interface HeldMatch {
  /** The agent that raised it. */
  agentId: string;
  /** Its reader. */
  toAccount: string;
  /** Its stable key. */
  key: string;
  /** How it goes. */
  rung: HeartbeatOutboxRow['rung'];
  /** The room a `room` raise goes to, else null. */
  roomId: string | null;
}

/** The heartbeat tables. */
export class HeartbeatStore {
  /**
   * Build the store over a database.
   *
   * @param db - The server's database.
   */
  constructor(private readonly db: Db) {}

  /**
   * One agent's state row, or undefined before its first beat.
   *
   * @param agentId - The agent's Mesh id.
   */
  getState(agentId: string): HeartbeatStateRow | undefined {
    return this.db.select().from(heartbeatState).where(eq(heartbeatState.agentId, agentId)).get();
  }

  /**
   * Write some of one agent's state, creating the row on first write.
   *
   * @param agentId - The agent's Mesh id.
   * @param patch - The fields to set.
   */
  patchState(agentId: string, patch: HeartbeatStatePatch): void {
    this.db
      .insert(heartbeatState)
      .values({ agentId, ...patch })
      .onConflictDoUpdate({ target: heartbeatState.agentId, set: patch })
      .run();
  }

  /**
   * Open a beat row.
   *
   * @param beat - The new beat.
   */
  insertBeat(beat: NewBeat): void {
    this.db.insert(heartbeatBeats).values(beat).run();
  }

  /**
   * Write what a beat ended with.
   *
   * @param id - The beat's id.
   * @param finish - The fields to set.
   */
  finishBeat(id: string, finish: BeatFinish): void {
    this.db.update(heartbeatBeats).set(finish).where(eq(heartbeatBeats.id, id)).run();
  }

  /**
   * One beat, or undefined.
   *
   * @param id - The beat's id.
   */
  getBeat(id: string): HeartbeatBeatRow | undefined {
    return this.db.select().from(heartbeatBeats).where(eq(heartbeatBeats.id, id)).get();
  }

  /** Beats still open: a restart found them mid-beat (spec §3.2). */
  openBeats(): HeartbeatBeatRow[] {
    return this.db.select().from(heartbeatBeats).where(isNull(heartbeatBeats.endedAt)).all();
  }

  /**
   * One agent's latest beats, newest first.
   *
   * @param agentId - The agent's Mesh id.
   * @param limit - At most this many.
   */
  lastBeats(agentId: string, limit: number): HeartbeatBeatRow[] {
    return this.db
      .select()
      .from(heartbeatBeats)
      .where(eq(heartbeatBeats.agentId, agentId))
      .orderBy(desc(heartbeatBeats.startedAt))
      .limit(limit)
      .all();
  }

  /**
   * When an agent last swept, or null when it never has.
   *
   * @param agentId - The agent's Mesh id.
   */
  lastSweepAt(agentId: string): string | null {
    const row = this.db
      .select({ at: heartbeatBeats.startedAt })
      .from(heartbeatBeats)
      .where(
        and(
          eq(heartbeatBeats.agentId, agentId),
          eq(heartbeatBeats.kind, 'sweep'),
          // Only a sweep whose turn ran counts; a refused or busy one is owed.
          inArray(heartbeatBeats.outcome, ['worked', 'no-end-beat'])
        )
      )
      .orderBy(desc(heartbeatBeats.startedAt))
      .limit(1)
      .get();
    return row?.at ?? null;
  }

  /**
   * The chats an agent's beat turns ran in, so its health check leaves out what
   * its own beats did.
   *
   * @param agentId - The agent's Mesh id.
   */
  beatSessionIds(agentId: string): Set<string> {
    const rows = this.db
      .selectDistinct({ id: heartbeatBeats.turnSessionId })
      .from(heartbeatBeats)
      .where(and(eq(heartbeatBeats.agentId, agentId), isNotNull(heartbeatBeats.turnSessionId)))
      .all();
    return new Set(rows.map((row) => row.id).filter((id): id is string => id !== null));
  }

  /**
   * Delete beat rows older than a moment. Their audit rows stay forever.
   *
   * @param beforeIso - Rows that started before this go.
   * @returns How many went.
   */
  pruneBeats(beforeIso: string): number {
    return this.db.delete(heartbeatBeats).where(lt(heartbeatBeats.startedAt, beforeIso)).run()
      .changes;
  }

  /**
   * Add a raise to the outbox.
   *
   * @param row - The raise.
   */
  insertOutbox(row: NewOutboxRow): void {
    this.db.insert(heartbeatOutbox).values(row).run();
  }

  /**
   * Held raises whose moment has come, oldest first.
   *
   * @param nowIso - The moment to judge by.
   */
  dueOutbox(nowIso: string): HeartbeatOutboxRow[] {
    return this.db
      .select()
      .from(heartbeatOutbox)
      .where(and(eq(heartbeatOutbox.state, 'held'), lte(heartbeatOutbox.deliverAfter, nowIso)))
      .orderBy(asc(heartbeatOutbox.createdAt))
      .all();
  }

  /**
   * One agent's raises still held, oldest first.
   *
   * @param agentId - The agent's Mesh id.
   */
  heldFor(agentId: string): HeartbeatOutboxRow[] {
    return this.db
      .select()
      .from(heartbeatOutbox)
      .where(and(eq(heartbeatOutbox.agentId, agentId), eq(heartbeatOutbox.state, 'held')))
      .orderBy(asc(heartbeatOutbox.createdAt))
      .all();
  }

  /**
   * The held row for one raise, if one is waiting: the same agent, reader, rung,
   * room and key. A raise to the same person on another rung, or into another
   * room, is a different message and never takes its place.
   *
   * @param match - Who raised it, to whom, how, where, and its key.
   */
  findHeld(match: HeldMatch): HeartbeatOutboxRow | undefined {
    return this.db
      .select()
      .from(heartbeatOutbox)
      .where(
        and(
          eq(heartbeatOutbox.agentId, match.agentId),
          eq(heartbeatOutbox.toAccount, match.toAccount),
          eq(heartbeatOutbox.key, match.key),
          eq(heartbeatOutbox.rung, match.rung),
          match.roomId === null
            ? isNull(heartbeatOutbox.roomId)
            : eq(heartbeatOutbox.roomId, match.roomId),
          eq(heartbeatOutbox.state, 'held')
        )
      )
      .get();
  }

  /**
   * Replace a held row's words with a newer version of the same raise.
   *
   * @param id - The row.
   * @param patch - The new text, urgency and delivery time.
   */
  refreshHeld(
    id: string,
    patch: Pick<HeartbeatOutboxRow, 'text' | 'urgent' | 'deliverAfter' | 'about' | 'beatId'>
  ): void {
    this.db.update(heartbeatOutbox).set(patch).where(eq(heartbeatOutbox.id, id)).run();
  }

  /**
   * Write down a raise that went out at once (a room post), so it counts as
   * open and, when urgent, against its reader's hour.
   *
   * @param row - The raise.
   * @param at - When it went out (ISO 8601).
   * @param entryId - The room entry it landed as, when known.
   */
  insertDelivered(row: Omit<NewOutboxRow, 'state'>, at: string, entryId?: string): void {
    this.db
      .insert(heartbeatOutbox)
      .values({
        ...row,
        state: 'delivered',
        closedAt: at,
        ...(entryId ? { deliveredEntryId: entryId } : {}),
      })
      .run();
  }

  /**
   * When each urgent raise to one reader went out, or is due to, from a moment
   * on: what the per-person urgent ceiling counts. A sent one counts at the
   * moment it was delivered, however long it was held; a held one at the moment
   * it is due, the future included. A held row that was resolved before it went
   * out never reached anybody and is not counted.
   *
   * @param toAccount - The reader.
   * @param sinceIso - The earliest moment that counts.
   * @param excludeId - A held row being replaced, which must not count against itself.
   * @returns Epoch ms, ascending.
   */
  urgentMoments(toAccount: string, sinceIso: string, excludeId?: string): number[] {
    const rows = this.db
      .select({
        id: heartbeatOutbox.id,
        state: heartbeatOutbox.state,
        deliverAfter: heartbeatOutbox.deliverAfter,
        closedAt: heartbeatOutbox.closedAt,
      })
      .from(heartbeatOutbox)
      .where(
        and(
          eq(heartbeatOutbox.toAccount, toAccount),
          eq(heartbeatOutbox.urgent, 1),
          or(
            and(eq(heartbeatOutbox.state, 'held'), gt(heartbeatOutbox.deliverAfter, sinceIso)),
            and(
              inArray(heartbeatOutbox.state, ['delivered', 'resolved']),
              gt(heartbeatOutbox.closedAt, sinceIso),
              lte(heartbeatOutbox.deliverAfter, heartbeatOutbox.closedAt)
            )
          )
        )
      )
      .all();
    return rows
      .filter((row) => row.id !== excludeId)
      .map((row) => Date.parse(row.state === 'held' ? row.deliverAfter : row.closedAt!))
      .sort((a, b) => a - b);
  }

  /**
   * Settle an agent's raises by key: a held one closes unsent, and a delivered
   * one stops being open while keeping the moment it was delivered.
   *
   * @param agentId - The agent.
   * @param keys - The raise keys.
   * @param at - When (ISO 8601).
   */
  resolveRaises(agentId: string, keys: readonly string[], at: string): void {
    // A report's own row is never a raise an agent can close (its lines would be stranded).
    const raiseKeys = keys.filter((key) => !key.startsWith(REPORT_KEY_PREFIX));
    if (raiseKeys.length === 0) return;
    const mine = and(eq(heartbeatOutbox.agentId, agentId), inArray(heartbeatOutbox.key, raiseKeys));
    this.db
      .update(heartbeatOutbox)
      .set({ state: 'resolved', closedAt: at })
      .where(and(mine, eq(heartbeatOutbox.state, 'held')))
      .run();
    this.db
      .update(heartbeatOutbox)
      .set({ state: 'resolved' })
      .where(and(mine, eq(heartbeatOutbox.state, 'delivered')))
      .run();
  }

  /**
   * A failed delivery: count it and try again later.
   *
   * @param ids - The rows that went out together.
   * @param deliverAfter - When to try again (ISO 8601).
   */
  failedAttempt(ids: string[], deliverAfter: string): void {
    if (ids.length === 0) return;
    this.db
      .update(heartbeatOutbox)
      .set({ attempts: sql`${heartbeatOutbox.attempts} + 1`, deliverAfter })
      .where(inArray(heartbeatOutbox.id, ids))
      .run();
  }

  /**
   * Move a held row's delivery to a later moment.
   *
   * @param id - The row.
   * @param deliverAfter - Not before this (ISO 8601).
   */
  rescheduleOutbox(id: string, deliverAfter: string): void {
    this.db.update(heartbeatOutbox).set({ deliverAfter }).where(eq(heartbeatOutbox.id, id)).run();
  }

  /**
   * Close outbox rows.
   *
   * @param ids - The rows.
   * @param state - Where they end up.
   * @param at - When (ISO 8601).
   * @param entryId - The room entry they landed as, when delivered.
   */
  closeOutbox(
    ids: string[],
    state: 'delivered' | 'dropped' | 'resolved',
    at: string,
    entryId?: string
  ): void {
    if (ids.length === 0) return;
    this.db
      .update(heartbeatOutbox)
      .set({ state, closedAt: at, ...(entryId ? { deliveredEntryId: entryId } : {}) })
      .where(inArray(heartbeatOutbox.id, ids))
      .run();
  }
}
