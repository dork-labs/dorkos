/**
 * The chats task runs run in (DOR-3703, M-A, MB1), so a tool call from inside a
 * run, or from a chat a run started, is recognised as the run's (M7).
 *
 * The run's chat is written to its run row the moment a dispatch path picks
 * it, before the first turn, for every trigger: the row is the durable record,
 * and it outlives a restart, as the run's spin-offs and their reports do. When
 * the runtime settles on its own id for the chat, the row moves with it
 * ({@link moveRunSessions}, from the runtime registry's rekey), as the
 * started-by records do, so the two always name the chat the same way.
 *
 * The in-memory set is an extra on top: it answers for a run whose row write
 * failed, and matches either id a chat is known by ({@link primaryOf}).
 *
 * @module services/tasks/session/active-run-sessions
 */
import { eq } from 'drizzle-orm';
import { pulseRuns, type Db } from '@dorkos/db';
import type { TaskStore } from '../task-store.js';
import { logger } from '../../../lib/logger.js';
import { primaryOf } from '../../session/resolution/session-key-registry.js';

/** Run id → the chats it runs in. */
const byRun = new Map<string, Set<string>>();

/** A keep-awake hold, as much of it as this module touches. */
interface RunHold {
  attachSession(sessionId: string): void;
  release(): void;
}

/**
 * A run's turn runs in this chat: write it on the run's row before the turn
 * starts, remember it, and tell the keep-awake hold.
 *
 * @param runId - The run.
 * @param sessionId - The chat its turn runs in.
 * @param awake - The run's keep-awake hold, when there is one.
 * @param store - Where the run's row is kept; absent in a caller with no store.
 */
export function noteRunSession(
  runId: string,
  sessionId: string,
  awake?: RunHold,
  store?: Pick<TaskStore, 'updateRun'>
): void {
  const sessions = byRun.get(runId) ?? new Set<string>();
  sessions.add(primaryOf(sessionId));
  byRun.set(runId, sessions);
  awake?.attachSession(sessionId);
  if (store) writeRunChat(store, runId, sessionId);
}

/**
 * Write a run's chat on its row, with one retry. A row that still cannot be
 * written costs the record past a restart, never the run: losing the lineage
 * takes this failure and a restart during this same run (Security's ruling,
 * Nov 3), so it is logged as an error and the run goes on.
 *
 * @param store - Where the run's row is kept.
 * @param runId - The run.
 * @param sessionId - The chat its turn runs in.
 */
function writeRunChat(store: Pick<TaskStore, 'updateRun'>, runId: string, sessionId: string): void {
  try {
    store.updateRun(runId, { sessionId });
  } catch {
    try {
      store.updateRun(runId, { sessionId });
    } catch (err) {
      logger.error('[ActiveRunSessions] could not write a run’s chat on its row', {
        runId,
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * A chat the runtime renamed: every run row that names it by the old id names
 * it by the new one, so a run's lineage reads the same after a restart.
 *
 * @param db - The database the run rows are kept in.
 * @param fromId - The id the chat was known by.
 * @param toId - Its canonical id.
 */
export function moveRunSessions(db: Db, fromId: string, toId: string): void {
  if (fromId === toId) return;
  db.update(pulseRuns).set({ sessionId: toId }).where(eq(pulseRuns.sessionId, fromId)).run();
}

/**
 * A run ended, however it ended: forget its chats, and release its hold.
 *
 * @param runId - The run.
 * @param awake - The run's keep-awake hold, when there is one.
 */
export function endRunSessions(runId: string, awake?: RunHold): void {
  byRun.delete(runId);
  awake?.release();
}

/**
 * Which of these chats a run is running in right now.
 *
 * @param sessionIds - The chats, by any id they are known by.
 */
export function activeRunSessionsOf(sessionIds: readonly string[]): string[] {
  if (byRun.size === 0) return [];
  const live = new Set<string>();
  for (const sessions of byRun.values()) for (const id of sessions) live.add(id);
  return sessionIds.filter((id) => live.has(id) || live.has(primaryOf(id)));
}

/**
 * Forget every run.
 *
 * @internal Exported for testing only.
 */
export function resetActiveRunSessions(): void {
  byRun.clear();
}
