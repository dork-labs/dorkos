import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { communities, time, users } from '../schema.js';

// Mailed-link requests (0032, 0049), beside `../schema.ts`.

/**
 * A request for a mailed reset, sign-in or confirmation link (0032), recorded the same way for
 * every address and resolved later by the mail worker. The address is kept as a keyed hash; its
 * plain text only until the resolver reads it.
 */
export const emailLinkRequests = pgTable(
  'email_link_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    emailHash: text('email_hash').notNull(),
    email: text('email'),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    pendingLinkHash: text('pending_link_hash'),
    state: text('state').notNull(),
    outboxId: uuid('outbox_id'),
    createdAt: time('created_at'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    // The space an invitation's sign-up was for, so its mail can name it (0049).
    communityId: uuid('community_id').references(() => communities.id, { onDelete: 'cascade' }),
  },
  (table) => [
    check(
      'email_link_requests_kind_check',
      sql`${table.kind} IN ('password_reset','sign_in','email_confirmation','existing_account')`
    ),
    check('email_link_requests_email_hash_check', sql`${table.emailHash} ~ '^[a-f0-9]{64}$'`),
    check(
      'email_link_requests_email_check',
      sql`${table.email} IS NULL OR char_length(${table.email}) <= 320`
    ),
    check(
      'email_link_requests_pending_link_hash_check',
      sql`${table.pendingLinkHash} IS NULL OR ${table.pendingLinkHash} ~ '^[a-f0-9]{64}$'`
    ),
    check(
      'email_link_requests_state_check',
      sql`${table.state} IN ('pending','throttled','queued','dropped')`
    ),
    check(
      'email_link_requests_shape',
      sql`(${table.kind} = 'password_reset' AND ${table.userId} IS NULL AND ${table.pendingLinkHash} IS NULL) OR (${table.kind} = 'existing_account' AND ${table.userId} IS NULL AND ${table.pendingLinkHash} IS NULL AND ${table.communityId} IS NOT NULL) OR (${table.kind} = 'sign_in' AND ${table.userId} IS NOT NULL AND ${table.pendingLinkHash} IS NOT NULL AND ${table.email} IS NULL AND ${table.communityId} IS NULL) OR (${table.kind} = 'email_confirmation' AND ${table.userId} IS NOT NULL AND ${table.pendingLinkHash} IS NULL AND ${table.email} IS NULL AND ${table.communityId} IS NULL)`
    ),
    check(
      'email_link_requests_resolved',
      sql`(${table.state} = 'pending' AND ${table.resolvedAt} IS NULL) OR (${table.state} <> 'pending' AND ${table.resolvedAt} IS NOT NULL AND ${table.email} IS NULL)`
    ),
    index('email_link_requests_due_idx')
      .on(table.createdAt)
      .where(sql`state = 'pending'`),
    index('email_link_requests_email_idx').on(table.emailHash, table.createdAt),
    index('email_link_requests_user_idx').on(table.userId, table.createdAt),
    index('email_link_requests_created_idx').on(table.createdAt),
    index('email_link_requests_community_idx')
      .on(table.communityId)
      .where(sql`community_id IS NOT NULL`),
  ]
);
