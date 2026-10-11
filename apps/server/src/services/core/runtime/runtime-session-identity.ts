import { sessionContext, eq, type Db } from '@dorkos/db';

/**
 * Move a session's stored context reading (`session_context`, spec
 * `claude-account-fleet` §6 U) from `fromId` to `toId`. When both ids hold one,
 * the newer reading wins. A no-op when `fromId` holds none.
 *
 * @param db - The database.
 * @param fromId - The id the reading is stored under today.
 * @param toId - The id the session is now known by.
 */
export function moveSessionContext(db: Db, fromId: string, toId: string): void {
  const source = db.select().from(sessionContext).where(eq(sessionContext.sessionId, fromId)).get();
  if (!source) return;
  const destination = db
    .select()
    .from(sessionContext)
    .where(eq(sessionContext.sessionId, toId))
    .get();
  db.transaction((tx) => {
    tx.delete(sessionContext).where(eq(sessionContext.sessionId, fromId)).run();
    if (destination && destination.observedAt >= source.observedAt) return;
    tx.insert(sessionContext)
      .values({ ...source, sessionId: toId })
      .onConflictDoUpdate({
        target: sessionContext.sessionId,
        set: {
          contextTokens: source.contextTokens,
          contextMaxTokens: source.contextMaxTokens,
          observedAt: source.observedAt,
        },
      })
      .run();
  });
}

/**
 * Error thrown when a session's stored runtime type is not registered with the
 * `RuntimeRegistry`. Surfacing this explicitly (rather than silently falling
 * back to the default runtime) prevents routing bugs where a session's intended
 * runtime is unavailable — e.g., a `codex` session before the Codex adapter
 * ships, or a server started without a runtime that prior sessions depended on.
 */
export class RuntimeNotRegisteredError extends Error {
  constructor(
    public readonly runtime: string,
    public readonly sessionId: string
  ) {
    super(
      `Session '${sessionId}' is owned by runtime '${runtime}', which is not registered on this server.`
    );
    this.name = 'RuntimeNotRegisteredError';
  }
}
