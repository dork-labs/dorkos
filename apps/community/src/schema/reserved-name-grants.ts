import { check, foreignKey, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { time } from '../schema.js';
import { communityShortNames } from './short-names.js';

// Reserved short names a host operator gave to a space (0038), beside `../schema.ts`.

/**
 * One reserved short name a host operator gave to a space, and why. The row is the record of
 * the grant and what lets the address open the space. It belongs to the space's hold on the
 * name, so it goes when that `community_short_names` row does. 0038 also adds the unique
 * `(short_name, community_id)` constraint on `community_short_names` that the key points at.
 */
export const reservedNameGrants = pgTable(
  'reserved_name_grants',
  {
    shortName: text('short_name').primaryKey(),
    communityId: uuid('community_id').notNull(),
    reason: text('reason').notNull(),
    grantedByHostActor: text('granted_by_host_actor').notNull(),
    createdAt: time('created_at'),
  },
  (table) => [
    foreignKey({
      name: 'reserved_name_grants_short_name_community_id_fkey',
      columns: [table.shortName, table.communityId],
      foreignColumns: [communityShortNames.shortName, communityShortNames.communityId],
    }).onDelete('cascade'),
    check(
      'reserved_name_grants_reason_check',
      sql`${table.reason} = btrim(${table.reason}) AND char_length(${table.reason}) BETWEEN 1 AND 200`
    ),
    check(
      'reserved_name_grants_granted_by_host_actor_check',
      sql`${table.grantedByHostActor} ~ '^(person|api_key):[A-Za-z0-9_-]{1,200}$'`
    ),
  ]
);
