import { sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Opaque launch locations; private filesystem paths never become link identities. */
export const sessionLocations = sqliteTable(
  'session_locations',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull(),
    cwd: text('cwd').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [uniqueIndex('session_locations_owner_cwd').on(table.ownerId, table.cwd)]
);
