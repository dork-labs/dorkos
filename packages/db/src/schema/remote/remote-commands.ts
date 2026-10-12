import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** The command kinds a journal row can hold: every leased kind, never `keepalive`. */
export const REMOTE_COMMAND_JOURNAL_VERBS = [
  'open',
  'close',
  'rotate',
  'revoke',
  'inbox_pending',
] as const;

/** Where a journaled command's acknowledgement stands. */
export const REMOTE_COMMAND_ACK_STATES = ['pending', 'acked', 'rejected', 'unconfirmed'] as const;

/**
 * Every leased command this computer read from DorkOS Cloud's managed remote
 * access command stream (DOR-2086), written BEFORE the command is acted on.
 *
 * It is what makes a command happen at most once and be acknowledged at least
 * once: a command id seen again (a redelivery after a lost acknowledgement, a
 * restart, a reconnect) is answered from its row with the outcome recorded the
 * first time, never by repeating the effect. A row whose `outcome` is still
 * NULL after a restart was interrupted mid-effect, and settles as `failed`.
 *
 * It never holds a Cloud bearer, a tunnel credential value or an edge proof
 * secret. The lease token is the one opaque value kept, because an
 * acknowledgement has to present it; it authorizes nothing on this computer.
 * Bounded: settled rows are pruned by age and count.
 */
export const remoteCommandJournal = sqliteTable(
  'remote_command_journal',
  {
    /** Cloud's command id. One row per command, across every redelivery. */
    commandId: text('command_id').primaryKey(),
    /** The latest lease token the command arrived with; a redelivery replaces it. */
    leaseToken: text('lease_token').notNull(),
    /** The command kind. */
    verb: text('verb', { enum: REMOTE_COMMAND_JOURNAL_VERBS }).notNull(),
    /** The Cloud instance id of the link the command arrived on. Acks go only under that link. */
    instanceId: text('instance_id').notNull(),
    /**
     * What this computer did: `applied`, `ignored`, `failed` or `refused:<slug>`,
     * or NULL while the effect is still running.
     */
    outcome: text('outcome'),
    /** Where the acknowledgement stands. `unconfirmed`: Cloud settled nothing for the lease. */
    ackState: text('ack_state', { enum: REMOTE_COMMAND_ACK_STATES }).notNull().default('pending'),
    /** How many acknowledgements were sent for it. */
    ackAttempts: integer('ack_attempts').notNull().default(0),
    /** When it was first read (ISO 8601). */
    receivedAt: text('received_at').notNull(),
    /** When its outcome was recorded (ISO 8601), or NULL while running. */
    settledAt: text('settled_at'),
    /** When Cloud accepted the acknowledgement, or refused it (ISO 8601). */
    ackedAt: text('acked_at'),
  },
  (table) => [
    index('remote_command_journal_ack_idx').on(table.ackState, table.receivedAt),
    check(
      'remote_command_journal_verb',
      sql`${table.verb} IN ('open', 'close', 'rotate', 'revoke', 'inbox_pending')`
    ),
    check(
      'remote_command_journal_ack_state',
      sql`${table.ackState} IN ('pending', 'acked', 'rejected', 'unconfirmed')`
    ),
  ]
);

/** A row of {@link remoteCommandJournal}. */
export type RemoteCommandJournalRow = typeof remoteCommandJournal.$inferSelect;

/** An insertable row of {@link remoteCommandJournal}. */
export type NewRemoteCommandJournalRow = typeof remoteCommandJournal.$inferInsert;

/**
 * Activity batches waiting to be reported to DorkOS Cloud for managed remote
 * access (DOR-2086), each persisted with its `Idempotency-Key` BEFORE it is
 * sent, so a retry after a timeout, a lost answer or a restart presents the
 * same key, and only a changed batch gets a new one.
 *
 * `batch` is the JSON body exactly as it will be sent: activity windows and
 * counts, never a bearer, a credential value or a secret.
 */
export const remoteEventOutbox = sqliteTable(
  'remote_event_outbox',
  {
    /** Local id of the batch. */
    id: text('id').primaryKey(),
    /** The `Idempotency-Key` header value chosen for this batch; unique. */
    idempotencyKey: text('idempotency_key').notNull().unique(),
    /** The Cloud instance id of the link the batch belongs to. */
    instanceId: text('instance_id').notNull(),
    /** The request body, as JSON. */
    batch: text('batch').notNull(),
    /** How many times it was sent. */
    attempts: integer('attempts').notNull().default(0),
    /**
     * How many of those sends Cloud refused outright. Kept apart from
     * `attempts`, so outages and timeouts never count toward giving up on it.
     */
    refusals: integer('refusals').notNull().default(0),
    /** When it was written (ISO 8601). */
    createdAt: text('created_at').notNull(),
    /** When it was last sent (ISO 8601), or NULL when never. */
    lastAttemptAt: text('last_attempt_at'),
  },
  (table) => [index('remote_event_outbox_created_idx').on(table.createdAt)]
);

/** A row of {@link remoteEventOutbox}. */
export type RemoteEventOutboxRow = typeof remoteEventOutbox.$inferSelect;
