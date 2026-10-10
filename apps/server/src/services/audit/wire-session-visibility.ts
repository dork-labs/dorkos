/**
 * Wires who may read each session (spec `audit-trail` §3.4) and the deps the
 * `audit` capabilities read, at startup. Kept out of `index.ts` so the
 * composition root only names it.
 *
 * @module services/audit/wire-session-visibility
 */
import { inArray, sessionMetadata, type Db } from '@dorkos/db';
import type { ResolveTaskOrigins } from '../session/origin/task-origin-overlay.js';
import type { ResolveStartedBy } from '../session/origin/started-by-origin-overlay.js';
import type { RuntimeRegistry } from '../core/runtime-registry.js';
import { resolveRoomSessionVisibility } from '../rooms/session-bindings/room-session-visibility.js';
import type { AuditLog } from './audit-log.js';
import type { AccountIds } from './account-ids.js';
import { createTranscriptReader } from './read-transcript.js';
import {
  initSessionVisibility,
  readSessionVisibilities,
  sessionVisibilities,
} from './session-visibility.js';

/**
 * The stored launch origin of each of `sessionIds` that has one, in one query.
 * The caller keeps the list under SQLite's bound-variable limit.
 *
 * @param db - The server database.
 * @param sessionIds - The sessions.
 */
export function readSessionLaunchOrigins(
  db: Db,
  sessionIds: readonly string[]
): Map<string, string> {
  const origins = new Map<string, string>();
  if (sessionIds.length === 0) return origins;
  const rows = db
    .select({ sessionId: sessionMetadata.sessionId, launchOrigin: sessionMetadata.launchOrigin })
    .from(sessionMetadata)
    .where(inArray(sessionMetadata.sessionId, [...sessionIds]))
    .all();
  for (const row of rows) {
    if (row.launchOrigin !== null) origins.set(row.sessionId, row.launchOrigin);
  }
  return origins;
}

/** What {@link wireSessionVisibility} reads. */
export interface SessionVisibilityWiring {
  /** The server database. */
  db: Db;
  /** Names agents by their stable account ids. */
  accounts: Pick<AccountIds, 'agentAccountId'>;
  /** Task runs; absent when tasks are off. */
  resolveTaskOrigins?: ResolveTaskOrigins | undefined;
  /** Recorded starters (`session_started_by`). */
  resolveStartedBy?: ResolveStartedBy | undefined;
}

/**
 * Set the process-wide answer to "who may read this session": the stored
 * launch origin, else the origin overlays; a room turn is decided by its room
 * (a team channel is its agent members' to read, a person's DM or a bridged
 * chat-app chat is theirs). Read by the session routes, the session stream
 * socket, search, and `transcript_read`.
 *
 * @param wiring - The database and lookups.
 */
export function wireSessionVisibility(wiring: SessionVisibilityWiring): void {
  const { db, accounts } = wiring;
  initSessionVisibility((sessionIds) =>
    sessionVisibilities(sessionIds, {
      launchOriginsOf: (ids) => readSessionLaunchOrigins(db, ids),
      resolveRoomVisibility: (ids) =>
        resolveRoomSessionVisibility(db, ids, (home) => accounts.agentAccountId(home)),
      resolveTaskOrigins: wiring.resolveTaskOrigins,
      resolveStartedBy: wiring.resolveStartedBy,
    })
  );
}

/**
 * The `auditDeps` the `audit` capabilities read: the log, account ids, the
 * session reader rule and a transcript reader.
 *
 * @param log - The audit log.
 * @param accounts - Names the calling agent.
 * @param registry - Resolves a session's runtime, for its transcript.
 */
export function auditCapabilityDeps(
  log: AuditLog,
  accounts: AccountIds,
  registry: Pick<RuntimeRegistry, 'resolveForSession'>
) {
  return {
    log,
    accounts,
    sessionVisibilities: (sessionIds: readonly string[]) => readSessionVisibilities(sessionIds),
    readTranscript: createTranscriptReader(registry),
  };
}
