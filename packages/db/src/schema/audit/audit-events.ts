import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * The audit log: one row per action anyone took on this server, person, agent or
 * DorkOS itself (spec `audit-trail` §3.1).
 *
 * **Append-only, enforced by SQLite.** The migration that creates this table also
 * creates `BEFORE UPDATE` and `BEFORE DELETE` triggers that abort, copying the
 * connector usage ledger. A third, `BEFORE INSERT`, refuses any row whose `seq`
 * is not exactly one past the last row, or whose `prev_hash` is not the last
 * row's `hash`, so even a writer bug cannot gap or fork the chain through the
 * app. SQLite cannot compute SHA-256, so whether each `hash` is RIGHT is checked
 * by walking the chain (`AuditLog.verify`), not by the trigger.
 *
 * A trigger stops the app, not somebody holding `sqlite3` and the file. The
 * chain is what makes such an edit detectable afterwards.
 *
 * The JSON columns hold the structured parts of an event; the columns a query
 * filters on (actor, target, action, session) are flattened so they can be
 * indexed.
 */
export const auditEvents = sqliteTable(
  'audit_events',
  {
    /** Gap-free, monotonic position in the chain. The first row is 1. */
    seq: integer('seq').primaryKey(),
    /** ULID, for links from elsewhere. */
    id: text('id').notNull().unique(),
    /** When the action happened. ISO 8601 UTC. */
    at: text('at').notNull(),
    /** The space this happened in; NULL is this server's own one-person space. */
    spaceId: text('space_id'),
    /** Stable account id of who acted: an agent's mesh ULID, a person's account id. Never a path. */
    actorId: text('actor_id').notNull(),
    /** What kind of account acted. */
    actorKind: text('actor_kind', {
      enum: ['person', 'agent', 'system', 'external'],
    }).notNull(),
    /** The actor's name as it was at the time. */
    actorName: text('actor_name').notNull(),
    /** JSON `[{accountId, via}]`: who the actor was acting for. */
    onBehalfOf: text('on_behalf_of'),
    /** JSON `{kind, idHash}`: which credential acted, hashed. Never the credential. */
    credential: text('credential'),
    /** JSON `{surface, runtime?, sessionId?, turnId?, taskRunId?, toolCallId?}`. */
    source: text('source').notNull(),
    /** The session this happened in, copied out of `source` so it can be indexed. */
    sessionId: text('session_id'),
    /** `domain.verb`, e.g. `config.changed`. */
    action: text('action').notNull(),
    /** The broad kind of operation. */
    operation: text('operation', {
      enum: ['create', 'modify', 'remove', 'access', 'execute', 'auth'],
    }).notNull(),
    /** What was acted on: its type, id, name at the time, and its container. */
    targetType: text('target_type'),
    targetId: text('target_id'),
    targetName: text('target_name'),
    containerId: text('container_id'),
    /** How it came out. */
    outcome: text('outcome', { enum: ['ok', 'failed', 'refused'] }).notNull(),
    /** A short error, secret-redacted. */
    error: text('error'),
    /** JSON `[{field, before?, after?, redacted?}]`. */
    change: text('change'),
    /** Why, when the actor said. */
    reason: text('reason'),
    /** JSON `{activityId?, approvalId?, traceId?, causedBy?, connectorAttemptId?}`. */
    links: text('links'),
    /** One plain line for the app. */
    summary: text('summary').notNull(),
    /** Who may read this row. */
    visibility: text('visibility', { enum: ['space', 'participants', 'admins'] }).notNull(),
    /** JSON array of account ids, for `visibility = 'participants'`. */
    participants: text('participants'),
    /** The previous row's `hash`; 64 zeros for the first row. */
    prevHash: text('prev_hash').notNull(),
    /** sha256(prev_hash + canonical JSON of this row without `hash`), lowercase hex. */
    hash: text('hash').notNull(),
  },
  (table) => [
    index('audit_events_actor_seq_idx').on(table.actorId, table.seq),
    index('audit_events_target_seq_idx').on(table.targetId, table.seq),
    index('audit_events_action_seq_idx').on(table.action, table.seq),
    index('audit_events_session_seq_idx').on(table.sessionId, table.seq),
    index('audit_events_at_idx').on(table.at),
    check(
      'audit_events_actor_kind',
      sql`${table.actorKind} IN ('person', 'agent', 'system', 'external')`
    ),
    check(
      'audit_events_operation',
      sql`${table.operation} IN ('create', 'modify', 'remove', 'access', 'execute', 'auth')`
    ),
    check('audit_events_outcome', sql`${table.outcome} IN ('ok', 'failed', 'refused')`),
    check(
      'audit_events_visibility',
      sql`${table.visibility} IN ('space', 'participants', 'admins')`
    ),
    check(
      'audit_events_participants_required',
      sql`${table.visibility} <> 'participants' OR ${table.participants} IS NOT NULL`
    ),
  ]
);
