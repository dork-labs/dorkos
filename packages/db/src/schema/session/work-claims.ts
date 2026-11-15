import { sql } from 'drizzle-orm';
import { check, index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Who is working on what, among one agent's own chats (DOR-4019).
 *
 * One row per live claim. The primary key is what makes a claim exclusive: two
 * chats of one agent racing for one key both insert, and exactly one row lands.
 * A released or expired claim is deleted; its history is the audit trail. A
 * claim is advisory: no permission, merge or launch decision outside the claim
 * tools themselves reads this table.
 */
export const workClaims = sqliteTable(
  'work_claims',
  {
    /** The Mesh id of the agent whose chats share this claim space. */
    agentId: text('agent_id').notNull(),
    /** The claimed work, normalised (trimmed, upper-cased), e.g. `DOR-1234` or `PR #42`. */
    claimKey: text('claim_key').notNull(),
    /** The chat that holds it. */
    sessionId: text('session_id').notNull(),
    /** What the holder said it is doing, or NULL. Untrusted text. */
    note: text('note'),
    /** When it was claimed (ISO 8601). */
    claimedAt: text('claimed_at').notNull(),
    /** When the holder was last seen working (ISO 8601); a claim lapses past the idle limit. */
    lastSeenAt: text('last_seen_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.claimKey] }),
    index('work_claims_session_idx').on(table.sessionId),
    check('work_claims_key_length', sql`length(${table.claimKey}) BETWEEN 1 AND 120`),
    check('work_claims_note_length', sql`${table.note} IS NULL OR length(${table.note}) <= 200`),
  ]
);

/** A row of {@link workClaims}. */
export type WorkClaimRow = typeof workClaims.$inferSelect;
