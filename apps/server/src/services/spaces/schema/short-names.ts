import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { communities, time } from '../schema.js';

// Short names (0015), beside `../schema.ts`.

/** A community's short names: one current, and retired ones that still lead to it. */
export const communityShortNames = pgTable(
  'community_short_names',
  {
    shortName: text('short_name').primaryKey(),
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
    state: text('state').notNull(),
    createdAt: time('created_at'),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('community_short_names_one_current')
      .on(table.communityId)
      .where(sql`${table.state} = 'current'`),
    index('community_short_names_community_idx').on(table.communityId),
    check(
      'community_short_names_short_name_check',
      sql`${table.shortName} ~ '^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){2,31}$'`
    ),
    check('community_short_names_state_check', sql`${table.state} IN ('current','retired')`),
    check(
      'community_short_names_retired',
      sql`(${table.state} = 'retired') = (${table.retiredAt} IS NOT NULL)`
    ),
  ]
);

/** Cool-off holds on released short names, keyed by an HMAC so no name is kept in clear. */
export const releasedShortNames = pgTable(
  'released_short_names',
  {
    nameHmac: text('name_hmac').primaryKey(),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('released_short_names_available_idx').on(table.availableAt),
    check('released_short_names_name_hmac_check', sql`${table.nameHmac} ~ '^[a-f0-9]{64}$'`),
  ]
);
