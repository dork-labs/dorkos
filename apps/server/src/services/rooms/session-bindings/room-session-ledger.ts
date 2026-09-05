/**
 * Which session id a room's memory should be pointing at, as ids move under it
 * (DOR-784).
 *
 * `RoomStore` next door owns the ordinary per-`(room, agent)` CRUD over
 * `room_sessions`: read the binding, write it once, move it when a turn reports.
 * This owns the harder question that appeared when those ids turned out not to
 * hold still — a room mints a placeholder before its first turn, and Claude Code
 * renames the session mid-turn — so two operations here are keyed by SESSION id
 * rather than by room, and a small table (`room_session_retirements`) says which
 * ids are dead.
 *
 * Split out rather than added to the store because it is a different subject
 * with a different key. `RoomStore` holds one of these and consults it on the
 * one write that can go backwards.
 *
 * **Retirements are on disk, not in this process's head** (DOR-1205). They were
 * a 512-entry map, on the reasoning that a rekey is an event in one process's
 * life and the successor is written into `room_sessions` the moment it happens.
 * That was true of the guard's fast path and false of everything slower: the
 * refusal did not exist until the first request AFTER this process had watched a
 * rename, so a turn still in flight across a restart could put a room back onto
 * a dead id — and the boot repair sweep, whose whole job is bindings that broke
 * before this process started, had by construction nothing to repair from.
 *
 * @module server/services/rooms/session-bindings/room-session-ledger
 */
import { roomSessions, roomSessionRetirements, eq, lt, type Db } from '@dorkos/db';
import { logger } from '../../../lib/logger.js';

/** One `(room, agent) → session` binding, as the convergence paths read it. */
export interface RoomSessionBinding {
  roomId: string;
  authorId: string;
  sessionId: string;
}

/**
 * How long a retirement is kept before it is forgotten (DOR-1205).
 *
 * **Bounded by age, not by count, because what it has to outlive is a room
 * going quiet.** The old in-memory map kept the last 512 renames on the
 * reasoning that a stale id can only be written back within one turn — true of
 * the write `RoomStore.rebindRoomSession` refuses, and not true of the other
 * reader. The boot sweep asks about bindings that have been sitting wrong since
 * whenever they broke, and a room somebody comes back to after three weeks away
 * is exactly the one whose amnesia would otherwise be permanent.
 *
 * Thirty days is that: comfortably longer than any gap a person would call
 * "coming back to it", and short enough that the table holds a bounded, small
 * number of rows — one per rename that touched a room, which is at most one per
 * conversation that has actually started in one.
 */
const RETIREMENT_HORIZON_MS = 30 * 24 * 60 * 60_000;

/**
 * How many renames deep the successor chase will follow before giving up.
 *
 * A session can be renamed more than once (the SDK assigns a new id on some
 * resumes), so `A → B → C` is reachable and a binding stranded on `A` has to
 * land on `C` — repairing it to `B` would move it onto another dead id. The
 * chase is bounded rather than trusted: nothing enforces acyclicity in a table
 * two processes may have written across a restart, and a loop here would hang
 * the write path of every turn.
 */
const SUCCESSOR_CHASE_LIMIT = 16;

/** The columns every read here projects. */
const BINDING_COLUMNS = {
  roomId: roomSessions.roomId,
  authorId: roomSessions.authorId,
  sessionId: roomSessions.sessionId,
};

/** Session-id-keyed reads and writes over `room_sessions`, plus which ids are dead. */
export class RoomSessionLedger {
  /**
   * Open the ledger over one database.
   *
   * @param db - Where bindings and retirements are stored.
   * @param now - Clock, injectable so a test can age a retirement past the
   *   horizon without waiting a month.
   */
  constructor(
    private readonly db: Db,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * Every binding this install holds — the backfill sweep's input.
   *
   * Deliberately unfiltered and unpaginated: `room_sessions` holds one row per
   * `(room, agent)` pair that has ever answered, which is bounded by how many
   * agents a person has put in how many rooms. A machine with a hundred of those
   * is a busy one.
   */
  list(): RoomSessionBinding[] {
    return this.db.select(BINDING_COLUMNS).from(roomSessions).all();
  }

  /**
   * The room binding a session answers for, or `undefined` when it answers for
   * none.
   *
   * One indexed read, and then — only on a miss — one more through
   * {@link successorFor}. That second read is the point: an id is rekeyed
   * mid-turn, and the rebind moves the binding onto the NEW id, so a caller
   * holding the id the turn started under would otherwise be told this session
   * belongs to no room. It is exactly the turn that most needs the answer,
   * because the prompt it raised is live right now.
   *
   * Ordinary CRUD by `(room, agent)` still belongs to `RoomStore`; this is
   * keyed the other way, like everything else in this file.
   *
   * @param sessionId - Either of the session's ids.
   * @returns The binding, with the room and the agent's author id in it.
   */
  bindingForSession(sessionId: string): RoomSessionBinding | undefined {
    const direct = this.db
      .select(BINDING_COLUMNS)
      .from(roomSessions)
      .where(eq(roomSessions.sessionId, sessionId))
      .get();
    if (direct !== undefined) return direct;
    const successor = this.successorFor(sessionId);
    if (successor === undefined) return undefined;
    return this.db
      .select(BINDING_COLUMNS)
      .from(roomSessions)
      .where(eq(roomSessions.sessionId, successor))
      .get();
  }

  /**
   * Move every binding that holds `oldSessionId` onto `newSessionId`, and
   * remember that `oldSessionId` is dead.
   *
   * The event-driven half of DOR-784. The room mints a placeholder id before the
   * first turn (`room-trigger.ts`) and the runtime renames the session mid-turn;
   * the projector announces that rename to every id-keyed subsystem
   * (`onProjectorRekey`), and this is the rooms domain answering it. Following
   * the RENAME rather than the turn's return value is what makes convergence
   * immediate: the old path waited for the turn to end and compared once, so
   * turn 1 — the only turn where the id actually moves — routinely kept the
   * placeholder and the room woke up with no memory on message two.
   *
   * Called on every rekey, including the overwhelming majority that touch no
   * room at all, so it opens with one read and records nothing when no room was
   * holding the id. A rekey nobody in a room cares about costs a lookup.
   *
   * @param oldSessionId - The id the projector was registered under.
   * @param newSessionId - The canonical id it moved to.
   * @returns The bindings that moved, for the caller to log.
   */
  rebindBySessionId(oldSessionId: string, newSessionId: string): RoomSessionBinding[] {
    if (oldSessionId === newSessionId) return [];
    const held = this.db
      .select(BINDING_COLUMNS)
      .from(roomSessions)
      .where(eq(roomSessions.sessionId, oldSessionId))
      .all();
    if (held.length === 0) return [];
    this.retire(oldSessionId, newSessionId);
    this.db
      .update(roomSessions)
      .set({ sessionId: newSessionId })
      .where(eq(roomSessions.sessionId, oldSessionId))
      .run();
    return held.map((row) => ({ ...row, sessionId: newSessionId }));
  }

  /**
   * Record that `retiredId` has been renamed to `canonicalId`, so nothing writes
   * a room's memory back onto it.
   *
   * The projector registry is the authority on which ids are dead — an id it has
   * re-keyed away from can never gain a transcript — so this is only ever called
   * from a real rekey, never inferred from a binding merely moving. Inferring it
   * would forbid legitimate moves; this forbids exactly the reversal that was
   * observed.
   *
   * **Written down, so the refusal exists from the first request after a
   * restart** (DOR-1205). It used to be a map in this process's memory, which
   * meant a rename this process had not personally watched left the reversal
   * unguarded and left the boot repair sweep with nothing to repair from.
   *
   * The prune rides the write — a rename is rare and a scan of a small,
   * indexed table is cheaper than anything that would have to remember to run.
   *
   * @param retiredId - The id the projector left behind.
   * @param canonicalId - What replaced it.
   */
  retire(retiredId: string, canonicalId: string): void {
    if (retiredId === canonicalId) return;
    const at = this.now();
    this.db
      .insert(roomSessionRetirements)
      .values({ retiredSessionId: retiredId, canonicalSessionId: canonicalId, retiredAt: at })
      // A second rename of the same id replaces the first: the newest answer is
      // the only true one, and refreshing `retired_at` keeps an id that is still
      // being mentioned away from the horizon.
      .onConflictDoUpdate({
        target: roomSessionRetirements.retiredSessionId,
        set: { canonicalSessionId: canonicalId, retiredAt: at },
      })
      .run();
    this.db
      .delete(roomSessionRetirements)
      .where(lt(roomSessionRetirements.retiredAt, at - RETIREMENT_HORIZON_MS))
      .run();
  }

  /**
   * What replaced a retired session id, or `undefined` when nothing has recorded
   * it as renamed.
   *
   * Follows the chain to its end: `A → B → C` answers `C` for both `A` and `B`,
   * because the callers are both about to WRITE the answer — the store refuses a
   * rebind onto a retired id, and the repair sweep moves a stranded binding onto
   * the successor — and handing either of them a middle id would put a room back
   * on a session with no transcript.
   *
   * `undefined` is "not known", never "not retired". A rename that happened
   * before this table existed, or older than the horizon above, has no successor
   * here and the repair sweep says so out loud rather than guessing.
   *
   * **A read that fails answers "not known" too.** It is the pre-DOR-784
   * behaviour — a rebind that may be wrong — and it is the better of the two
   * available answers, because the alternative is throwing on the write path of
   * a turn that would otherwise have finished, out of a function the boot sweep
   * documents as never throwing.
   *
   * @param sessionId - The id to ask about.
   */
  successorFor(sessionId: string): string | undefined {
    const seen = new Set<string>([sessionId]);
    let current = sessionId;
    let successor: string | undefined;
    for (let hop = 0; hop < SUCCESSOR_CHASE_LIMIT; hop += 1) {
      let row;
      try {
        row = this.db
          .select({ canonicalSessionId: roomSessionRetirements.canonicalSessionId })
          .from(roomSessionRetirements)
          .where(eq(roomSessionRetirements.retiredSessionId, current))
          .get();
      } catch (err) {
        logger.warn('[rooms] could not read which session ids are retired', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
      if (row === undefined) break;
      const next = row.canonicalSessionId;
      // Stop BEFORE adopting an id already on the path. A tangled table must
      // never make this answer with the id it was asked about: a caller would
      // "repair" a binding onto the same dead session and count it as fixed.
      if (seen.has(next)) break;
      successor = next;
      seen.add(next);
      current = next;
    }
    return successor;
  }
}
