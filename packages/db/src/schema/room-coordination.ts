import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

/**
 * One automatic room turn that was actually spent, as a timestamp (DOR-1205).
 *
 * The durable half of `RoomTurnBudget`'s two rolling one-hour windows. Both
 * ceilings — per room, and across the whole install — used to live only in the
 * dispatcher's memory, so a restart inside a busy hour handed every room a fresh
 * allowance. This table is what makes the ceilings mean an hour of wall clock
 * rather than an hour of uptime.
 *
 * **A row per spend, not a bucket per hour.** The obvious cheaper shape is
 * `(room_id, hour) → count`, and it is wrong for what this bounds: a bucket
 * resets on a boundary, so two agents talking in circles at 10:59 get a clean
 * allowance at 11:00 no matter how much they just spent. The window has to roll
 * — "the last sixty minutes", continuously — and only the individual instants
 * can answer that. `turn-budget.test.ts` pins the difference ("rolls partially,
 * rather than resetting on a boundary").
 *
 * **The table stays tiny because it is pruned on every write.** Rows older than
 * the window are deleted as each new one lands, so what it holds is at most the
 * turns of the last hour — bounded by the global cap itself, which is what the
 * whole install is allowed to spend in that hour. There is no retention story
 * here and deliberately no history: this is a counter, not an audit log. The
 * activity log is where "what happened" lives.
 *
 * **No foreign key to `rooms`.** A spend is a fact about what the install has
 * already paid for, and deleting a room must not refund it — otherwise
 * `DELETE FROM rooms` becomes a way to clear the ceiling, which is the exact
 * move the global cap exists to bound (rooms are free; see `turn-budget.ts`).
 */
export const roomTurnSpend = sqliteTable(
  'room_turn_spend',
  {
    /** Row identity only. Nothing outside this table refers to it. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    /**
     * The room the turn ran in. Opaque here — see the no-foreign-key note above.
     */
    roomId: text('room_id').notNull(),
    /** When the turn was reserved, epoch ms — the instant the window rolls past. */
    at: integer('at').notNull(),
  },
  (table) => [
    // Every query over this table is "the last hour", in both directions: the
    // hydrating read (`at > floor`) and the prune (`at <= floor`). One index on
    // `at` serves both; `room_id` is never filtered on in SQL, because the
    // per-room split happens in memory once the hour is loaded.
    index('idx_room_turn_spend_at').on(table.at),
  ]
);

/**
 * A session id a runtime has renamed away from, and what replaced it
 * (DOR-784, made durable by DOR-1205).
 *
 * Claude Code names a session itself, mid-turn, and files the transcript under
 * ITS name — so the id a room bound before the first turn dies, and a write that
 * puts a room's memory back onto the dead one costs the agent its conversation.
 * `RoomStore.rebindRoomSession` refuses exactly that write, and this table is
 * how it knows which ids are dead.
 *
 * It used to be a 512-entry map in one process's memory, which meant the refusal
 * did not exist until this process had personally watched the rename: the first
 * request after a restart could still move a binding backwards, and the boot
 * repair sweep could only ever REPORT a stranded binding because the one thing
 * that knew the successor had just been thrown away. Both are the same
 * fix — write the retirement down.
 *
 * **Keyed by the retired id, because that is what a caller asks with.** Every
 * read here is "is this id dead, and what replaced it", from a caller holding
 * the id it is about to write. One primary-key lookup answers it.
 *
 * **Pruned by age, not by count.** A retirement matters for as long as some
 * binding might still be pointing at the dead id, which is not bounded by how
 * many renames happened since — it is bounded by how long a room can sit
 * untouched and still be woken up. `RoomSessionLedger` names the horizon and
 * says why.
 */
export const roomSessionRetirements = sqliteTable(
  'room_session_retirements',
  {
    /** The id the runtime left behind. Never written to a binding again. */
    retiredSessionId: text('retired_session_id').primaryKey(),
    /**
     * What replaced it. May itself be retired later, which is why the ledger
     * follows the chain to its end rather than trusting one hop.
     */
    canonicalSessionId: text('canonical_session_id').notNull(),
    /** When the rename was recorded, epoch ms — what the prune horizon reads. */
    retiredAt: integer('retired_at').notNull(),
  },
  (table) => [
    // The prune is the only scan; the lookups all ride the primary key.
    index('idx_room_session_retirements_at').on(table.retiredAt),
  ]
);
