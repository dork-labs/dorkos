/**
 * Which session id a room's memory should be pointing at, as ids move under it
 * (DOR-784).
 *
 * `RoomStore` next door owns the ordinary per-`(room, agent)` CRUD over
 * `room_sessions`: read the binding, write it once, move it when a turn reports.
 * This owns the harder question that appeared when those ids turned out not to
 * hold still — a room mints a placeholder before its first turn, and Claude Code
 * renames the session mid-turn — so two operations here are keyed by SESSION id
 * rather than by room, and one small piece of memory says which ids are dead.
 *
 * Split out rather than added to the store because it is a different subject
 * with a different key, and because a store that has grown a memory is no longer
 * a store. `RoomStore` holds one of these and consults it on the one write that
 * can go backwards.
 *
 * @module server/services/rooms/room-session-ledger
 */
import { roomSessions, eq, type Db } from '@dorkos/db';

/** One `(room, agent) → session` binding, as the convergence paths read it. */
export interface RoomSessionBinding {
  roomId: string;
  authorId: string;
  sessionId: string;
}

/**
 * How many retired session ids the ledger remembers before forgetting the
 * oldest.
 *
 * Bounded FIFO for the same reason the dispatcher's notice memories are: the map
 * only has to outlive the window in which a stale id could still be written
 * back, which is one turn. Losing the oldest costs nothing worse than the
 * pre-DOR-784 behaviour, for an id nobody has mentioned in five hundred rekeys.
 */
const RETIRED_ID_MEMORY = 512;

/** The columns every read here projects. */
const BINDING_COLUMNS = {
  roomId: roomSessions.roomId,
  authorId: roomSessions.authorId,
  sessionId: roomSessions.sessionId,
};

/** Session-id-keyed reads and writes over `room_sessions`, plus which ids are dead. */
export class RoomSessionLedger {
  /**
   * Session ids the projector has re-keyed AWAY from, mapped to what replaced
   * them.
   *
   * In memory rather than on disk, and that is honest rather than lazy: a rekey
   * is an event in one process's life, the successor is written into
   * `room_sessions` the moment it happens, and a restart that lost the map has
   * nothing left to protect — the binding is already canonical. What the map
   * buys is the window where it matters: the seconds between a runtime naming
   * its session and `runOne` returning the placeholder it was ASKED with, during
   * which the old code moved the binding back and forth
   * (00dfdce7→0e7270c6→00dfdce7, observed 2026-07-31).
   */
  private readonly retired = new Map<string, string>();

  constructor(private readonly db: Db) {}

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
   * @param retiredId - The id the projector left behind.
   * @param canonicalId - What replaced it.
   */
  retire(retiredId: string, canonicalId: string): void {
    if (retiredId === canonicalId) return;
    // Re-inserting refreshes FIFO position, so an id that keeps being mentioned
    // keeps being remembered.
    this.retired.delete(retiredId);
    this.retired.set(retiredId, canonicalId);
    if (this.retired.size > RETIRED_ID_MEMORY) {
      const oldest = this.retired.keys().next();
      if (!oldest.done) this.retired.delete(oldest.value);
    }
  }

  /**
   * What replaced a retired session id, or `undefined` when this ledger has
   * never seen it renamed.
   *
   * `undefined` is genuinely "not known", never "not retired": the map is
   * per-process, so a binding stranded before the last restart has no successor
   * here and the repair sweep says so out loud rather than guessing.
   *
   * @param sessionId - The id to ask about.
   */
  successorFor(sessionId: string): string | undefined {
    return this.retired.get(sessionId);
  }
}
