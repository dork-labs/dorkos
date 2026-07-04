import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Adapter-owned durable map from a DorkOS sessionId to its Codex threadId
// (ADR-0309: one DorkOS session <-> one Codex thread). Lives in its own table
// so `session_metadata` (immutable runtime binding + mutable settings;
// ADR-0255/0260) stays completely untouched. The binding is immutable once
// assigned — writers use INSERT OR IGNORE (first-write-wins), mirroring
// `session_metadata.runtime` semantics.
// `cwd` is the working directory the thread was created in, captured alongside
// the threadId so a post-restart `resumeThread` runs `codex exec` in the right
// project directory instead of the server's own `process.cwd()`. It is nullable
// so pre-cwd (legacy) bindings still parse — a missing cwd degrades to the
// pre-fix behavior (no `workingDirectory`), never a crash.
// `createdAt` is ISO 8601 text for parity with every other table in this
// schema (a2a, activity, mesh, relay, sessions, tasks).
export const codexThreads = sqliteTable('codex_threads', {
  sessionId: text('session_id').primaryKey(),
  threadId: text('thread_id').notNull(),
  cwd: text('cwd'),
  createdAt: text('created_at').notNull(),
});

export type CodexThread = typeof codexThreads.$inferSelect;
export type NewCodexThread = typeof codexThreads.$inferInsert;
