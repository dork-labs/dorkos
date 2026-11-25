import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Every kind of follow-up work the outbox carries (spec `turns-survive-restarts`
 * §6.2). The whole list is in the CHECK below, though only `notify_person` has
 * a handler yet (T4): SQLite cannot widen a CHECK without rebuilding the table,
 * and each later step (T5, T9, T10, T15) adds a handler, not a migration.
 */
export const TURN_EFFECT_KINDS = [
  'start_turn',
  'deliver_room_handoff',
  'report_to_parent',
  'post_room_outcome',
  'wake_chat',
  'continue_after_restart',
  'lost_work_wake',
  'notify_person',
] as const;

/**
 * How safe an effect is to run twice (§6.2): `repeatable` work is safe to repeat
 * by its key, so an attempt that died is run again; a `once` attempt that died
 * is `unknown`, and never run again (§6.2, rule 2).
 */
export const TURN_EFFECT_DELIVERIES = ['repeatable', 'once'] as const;

/** An effect's states (§6.1). Every state but `pending` and `leased` is terminal. */
export const TURN_EFFECT_STATES = [
  'pending',
  'leased',
  'done',
  'dropped',
  'unknown',
  'expired',
] as const;

/** The states an effect never leaves. */
export const TERMINAL_TURN_EFFECT_STATES = ['done', 'dropped', 'unknown', 'expired'] as const;

/** `'a', 'b', ...` for a CHECK over one of the word lists above. Source-owned literals only. */
const words = (list: readonly string[]) => sql.raw(list.map((word) => `'${word}'`).join(', '));

/**
 * The outbox (spec `turns-survive-restarts` §6, DOR-5160): follow-up work a
 * run's state change causes, saved in the same transaction as that change and
 * carried out by one leased worker per process (`services/runs/effects/`).
 *
 * It holds no words. A person's or an agent's words stay in their own store
 * (a queue row, a room entry, an outbox row); `payload_json` carries
 * references and fixed DorkOS copy only.
 *
 * **Leases.** A worker takes an effect by moving it from `pending` to `leased`
 * in one conditional update, naming its boot epoch in `lease_owner` and
 * renewing `lease_until` while it works. A lease another boot held and let run
 * out is reclaimed: `repeatable` back to `pending`, `once` to `unknown`.
 *
 * **Deadlines.** Every follow-up has a `not_after` (the CHECK below holds it):
 * past it, the effect is `expired`, so the run it follows always reaches
 * `settled`. Only `start_turn` may wait without one, bounded by the run ahead.
 *
 * Only `apps/server/src/services/runs/effects/effect-store.ts` writes this
 * table; the run store reads it for one question, which `ended` runs have no
 * open effect left and may settle. Lives in this computer's store for now, beside `turn_runs`; both
 * move to the space store with child issue Q of the spec.
 */
export const turnEffects = sqliteTable(
  'turn_effects',
  {
    /** A ULID, monotonic within a process, so a run's effects sort in the order written. */
    id: text('id').primaryKey(),
    /** One of {@link TURN_EFFECT_KINDS}. */
    kind: text('kind', { enum: TURN_EFFECT_KINDS }).notNull(),
    /** What makes two writes the same effect: a second insert of a key is ignored. */
    key: text('key').notNull(),
    /** The run it follows, when it follows one. */
    runId: text('run_id'),
    /** The chat it is ordered behind, when it has one. */
    sessionId: text('session_id'),
    /** JSON: references and fixed DorkOS copy only, never a person's or agent's words. */
    payloadJson: text('payload_json').notNull(),
    /** One of {@link TURN_EFFECT_DELIVERIES}. */
    delivery: text('delivery', { enum: TURN_EFFECT_DELIVERIES }).notNull(),
    /** One of {@link TURN_EFFECT_STATES}. */
    state: text('state', { enum: TURN_EFFECT_STATES }).notNull().default('pending'),
    /** Epoch ms; not before. A retry's backoff moves it on. */
    availableAt: integer('available_at').notNull(),
    /** Epoch ms; past it the effect is `expired`. Required on every kind but `start_turn`. */
    notAfter: integer('not_after'),
    /** The boot epoch holding the lease, while `leased`; the last holder after. */
    leaseOwner: text('lease_owner'),
    /** Epoch ms; the lease ends here unless renewed. */
    leaseUntil: integer('lease_until'),
    /** How many times a worker has taken it. */
    attempts: integer('attempts').notNull().default(0),
    /** JSON: what the last attempt answered, or why the effect ended as it did. */
    outcome: text('outcome'),
    createdAt: text('created_at').notNull(),
    /** When it reached a terminal state. */
    settledAt: text('settled_at'),
  },
  (t) => [
    uniqueIndex('turn_effects_key_unique').on(t.key),
    // The worker's one hot read: the next pending effect that is due.
    index('turn_effects_due_idx').on(t.state, t.availableAt),
    // A run's open effects, read when one finishes to decide whether it settles.
    index('turn_effects_run_idx')
      .on(t.runId, t.state)
      .where(sql`"run_id" IS NOT NULL`),
    check('turn_effects_kind', sql`${t.kind} IN (${words(TURN_EFFECT_KINDS)})`),
    check('turn_effects_delivery', sql`${t.delivery} IN (${words(TURN_EFFECT_DELIVERIES)})`),
    check('turn_effects_state', sql`${t.state} IN (${words(TURN_EFFECT_STATES)})`),
    check(
      'turn_effects_follow_up_deadline',
      sql`${t.kind} = 'start_turn' OR ${t.notAfter} IS NOT NULL`
    ),
    check(
      'turn_effects_lease',
      sql`${t.state} <> 'leased' OR (${t.leaseOwner} IS NOT NULL AND ${t.leaseUntil} IS NOT NULL)`
    ),
    check('turn_effects_attempts', sql`${t.attempts} >= 0`),
  ]
);

/** A row of {@link turnEffects}. */
export type TurnEffectRow = typeof turnEffects.$inferSelect;
/** An insert into {@link turnEffects}. */
export type NewTurnEffectRow = typeof turnEffects.$inferInsert;
