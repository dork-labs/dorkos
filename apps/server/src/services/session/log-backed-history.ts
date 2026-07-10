/**
 * Completed-history read path for LOG-BACKED runtimes (codex, opencode,
 * test-mode) — the durable half of DOR-189.
 *
 * History for these runtimes is reconstructed from the DorkOS-owned event
 * stream. This resolves that stream durably: when the session-event store is
 * wired, completed history is read straight from SQLite
 * (`store.readAll(sessionId)`), so it survives a server restart and needs NO
 * live projector — the fix for the original bug (`getMessageHistory` →
 * `peekProjector` → `[]` after a restart). When no store is wired (unit tests,
 * embedded hosts without a Db) it falls back to the live projector's in-memory
 * log, the pre-DOR-189 behavior.
 *
 * The live in-progress turn is NOT included here — it is delivered separately
 * via the session snapshot's `inProgressTurn`; a projector flushes each turn to
 * the store on `turn_end`, so the store is the single source for completed
 * history whether or not a projector is live (no double counting).
 *
 * @module services/session/log-backed-history
 */
import type { HistoryMessage } from '@dorkos/shared/types';
import { reconstructHistoryFromEvents } from './event-log-history.js';
import { getSessionEventStore, peekProjector } from './session-state-projector.js';

/**
 * Reconstruct a log-backed session's completed-turn history from the durable
 * store when wired, else from the live projector's EventLog. Always returns an
 * array (never throws) — the `AgentRuntime.getMessageHistory` contract.
 *
 * @param sessionId - DorkOS session identifier
 */
export function readLogBackedHistory(sessionId: string): HistoryMessage[] {
  const store = getSessionEventStore();
  if (store !== undefined) {
    return reconstructHistoryFromEvents(store.readAll(sessionId));
  }
  const projector = peekProjector(sessionId);
  return projector ? reconstructHistoryFromEvents(projector.replayFrom(0)) : [];
}
