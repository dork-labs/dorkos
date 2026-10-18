import { check, foreignKey, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { communities, ownerReplacements } from '../schema.js';

// The owner-replacement object-only links (0022), beside `../schema.ts`.

/**
 * Object-only links: one per send attempt of a notice, reminder, or reissue message, stored
 * only as a hash. A token can only object, only while its request is open, and is never deleted
 * when an attempt fails. `outboxId` has no foreign key: the message row is deleted 30 days after
 * it resolves, while the token lives as long as its request.
 */
export const ownerReplacementObjectTokens = pgTable(
  'owner_replacement_object_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    replacementId: uuid('replacement_id').notNull(),
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
    tokenHash: text('token_hash').notNull().unique(),
    outboxId: uuid('outbox_id'),
    /** Set from the caller's clock; no default. */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'owner_replacement_object_tokens_token_hash_check',
      sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`
    ),
    foreignKey({
      name: 'owner_replacement_object_tokens_tenant_fk',
      columns: [table.communityId, table.replacementId],
      foreignColumns: [ownerReplacements.communityId, ownerReplacements.id],
    }).onDelete('cascade'),
    index('owner_replacement_object_tokens_replacement_idx').on(table.replacementId),
  ]
);
