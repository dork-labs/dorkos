/**
 * The chats task runs are running in right now (DOR-3703, M-A). A run's chat is
 * known before its turn starts, on either dispatch path, while the run row only
 * learns it at the end for some of them; a tool call from inside the run asks
 * here, so a scheduled run is recognised as one while it runs (M7).
 *
 * In memory: a restart ends every run it held, so nothing is lost that matters.
 * Matched by either id a chat is known by ({@link primaryOf}).
 *
 * @module services/tasks/session/active-run-sessions
 */
import { primaryOf } from '../../session/resolution/session-key-registry.js';

/** Run id → the chats it runs in. */
const byRun = new Map<string, Set<string>>();

/** A keep-awake hold, as much of it as this module touches. */
interface RunHold {
  attachSession(sessionId: string): void;
  release(): void;
}

/**
 * A run's turn runs in this chat: remember it, and tell the keep-awake hold.
 *
 * @param runId - The run.
 * @param sessionId - The chat its turn runs in.
 * @param awake - The run's keep-awake hold, when there is one.
 */
export function noteRunSession(runId: string, sessionId: string, awake?: RunHold): void {
  const sessions = byRun.get(runId) ?? new Set<string>();
  sessions.add(primaryOf(sessionId));
  byRun.set(runId, sessions);
  awake?.attachSession(sessionId);
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
