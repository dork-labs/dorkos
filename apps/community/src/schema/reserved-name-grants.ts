import { check, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { time } from '../schema.js';

// Reserved short names a host operator gave to a space (0038), beside `../schema.ts`.

/**
 * One reserved short name a host operator gave to a space, and why. The row is the record of
 * the grant and what lets the address open the space, but only while that space still holds
 * the name. `communityId` has no foreign key on purpose: the record outlives an abandoned space.
 */
export const reservedNameGrants = pgTable(
  'reserved_name_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shortName: text('short_name').notNull(),
    communityId: uuid('community_id').notNull(),
    reason: text('reason').notNull(),
    grantedByHostActor: text('granted_by_host_actor').notNull(),
    createdAt: time('created_at'),
  },
  (table) => [
    unique('reserved_name_grants_short_name_community_id_key').on(
      table.shortName,
      table.communityId
    ),
    check(
      'reserved_name_grants_short_name_check',
      sql`${table.shortName} ~ '^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){2,31}$'`
    ),
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
