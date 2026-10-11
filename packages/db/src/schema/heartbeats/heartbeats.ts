import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * One row per agent: the facts behind its next beat (spec `heartbeats` §11).
 *
 * Timers live in memory; these facts live here, so a restart neither skips a
 * beat for long nor fires a burst.
 */
export const heartbeatState = sqliteTable('heartbeat_state', {
  /** The agent's Mesh id. */
  agentId: text('agent_id').primaryKey(),
  /** When its last beat started (ISO 8601), or NULL before its first. */
  lastBeatAt: text('last_beat_at'),
  /** When a beat last found any change (ISO 8601), or NULL. */
  lastChangeAt: text('last_change_at'),
  /**
   * The start of the last beat whose changes were dealt with (it ended quiet,
   * worked, or with a turn that saw them), or NULL. The next beat gathers from
   * here, so a beat that was refused, busy or failed loses nothing.
   */
  gatheredThrough: text('gathered_through'),
  /**
   * The last beat's change keys with their signal (`key|signal`), as a JSON
   * array: a standing condition counts as work only the first time it appears.
   */
  lastChangeKeys: text('last_change_keys'),
  /** An asked-for faster pace, `{ everyMinutes, untilIso, why }` as JSON, or NULL. */
  pace: text('pace'),
  /** 1 when a wake landed during a beat and another is owed when it ends. */
  wakeAgain: integer('wake_again').notNull().default(0),
  /** Beat turns that failed in a row; reset by the first that succeeds. */
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  /** Today's beat chat, or NULL before the first turn of the day. */
  beatChatId: text('beat_chat_id'),
  /** The local date (`YYYY-MM-DD`, the chain person's zone) of `beat_chat_id`. */
  beatChatDate: text('beat_chat_date'),
  /** Hash of the last HEARTBEAT.md frontmatter seen, valid or not. */
  frontmatterHash: text('frontmatter_hash'),
  /** The last valid frontmatter, as JSON, kept in force while the file is invalid. */
  lastValidFrontmatter: text('last_valid_frontmatter'),
  /** When its last report went out (ISO 8601), or NULL. */
  lastReportAt: text('last_report_at'),
  /** 1 when its manager changed and its next beat opens with how it reports. */
  newManager: integer('new_manager').notNull().default(0),
});

/** A row of {@link heartbeatState}. */
export type HeartbeatStateRow = typeof heartbeatState.$inferSelect;

/**
 * One row per beat, quiet ones included: the store the measures read
 * (spec `heartbeats` §11, §13). Pruned after 90 days; the audit row for each
 * beat stays forever.
 */
export const heartbeatBeats = sqliteTable(
  'heartbeat_beats',
  {
    /** ULID. */
    id: text('id').primaryKey(),
    /** The agent's Mesh id. */
    agentId: text('agent_id').notNull(),
    /** When the beat started (ISO 8601). */
    startedAt: text('started_at').notNull(),
    /** When it ended (ISO 8601), or NULL while it runs. A restart finds it open. */
    endedAt: text('ended_at'),
    /** `pulse`, `sweep` or `report`. */
    kind: text('kind', { enum: ['pulse', 'sweep', 'report'] }).notNull(),
    /** What woke it: `timer`, `startup` or `event:<type>`. */
    wake: text('wake').notNull(),
    /** Changes found, counted by gatherer, as JSON. */
    changes: text('changes'),
    /** The triage verdict as JSON: rung, model id, verdict, confidence, usage. */
    triage: text('triage'),
    /** The beat chat when a turn ran, or NULL. */
    turnSessionId: text('turn_session_id'),
    /** The turn's usage as the runtime reported it, as JSON, or NULL. */
    turnUsage: text('turn_usage'),
    /** How it ended; NULL while it runs. */
    outcome: text('outcome', {
      enum: ['quiet', 'queued', 'worked', 'no-end-beat', 'failed', 'refused', 'skipped'],
    }),
    /** How many raises it handed over. */
    raises: integer('raises').notNull().default(0),
    /** Direct room posts and notes from its turn that skipped `end_beat`. */
    bypass: integer('bypass').notNull().default(0),
    /** The record line, as the audit row carries it. */
    summary: text('summary'),
    /** The `heartbeat.beat` audit row's seq, once written. */
    auditSeq: integer('audit_seq'),
  },
  (table) => [
    index('heartbeat_beats_agent_started_idx').on(table.agentId, table.startedAt),
    check('heartbeat_beats_kind', sql`${table.kind} IN ('pulse', 'sweep', 'report')`),
  ]
);

/** A row of {@link heartbeatBeats}. */
export type HeartbeatBeatRow = typeof heartbeatBeats.$inferSelect;

/**
 * What a beat raised, until it reaches its reader (spec `heartbeats` §9).
 * Held rows survive a restart because they are rows.
 */
export const heartbeatOutbox = sqliteTable(
  'heartbeat_outbox',
  {
    /** ULID. */
    id: text('id').primaryKey(),
    /** The agent that raised it. */
    agentId: text('agent_id').notNull(),
    /** The beat it came from. */
    beatId: text('beat_id').notNull(),
    /** Who it is for: a person's account id or an agent's Mesh id. */
    toAccount: text('to_account').notNull(),
    /** `report`, `room`, `dm` or `note`. */
    rung: text('rung', { enum: ['report', 'room', 'dm', 'note'] }).notNull(),
    /** The words, markdown. */
    text: text('text').notNull(),
    /** Stable id of the raise, for raise-once. */
    key: text('key').notNull(),
    /** The gathered change keys it is about, as a JSON array. */
    about: text('about'),
    /** 1 when a person must act now (P6). */
    urgent: integer('urgent').notNull().default(0),
    /** The room a `room` raise goes to, or NULL. */
    roomId: text('room_id'),
    /** Not before this moment (ISO 8601). */
    deliverAfter: text('deliver_after').notNull(),
    /** Where it stands. */
    state: text('state', { enum: ['held', 'delivered', 'dropped', 'resolved'] }).notNull(),
    /** Failed delivery attempts so far; it is dropped after five. */
    attempts: integer('attempts').notNull().default(0),
    /** The room entry it landed as, once delivered. */
    deliveredEntryId: text('delivered_entry_id'),
    /** When it was raised (ISO 8601). */
    createdAt: text('created_at').notNull(),
    /** When it left `held` (ISO 8601), or NULL. */
    closedAt: text('closed_at'),
  },
  (table) => [
    index('heartbeat_outbox_due_idx').on(table.toAccount, table.state, table.deliverAfter),
    index('heartbeat_outbox_key_idx').on(table.key),
    check('heartbeat_outbox_rung', sql`${table.rung} IN ('report', 'room', 'dm', 'note')`),
    check(
      'heartbeat_outbox_state',
      sql`${table.state} IN ('held', 'delivered', 'dropped', 'resolved')`
    ),
  ]
);

/** A row of {@link heartbeatOutbox}. */
export type HeartbeatOutboxRow = typeof heartbeatOutbox.$inferSelect;
