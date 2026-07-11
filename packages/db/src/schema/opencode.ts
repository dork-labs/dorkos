import { sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Adapter-owned durable map from a DorkOS sessionId to its OpenCode session id
// (`ses_…`). One DorkOS session <-> one OpenCode session (ADR-0308). Before
// this table the mapping lived only in the OpenCodeSessionMapper's in-memory
// maps, so a server restart forgot every binding: the first post-restart
// re-list minted a NEW derived (name-based v5) DorkOS id for the same OpenCode
// session, the original id 404'd forever, and bookmarks/deep links broke
// (DOR-251). Persisting the binding lets the mapper re-associate the ORIGINAL
// DorkOS id with its OpenCode session across restarts.
//
// Unlike `codex_threads`, no display metadata lives here: OpenCode's sidecar
// store is itself durable and owns title/timestamps — only the id binding
// needs DorkOS-side durability.
//
// `oc_session_id` is uniquely indexed because the mapper resolves both
// directions and the binding must stay strictly 1:1. Writers replace any row
// on either key in one transaction (see OpenCodeSessionMap.bind), mirroring
// the mapper's authoritative `link()` semantics.
// `createdAt` is ISO 8601 text for parity with every other table here.
export const opencodeSessions = sqliteTable(
  'opencode_sessions',
  {
    sessionId: text('session_id').primaryKey(),
    ocSessionId: text('oc_session_id').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [uniqueIndex('opencode_sessions_oc_session_id_unique').on(table.ocSessionId)]
);

export type OpencodeSession = typeof opencodeSessions.$inferSelect;
export type NewOpencodeSession = typeof opencodeSessions.$inferInsert;
