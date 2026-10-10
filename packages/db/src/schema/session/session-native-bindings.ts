import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Verified native session locations. cwd is distinct from agent ownership provenance. */
export const sessionNativeBindings = sqliteTable('session_native_bindings', {
  sessionId: text('session_id').primaryKey(),
  runtime: text('runtime').notNull(),
  cwd: text('cwd').notNull(),
  account: text('account'),
  createdAt: text('created_at').notNull(),
});
