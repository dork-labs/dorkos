import { sessionMetadata, sessionNativeBindings, eq, type Db } from '@dorkos/db';
import type { SessionSettings } from '@dorkos/shared/types';
import { rowToSettings } from './runtime-session-settings.js';

/**
 * Read the actual native directory, distinct from the agent's ownership provenance.
 * @param readDb - Original registry database accessor at the original read frontier.
 * @param sessionId - Session identifier to read.
 * @returns The original stored directory or null.
 */
export function readGetNativeSessionCwd(
  readDb: () => Db | undefined,
  sessionId: string
): string | null {
  const db = readDb();
  if (!db) return null;
  return (
    db
      .select({ cwd: sessionNativeBindings.cwd })
      .from(sessionNativeBindings)
      .where(eq(sessionNativeBindings.sessionId, sessionId))
      .get()?.cwd ?? null
  );
}

/**
 * Every session id bound to one agent directory.
 *
 * The bulk sibling of {@link RuntimeRegistry.getSessionAgentPath}, for the
 * session fan-out: it asks once per agent rather than once per row, and the
 * answer is what still says "this conversation is this agent's" when the
 * conversation's own directory says something else — a room turn running in
 * that room's worktree (spec `project-rooms` §3.5).
 *
 * The STORED value, never re-derived from a cwd. Returns an empty set when
 * the registry has no database, so a caller on a bare install degrades to
 * cwd-only membership rather than failing.
 *
 * @param agentPath - The agent's directory, exactly as it was bound.
 * @param readDb - Original registry database accessor, evaluated at the original read frontier.
 */
export function readListSessionIdsForAgentPath(
  readDb: () => Db | undefined,
  agentPath: string
): Set<string> {
  const db = readDb();
  if (!db) return new Set();
  const rows = db
    .select({ sessionId: sessionMetadata.sessionId })
    .from(sessionMetadata)
    .where(eq(sessionMetadata.agentPath, agentPath))
    .all();
  return new Set(rows.map((row) => row.sessionId));
}

/**
 * Read the working directory a session is bound to (`agentPath`), or null when
 * no bound row exists yet. This is the project directory the session's
 * transcript lives under — the one input a transcript read needs beyond the
 * session id (see `lib/transcript-excerpt.ts`). Null when the session has not
 * started (no binding row) or was created without an owning agent path; the
 * caller then falls back to the default working directory.
 *
 * @param sessionId - Session identifier
 * @param requireDb - Original registry database accessor, evaluated at the original read frontier.
 */
export function readGetSessionAgentPath(
  requireDb: (method: string) => Db,
  sessionId: string
): string | null {
  const db = requireDb('getSessionAgentPath');
  const row = db
    .select({ agentPath: sessionMetadata.agentPath })
    .from(sessionMetadata)
    .where(eq(sessionMetadata.sessionId, sessionId))
    .get();
  return row?.agentPath ?? null;
}

/**
 * What started a session (`TurnOrigin.kind`), as the binding write recorded
 * it, or null when the session has no row or was bound before the column
 * existed. Server-held, unlike `Session.origin`, so it can decide what a
 * session may do (spec `claude-account-fleet` D9).
 *
 * @param sessionId - Session identifier
 * @param requireDb - Original registry database accessor, evaluated at the original read frontier.
 */
export function readGetSessionLaunchOrigin(
  requireDb: (method: string) => Db,
  sessionId: string
): string | null {
  const db = requireDb('getSessionLaunchOrigin');
  const row = db
    .select({ launchOrigin: sessionMetadata.launchOrigin })
    .from(sessionMetadata)
    .where(eq(sessionMetadata.sessionId, sessionId))
    .get();
  return row?.launchOrigin ?? null;
}

/**
 * The usage-limit episode core last resumed this session from by itself
 * (`session_metadata.last_auto_resume_for`), or null when it never did.
 * Read by every later episode, so a resumed turn that runs out again in the
 * same window is never resumed a second time (spec `claude-account-fleet`
 * D9 "Wait, then resume by itself").
 *
 * @param sessionId - Session identifier
 * @param requireDb - Original registry database accessor, evaluated at the original read frontier.
 */
export function readGetLastAutoResumeFor(
  requireDb: (method: string) => Db,
  sessionId: string
): string | null {
  const db = requireDb('getLastAutoResumeFor');
  const row = db
    .select({ lastAutoResumeFor: sessionMetadata.lastAutoResumeFor })
    .from(sessionMetadata)
    .where(eq(sessionMetadata.sessionId, sessionId))
    .get();
  return row?.lastAutoResumeFor ?? null;
}

/**
 * A session's stored permission mode, read synchronously, or null when there
 * is no row or no mode. For the turn-level record at the registration seam,
 * which must not add an await between a dispatch and its turn.
 *
 * @param sessionId - Session identifier
 * @param requireDb - Original registry database accessor, evaluated at the original read frontier.
 */
export function readStoredPermissionModeOf(
  requireDb: (method: string) => Db,
  sessionId: string
): string | null {
  const db = requireDb('storedPermissionModeOf');
  const row = db
    .select({ permissionMode: sessionMetadata.permissionMode })
    .from(sessionMetadata)
    .where(eq(sessionMetadata.sessionId, sessionId))
    .get();
  return row?.permissionMode ?? null;
}

/**
 * Read a session's persisted settings, or null when no row exists. NULL
 * columns are omitted from the result (not surfaced as explicit values).
 *
 * @param sessionId - Session identifier
 * @param requireDb - Original registry database accessor, evaluated at the original read frontier.
 */
export function readGetSessionSettings(
  requireDb: (method: string) => Db,
  sessionId: string
): SessionSettings | null {
  const db = requireDb('getSessionSettings');
  const row = db
    .select({
      permissionMode: sessionMetadata.permissionMode,
      model: sessionMetadata.model,
      effort: sessionMetadata.effort,
      fastMode: sessionMetadata.fastMode,
    })
    .from(sessionMetadata)
    .where(eq(sessionMetadata.sessionId, sessionId))
    .get();
  return row ? rowToSettings(row) : null;
}
