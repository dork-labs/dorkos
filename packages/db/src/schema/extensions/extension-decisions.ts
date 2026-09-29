import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, uniqueIndex, check } from 'drizzle-orm/sqlite-core';

/**
 * Who settled a decision (spec `flow-multiproject` §7.9). Mirrors
 * `DECISION_RESOLVED_BY` in `@dorkos/shared/notification-schemas`; kept as a
 * literal list here because this package does not depend on that one.
 */
export const EXTENSION_DECISION_RESOLVERS = [
  'person',
  'deadline',
  'agent',
  'rule',
  'extension',
] as const;

/** Who settled a decision. See {@link EXTENSION_DECISION_RESOLVERS}. */
export type ExtensionDecisionResolver = (typeof EXTENSION_DECISION_RESOLVERS)[number];

/**
 * What became of a question's deadline: the extension kept the row open at
 * it, said it was already settled, or could not be reached after its retries
 * (the row then says it needs a person); or a person answered first, which
 * cancels the deadline for good whatever the extension did with the answer.
 */
export const EXTENSION_DECISION_DEADLINE_STATES = [
  'kept_open',
  'settled',
  'failed',
  'answered',
] as const;

/** What became of a question's deadline. See {@link EXTENSION_DECISION_DEADLINE_STATES}. */
export type ExtensionDecisionDeadlineState = (typeof EXTENSION_DECISION_DEADLINE_STATES)[number];

/** A SQL `IN (...)` list of string literals, raw so drizzle-kit writes no bind markers. */
function inList(values: readonly string[]) {
  return sql.raw(values.map((v) => `'${v}'`).join(', '));
}

/**
 * Every decision an extension raised in the inbox (spec `flow-multiproject`
 * §7.2, N2).
 *
 * **The live row is the decision.** An open row (`resolved_at IS NULL`) is
 * what "Needs you" draws; the `notifications` table gets one history row when
 * it resolves. The partial unique index on `(extension_id, key)` among open
 * rows is the dedupe: raising an open key updates it in place, and a flapping
 * condition can never make a second row.
 *
 * `extension_id` and `key` are stored apart so one extension can never read,
 * resolve or answer another's decision (invariant 4). A history-only row from
 * `ctx.inbox.record` is born resolved with `recorded = 1` and is never an ask.
 * Resolved rows older than 30 days are pruned.
 */
export const extensionDecisions = sqliteTable(
  'extension_decisions',
  {
    /** ULID. */
    id: text('id').primaryKey(),
    /** The extension that raised it. */
    extensionId: text('extension_id').notNull(),
    /** Its manifest name when raised, for the source line and the push. */
    extensionName: text('extension_name').notNull(),
    /** The extension's own key. */
    key: text('key').notNull(),
    /** The project root it belongs to, or null. */
    projectRoot: text('project_root'),
    /** The project heading's muted label ("Linear DOR"), or null. */
    projectLabel: text('project_label'),
    /** A question or an outcome, ≤ 120. */
    title: text('title').notNull(),
    /** The required second line, ≤ 300. */
    why: text('why').notNull(),
    /** Shown behind ⓘ, ≤ 500, or null. */
    detail: text('detail'),
    /**
     * `DecisionActions` as JSON, exactly as the extension asked (a question's
     * `decideBy` as requested, before clamping). Comparing it is how a
     * re-raise of the same question is told from a new one.
     */
    actionsJson: text('actions_json').notNull(),
    /** In-app path the title opens, or null. */
    link: text('link'),
    /** When the condition began, or null. */
    since: text('since'),
    /** A question's deadline in effect: clamped once, when the question was first asked. */
    decideBy: text('decide_by'),
    /** A question's agent's pick, or null. */
    defaultChoice: text('default_choice'),
    /** What became of the deadline, or null while it has not passed. */
    deadlineState: text('deadline_state').$type<ExtensionDecisionDeadlineState>(),
    /** How many times the deadline call failed. */
    deadlineAttempts: integer('deadline_attempts').notNull().default(0),
    /** ISO time first raised. */
    raisedAt: text('raised_at').notNull(),
    /** ISO time last raised or changed. */
    updatedAt: text('updated_at').notNull(),
    /** ISO time it resolved, or null while open. */
    resolvedAt: text('resolved_at'),
    /** How it ended. */
    outcome: text('outcome'),
    /** The "Needs changes" note or the typed answer, ≤ 2000. */
    note: text('note'),
    /** The chosen choice, for a question. */
    choiceId: text('choice_id'),
    /** What was chosen, in words, for the history row. */
    choiceLabel: text('choice_label'),
    /** Who settled it. */
    resolvedBy: text('resolved_by').$type<ExtensionDecisionResolver>(),
    /** Who, in words, for `agent`, `rule` and `extension` (≤ 60). */
    resolvedByLabel: text('resolved_by_label'),
    /** The one-time follow-up offer as JSON, for the person who answered. */
    offerJson: text('offer_json'),
    /** When the offer was answered or dismissed. */
    offerUsedAt: text('offer_used_at'),
    /** A chat the extension started about it, as JSON. */
    watchJson: text('watch_json'),
    /**
     * A person's answer the extension kept open, as JSON: its id (the
     * `pendingActionId`), the action and what they typed. A later
     * `resolve(key, { answering })` with that id credits the person.
     */
    pendingActionJson: text('pending_action_json'),
    /**
     * Bumped whenever a re-raise changes what the person is asked (title,
     * why, detail, actions or link). An answer names the revision it saw, and
     * one for an older revision is refused as stale.
     */
    revision: integer('revision').notNull().default(0),
    /** 1 for a history-only row from `ctx.inbox.record`. */
    recorded: integer('recorded').notNull().default(0),
  },
  (table) => [
    uniqueIndex('extension_decisions_open_key_unique')
      .on(table.extensionId, table.key)
      .where(sql`"resolved_at" is null`),
    index('extension_decisions_resolved_raised_idx').on(table.resolvedAt, table.raisedAt),
    check(
      'extension_decisions_resolved_by',
      sql`${table.resolvedBy} IS NULL OR ${table.resolvedBy} IN (${inList(EXTENSION_DECISION_RESOLVERS)})`
    ),
    check(
      'extension_decisions_deadline_state',
      sql`${table.deadlineState} IS NULL OR ${table.deadlineState} IN (${inList(EXTENSION_DECISION_DEADLINE_STATES)})`
    ),
  ]
);

/** A stored `extension_decisions` row. */
export type ExtensionDecisionRow = typeof extensionDecisions.$inferSelect;
