/**
 * Boot-time reconcile for the two durable per-session tables — the queued
 * messages of `session_message_queue` and the held words of
 * `session_staged_context` (DOR-1436).
 *
 * ## The gap this closes
 *
 * Both tables are already reclaimed while the server is UP:
 * `sweepOrphanedMessageQueues` runs on the health-check cadence over the ids the
 * fleet watcher reported removed. That signal only exists for a process
 * that was listening. A conversation deleted while DorkOS was stopped —
 * `rm`'d transcript, a project directory that went with a repo — is announced to
 * nobody, so its rows sit in SQLite for the life of the install with no reader
 * and no reaper. Boot is the one moment that can ask the question the watcher
 * missed, and it is the same moment the room-binding repair
 * (`rooms/room-session-convergence.ts`, DOR-1205) exists for.
 *
 * ## Why it deletes so little
 *
 * A queued message is somebody's words under a promise that they were accepted,
 * so the bar for deleting one is not "we could not find the session" — it is
 * "its owner says the session is gone". Three guards stand between a row and the
 * delete, and each one keeps rows when it cannot answer:
 *
 * 1. **The inventory must be COMPLETE.** An unreadable account or project
 *    directory makes every id under it look absent, which is exactly the shape
 *    of a mass false positive. A partial inventory reaps nothing at all.
 * 2. **The session must be BOUND to claude-code** in `session_metadata`. That
 *    binding is written when a session actually starts (ADR-0255), so this drops
 *    two whole classes in one test: sessions owned by codex or opencode, whose
 *    stores this reconcile cannot see and must not judge, and sessions that have
 *    never run — a person can stage words into a session before its first turn,
 *    and that hold is waiting for a turn that has not happened yet, not
 *    orphaned. Rows with no binding at all are kept for the same reason.
 * 3. **The id must be absent from the fleet-wide inventory** — every project
 *    under every account, not one project's listing. A session's listing is
 *    scoped to its working directory, so "not in this listing" is the ordinary
 *    condition of every session belonging to another project.
 *
 * The consequence is honest and deliberate: rows belonging to codex and opencode
 * sessions are still only reclaimed by the live sweep. The probe here IS the
 * claude-code transcript reader, exactly as the room-binding repair's is, and a
 * verdict invented for a store this process cannot read would be a guess with a
 * delete behind it.
 *
 * @module services/session/reconcile-session-rows
 */
import { logger } from '../../lib/logger.js';

/** The one runtime whose store this reconcile can read for itself. */
const CLAUDE_CODE_RUNTIME = 'claude-code';

/** What one boot reconcile found and did. */
export interface SessionRowReconcileReport {
  /** Distinct sessions holding rows in either table. */
  candidates: number;
  /** Sessions whose rows were removed because their owner has no such session. */
  reaped: number;
  /** Rows removed across both tables. */
  rows: number;
  /**
   * Candidates left exactly as they are — every session this reconcile could
   * not prove gone. Reported rather than inferred from the other two counts,
   * because "kept because nothing could be judged" and "kept because everything
   * is alive" are the two outcomes a reader most needs to tell apart.
   */
  kept: number;
  /**
   * Whether the owning runtime's inventory could be read in full. `false` means
   * no verdict was reached about anything, and nothing was deleted.
   */
  inventoryComplete: boolean;
}

/** The stores, the ownership lookup and the probe, injected for testability. */
export interface SessionRowReconcileDeps {
  /** Sessions holding queued messages, and the delete that clears them. */
  queue: {
    listSessionIds(): string[];
    deleteForSessions(sessionIds: string[]): number;
  };
  /** Sessions holding staged words, and the delete that clears them. */
  staged: {
    listSessionIds(): string[];
    deleteForSessions(sessionIds: string[]): number;
  };
  /**
   * The runtime each session is BOUND to. Ids that have never started must be
   * absent from the map rather than attributed to a default.
   */
  boundRuntimesFor(sessionIds: string[]): Map<string, string>;
  /**
   * Every claude-code session id on disk, fleet-wide, plus whether that
   * inventory read everything it needed to.
   */
  claudeCodeInventory(): Promise<{ ids: Set<string>; complete: boolean }>;
}

/** An empty report, for the paths that judge nothing. */
function nothingJudged(candidates: number, inventoryComplete: boolean): SessionRowReconcileReport {
  return { candidates, reaped: 0, rows: 0, kept: candidates, inventoryComplete };
}

/**
 * Reclaim the durable rows of sessions that disappeared while the server was
 * down, and report what happened either way.
 *
 * Never throws and never goes quiet: every step that can fail — the two row
 * reads, the inventory probe, the ownership read, and the deletes — is caught
 * and turns into a report that says nothing was judged. A boot reconcile that
 * threw would take the rest of startup's detached work with it, and one that
 * swallowed its failure would be indistinguishable from a database with nothing
 * to reclaim.
 *
 * @param deps - The stores, the ownership lookup and the inventory probe.
 */
export async function reconcileSessionRows(
  deps: SessionRowReconcileDeps
): Promise<SessionRowReconcileReport> {
  let candidates: string[];
  try {
    candidates = [...new Set([...deps.queue.listSessionIds(), ...deps.staged.listSessionIds()])];
  } catch (err) {
    logger.warn('[SessionRows] could not read the sessions holding rows', {
      error: err instanceof Error ? err.message : String(err),
    });
    return nothingJudged(0, false);
  }
  if (candidates.length === 0) return nothingJudged(0, true);

  let inventory: { ids: Set<string>; complete: boolean };
  try {
    inventory = await deps.claudeCodeInventory();
  } catch (err) {
    logger.warn('[SessionRows] could not inventory the sessions on disk', {
      error: err instanceof Error ? err.message : String(err),
    });
    return nothingJudged(candidates.length, false);
  }
  // A partial inventory makes an id that IS on disk look absent, so it is not
  // evidence of anything. Keeping every row costs one boot's reclamation; the
  // alternative costs somebody their queued words.
  if (!inventory.complete) {
    logger.info('[SessionRows] skipped the boot reconcile: the session inventory was incomplete', {
      candidates: candidates.length,
    });
    return nothingJudged(candidates.length, false);
  }

  let owners: Map<string, string>;
  try {
    owners = deps.boundRuntimesFor(candidates);
  } catch (err) {
    logger.warn('[SessionRows] could not read which runtime owns the sessions holding rows', {
      error: err instanceof Error ? err.message : String(err),
    });
    return nothingJudged(candidates.length, false);
  }

  const doomed = candidates.filter(
    (id) => owners.get(id) === CLAUDE_CODE_RUNTIME && !inventory.ids.has(id)
  );
  if (doomed.length === 0) return nothingJudged(candidates.length, true);

  let rows: number;
  try {
    rows = deps.queue.deleteForSessions(doomed) + deps.staged.deleteForSessions(doomed);
  } catch (err) {
    logger.warn('[SessionRows] could not clear the rows of vanished sessions', {
      error: err instanceof Error ? err.message : String(err),
    });
    return nothingJudged(candidates.length, true);
  }

  logger.info('[SessionRows] cleared what vanished sessions left behind', {
    candidates: candidates.length,
    sessions: doomed.length,
    rows,
  });
  return {
    candidates: candidates.length,
    reaped: doomed.length,
    rows,
    kept: candidates.length - doomed.length,
    inventoryComplete: true,
  };
}
