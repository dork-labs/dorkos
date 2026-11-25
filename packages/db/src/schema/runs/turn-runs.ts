import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * A run's statuses (spec `turns-survive-restarts` §4.3). The same words as
 * `RunStatusSchema` in `@dorkos/shared/turn-port`, which this package cannot
 * import; the server's run-store test pins the two lists together.
 */
export const TURN_RUN_STATUSES = [
  'queued',
  'starting',
  'started',
  'running',
  'ended',
  'settled',
  'cancelled',
  'superseded',
] as const;

/** The statuses that make a run its chat's live run: at most one per chat (§5). */
export const LIVE_TURN_RUN_STATUSES = ['starting', 'started', 'running'] as const;

/** How a run ended, as observed (§4.4). Mirrors `RunEndingSchema`. */
export const TURN_RUN_ENDINGS = [
  'completed',
  'failed',
  'stopped',
  'limited',
  'refused',
  'shutdown',
  'process_died',
] as const;

/** Why a queued run waits (§4.1). Mirrors `WaitReasonSchema`. */
export const TURN_RUN_WAIT_REASONS = [
  'chat_busy',
  'agent_busy',
  'machine_full',
  'paused',
  'held_after_restart',
] as const;

/** Who opened a run (§4.1). */
export const TURN_RUN_OPENERS = ['caller', 'runtime', 'recovery'] as const;

/** Why a run exists (§4.1). Mirrors `AttemptReasonSchema`. */
export const TURN_RUN_ATTEMPT_REASONS = ['initial', 'restart'] as const;

/** `'a', 'b', ...` for a CHECK over one of the word lists above. Source-owned literals only. */
const words = (list: readonly string[]) => sql.raw(list.map((word) => `'${word}'`).join(', '));

/**
 * The run record (spec `turns-survive-restarts` §4, DOR-5159): one row per
 * attempt of a turn, so every device can read what became of it, including
 * after the process that ran it is gone.
 *
 * It holds no words of the turn. Words wait in `session_message_queue` (a run
 * points at its row by `queue_message_id`) or at their source (`source_ref`),
 * and the live-turn state stays with the dispatcher and the turn binding; the
 * run points at them and never copies them (§4.5).
 *
 * Only `apps/server/src/services/runs/run-store.ts` reads or writes this table
 * (§4.2), and a test there fails on any other reference to it. Every status
 * change is checked against the transition table in `@dorkos/shared/turn-port`.
 *
 * **One live run per chat** is held here, by the partial unique index
 * `turn_runs_one_live_per_chat` over `status IN ('starting','started','running')`
 * (§5): a second live run in one chat is a constraint error, never a race.
 *
 * Times are ISO 8601 text, as the rest of the machine store; `lease_until` and
 * `not_after` are epoch ms because they are compared with the clock on every
 * read. Lives in this computer's store for now; its move to the space store is
 * child issue Q of the spec (ADR 261122-173853).
 */
export const turnRuns = sqliteTable(
  'turn_runs',
  {
    /** A ULID; referenced as `dork:turn:<id>`. */
    id: text('id').primaryKey(),
    /** The chat, by the id its queue rows are kept under; moved by a rekey. */
    sessionId: text('session_id').notNull(),
    /** Order within the chat, allocated in the transaction that creates the run. */
    chatSeq: integer('chat_seq').notNull(),
    /** The key that made this run, when a source minted one; makes creation safe to repeat. */
    startKey: text('start_key'),
    /** The first run of its chain; equal to `id` for a new turn. */
    chainId: text('chain_id').notNull(),
    /** Who asked, as a `dork:` reference. */
    askedByRef: text('asked_by_ref'),
    /** The agent's Mesh id, when known. */
    agentId: text('agent_id'),
    /**
     * The caller's `TurnOrigin`, JSON. NULL when the runtime opened the turn
     * itself, or for a queue row an earlier build accepted, whose caller nobody
     * recorded.
     */
    originJson: text('origin_json'),
    /** `caller`, `runtime` (a turn nobody asked for) or `recovery`. */
    openedBy: text('opened_by', { enum: TURN_RUN_OPENERS }).notNull(),
    /** One of {@link TURN_RUN_STATUSES}. */
    status: text('status', { enum: TURN_RUN_STATUSES }).notNull(),
    /** Why a `queued` run waits, when something holds it. */
    waitReason: text('wait_reason', { enum: TURN_RUN_WAIT_REASONS }),
    /** 1 for a new turn. */
    attempt: integer('attempt').notNull().default(1),
    /** `initial` or `restart`. */
    attemptReason: text('attempt_reason', { enum: TURN_RUN_ATTEMPT_REASONS })
      .notNull()
      .default('initial'),
    /** The attempt this one continues; one dead run has at most one continuation. */
    continuesRunId: text('continues_run_id'),
    /** The `session_message_queue` row holding the words, until they are delivered. */
    queueMessageId: text('queue_message_id'),
    /** Where the words are when they are not in the queue, by the source's own id. */
    sourceRef: text('source_ref'),
    /** The chat's runtime at `started`; first-write-wins (ADR-0255), so it never drifts. */
    runtime: text('runtime'),
    /** The `seq` of the turn's `turn_start` on the chat's stream. */
    runtimeTurnRef: integer('runtime_turn_ref'),
    /** `connector_runtime_bindings.id` while the turn is open. */
    turnBindingId: text('turn_binding_id'),
    /** The account the turn ran on. */
    accountRef: text('account_ref'),
    /** The playbook it started under; NULL until playbooks exist. */
    playbookId: text('playbook_id'),
    /** The boot epoch of the process running it. */
    ownerEpoch: text('owner_epoch'),
    /** Epoch ms; renewed while the owner lives. */
    leaseUntil: integer('lease_until'),
    /** Epoch ms; a waiting run is cancelled as expired past this. */
    notAfter: integer('not_after'),
    /** Set while the turn waits on a person's answer. */
    waitingOnPerson: integer('waiting_on_person', { mode: 'boolean' }).notNull().default(false),
    /** How it ended, as observed: recorded at `turn_end`, before the status moves (§4.7). */
    ending: text('ending', { enum: TURN_RUN_ENDINGS }),
    /**
     * JSON: each stop request and its receipt, a refusal's words, a door
     * refusal's reason, `delivery: unknown`, `outcome_unknown`. Never
     * transcript text.
     */
    endingDetail: text('ending_detail'),
    /** JSON: the background work that died with it. */
    lostBackgroundJson: text('lost_background_json'),
    /** Set in the transaction that decides what follows a dead run. */
    recoveryDecidedAt: text('recovery_decided_at'),
    createdAt: text('created_at').notNull(),
    startedAt: text('started_at'),
    deliveredAt: text('delivered_at'),
    endedAt: text('ended_at'),
    settledAt: text('settled_at'),
  },
  (t) => [
    uniqueIndex('turn_runs_chat_seq_unique').on(t.sessionId, t.chatSeq),
    uniqueIndex('turn_runs_start_key_unique')
      .on(t.startKey)
      .where(sql`"start_key" IS NOT NULL`),
    uniqueIndex('turn_runs_continues_unique')
      .on(t.continuesRunId)
      .where(sql`"continues_run_id" IS NOT NULL`),
    uniqueIndex('turn_runs_one_live_per_chat')
      .on(t.sessionId)
      .where(sql`"status" IN ('starting', 'started', 'running')`),
    index('turn_runs_queue_message_idx')
      .on(t.queueMessageId)
      .where(sql`"queue_message_id" IS NOT NULL`),
    index('turn_runs_lease_idx').on(t.status, t.leaseUntil),
    index('turn_runs_recovery_idx').on(t.ending, t.recoveryDecidedAt),
    check('turn_runs_status', sql`${t.status} IN (${words(TURN_RUN_STATUSES)})`),
    check('turn_runs_opened_by', sql`${t.openedBy} IN (${words(TURN_RUN_OPENERS)})`),
    check(
      'turn_runs_wait_reason',
      sql`${t.waitReason} IS NULL OR ${t.waitReason} IN (${words(TURN_RUN_WAIT_REASONS)})`
    ),
    check(
      'turn_runs_attempt_reason',
      sql`${t.attemptReason} IN (${words(TURN_RUN_ATTEMPT_REASONS)})`
    ),
    check(
      'turn_runs_ending',
      sql`${t.ending} IS NULL OR ${t.ending} IN (${words(TURN_RUN_ENDINGS)})`
    ),
    check('turn_runs_attempt', sql`${t.attempt} >= 1`),
  ]
);

/** A row of {@link turnRuns}. */
export type TurnRunRow = typeof turnRuns.$inferSelect;
/** An insert into {@link turnRuns}. */
export type NewTurnRunRow = typeof turnRuns.$inferInsert;
