/**
 * The production {@link OpenWorkReader} (DOR-3674): which lanes an agent started, and when its
 * chats last ran.
 *
 * - **Lanes** are the chats a `session_start` from one of the agent's chats opened, read from
 *   `session_started_by` (kind `chat`) over the last {@link LANE_OPEN_MS}, matched to the agent
 *   by the starting chat's recorded agent. Older ones are no longer counted as its open work.
 * - **Activity** is kept here, in memory, from every projector status change: a chat was active
 *   at the last change seen. A restart forgets it, so "since" then counts from when this process
 *   started watching, never from earlier than it can show.
 *
 * @module services/heartbeats/gatherers/open-work-reader
 */
import { and, desc, eq, gte } from 'drizzle-orm';
import { sessionStartedBy, type Db } from '@dorkos/db';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import {
  listProjectorStatuses,
  onProjectorStatusChange,
  type ProjectorStatusUpdate,
} from '../../session/session-state-projector.js';
import type { OpenLane, OpenWorkReader } from './open-work.js';

/** How far back a lane still counts as the agent's open work. */
export const LANE_OPEN_MS = 3 * 24 * 60 * 60 * 1000;

/** The most lane rows one beat reads. */
const LANE_ROWS = 200;

/** The most chats whose last activity is kept; the oldest are dropped first. */
const SEEN_LIMIT = 5000;

/** Lifecycles that mean a chat is mid-turn. */
const RUNNING = new Set(['streaming', 'blocked']);

/** What the reader needs besides the database. */
export interface OpenWorkReaderDeps {
  /** The agent working in a directory, or undefined. */
  agentIdForCwd: (cwd: string) => string | undefined;
  /** The agent a chat was recorded for, or null. */
  agentPathOf?: (sessionId: string) => Promise<string | null>;
  /** The clock (ms). */
  now?: () => number;
}

/**
 * Build the reader and start watching chat activity.
 *
 * @param db - The database.
 * @param deps - How a directory or a chat maps to its agent.
 * @returns The reader, and a stop for its status listener.
 */
export function createOpenWorkReader(
  db: Db,
  deps: OpenWorkReaderDeps
): { reader: OpenWorkReader; stop: () => void } {
  const now = deps.now ?? Date.now;
  const agentPathOf = deps.agentPathOf ?? ((id: string) => runtimeRegistry.getSessionAgentPath(id));
  const startedWatching = now();
  const seen = new Map<string, { at: number; cwd: string | undefined }>();
  const stop = onProjectorStatusChange((update: ProjectorStatusUpdate) => {
    seen.delete(update.sessionId);
    seen.set(update.sessionId, { at: now(), cwd: update.cwd });
    if (seen.size > SEEN_LIMIT) seen.delete(seen.keys().next().value!);
  });

  const isRunning = (sessionId: string): boolean =>
    listProjectorStatuses().some(
      (entry) => entry.sessionId === sessionId && RUNNING.has(entry.status.lifecycle)
    );

  const reader: OpenWorkReader = {
    async lanesOf(agent, at) {
      const rows = db
        .select({
          sessionId: sessionStartedBy.sessionId,
          parent: sessionStartedBy.startedBySessionId,
          createdAt: sessionStartedBy.createdAt,
        })
        .from(sessionStartedBy)
        .where(
          and(
            eq(sessionStartedBy.kind, 'chat'),
            gte(sessionStartedBy.createdAt, new Date(at.getTime() - LANE_OPEN_MS).toISOString())
          )
        )
        .orderBy(desc(sessionStartedBy.createdAt))
        .limit(LANE_ROWS)
        .all();
      const owners = new Map<string, string | null>();
      const lanes: OpenLane[] = [];
      for (const row of rows) {
        if (!row.parent) continue;
        if (!owners.has(row.parent)) {
          owners.set(row.parent, await agentPathOf(row.parent).catch(() => null));
        }
        if (owners.get(row.parent) !== agent.projectPath) continue;
        lanes.push({ sessionId: row.sessionId, startedAt: row.createdAt });
      }
      return lanes;
    },
    isRunning,
    lastActiveAt: (sessionId) => (isRunning(sessionId) ? now() : seen.get(sessionId)?.at),
    agentActivity(agentId, excluding) {
      const running = listProjectorStatuses().some(
        (entry) =>
          !excluding.has(entry.sessionId) &&
          RUNNING.has(entry.status.lifecycle) &&
          entry.cwd !== undefined &&
          deps.agentIdForCwd(entry.cwd) === agentId
      );
      if (running) return 'running';
      let last: number | undefined;
      for (const [sessionId, entry] of seen) {
        if (excluding.has(sessionId) || entry.cwd === undefined) continue;
        if (deps.agentIdForCwd(entry.cwd) !== agentId) continue;
        last = last === undefined ? entry.at : Math.max(last, entry.at);
      }
      return last;
    },
    watchingSince: () => startedWatching,
  };
  return { reader, stop };
}
