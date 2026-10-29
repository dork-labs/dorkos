import { foreignKey, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { communities, connectionGrants, members } from '../schema.js';

// The credentials a person's app manages a space with (0047, DOR-3005), beside `../schema.ts`.

/**
 * A separate, revocable credential an owner or admin gives their paired app, with their consent,
 * so it can manage the space for them. One per connection grant at most, and only as long as that
 * grant: it is refused once the grant is revoked, and deleted with it. Stored only as a hash.
 */
export const connectionAdministerGrants = pgTable(
  'connection_administer_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
    memberId: uuid('member_id').notNull(),
    grantId: uuid('grant_id')
      .notNull()
      .unique()
      .references(() => connectionGrants.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    index('connection_administer_grants_community_idx').on(table.communityId),
    index('connection_administer_grants_member_idx').on(table.memberId),
    foreignKey({
      name: 'connection_administer_grants_member_tenant_fk',
      columns: [table.communityId, table.memberId],
      foreignColumns: [members.communityId, members.id],
    }),
  ]
);
