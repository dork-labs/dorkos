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
 * (`rooms/session-bindings/room-session-convergence.ts`, DOR-1205) exists for.
 *
 * ## Why it deletes so little
 *
 * A queued message is somebody's words under a promise that they were accepted,
 * so the bar for deleting one is not "we could not find the session" — it is
 * "its owner says the session is gone". Four guards stand between a row and the
 * delete, and each one keeps rows when it cannot answer:
 *
 * 1. **The inventory must be COMPLETE.** An unreadable account or project
 *    directory makes every id under it look absent, which is exactly the shape
 *    of a mass false positive. A partial inventory reaps nothing at all.
 * 2. **The session must be BOUND to claude-code** in `session_metadata`, which
 *    is what keeps this reconcile away from sessions it cannot judge: codex and
 *    opencode keep their sessions in stores this probe never reads, and a row
 *    with no binding at all belongs to nobody yet.
 *
 *    **Be precise about what that binding proves, because it is less than it
 *    looks.** It is written at the FIRST MESSAGE (`routes/sessions.ts`,
 *    "First-message binding: choose + persist the runtime BEFORE resolving"),
 *    under the client's request UUID, before any SDK contact — so a bound id is
 *    not yet a filename on disk. The two id migrations that follow run on
 *    different beats: `session_metadata` moves in the SDK rebind
 *    (`session-store.ts` → `RuntimeRegistry.rekeySessionSettings`), the durable
 *    rows move in the event tap (`trigger-turn.ts` → the projector's rekey). A
 *    crash between them can leave BOTH still on the request UUID — bound to
 *    claude-code, absent from disk, and by these guards reapable. What makes it
 *    safe today is not the guards but the rows: they are already unreachable —
 *    the client took the canonical id from its 202 and never asks under the
 *    UUID again — so what is deleted is a queue nothing could ever have
 *    dispatched. **It stops being safe the moment anything binds `runtime`
 *    earlier, or for an id that never reaches disk** — this guard would become a
 *    reaper of live queues, silently. Change that write, revisit this.
 * 3. **The binding must be OLDER than this process.** A session created after
 *    this server started is being created right now: its first message wrote the
 *    row, and the SDK may not have written the transcript yet. Judging it
 *    against an inventory taken moments ago is a race with somebody's first
 *    words as the stake. A binding whose timestamp cannot be read is treated as
 *    unknown, which keeps its rows too.
 * 4. **The id must be absent from the fleet-wide inventory** — every project
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

/** Milliseconds in the second `process.uptime()` reports fractions of. */
const MS_PER_SECOND = 1000;

/**
 * When this process started, epoch ms — derived rather than captured, so it is
 * the moment NODE started and not the moment this module happened to load.
 * Anything written to `session_metadata` since then was written by this run.
 */
function processStartedAt(): number {
  return Date.now() - process.uptime() * MS_PER_SECOND;
}

/** What one boot reconcile found and did. */
export interface SessionRowReconcileReport {
  /** Distinct sessions holding rows in either table. */
  candidates: number;
  /** Sessions judged gone — every guard passed, so their rows were deleted. */
  reaped: number;
  /**
   * Rows actually removed across both tables. Lower than expected when a delete
   * threw halfway: this counts what WENT, not what was ordered.
   */
  rows: number;
  /**
   * Candidates left exactly as they are — every session this reconcile could
   * not prove gone. Reported rather than inferred from the other two counts,
   * because "kept because nothing could be judged" and "kept because everything
   * is alive" are the two outcomes a reader most needs to tell apart.
   */
  kept: number;
  /**
   * How many of the two table deletes failed (0–2). Non-zero means some judged
   * rows are still there and this boot's reclamation was partial — the one
   * outcome a `reaped > 0` line would otherwise report as a clean success.
   */
  failedDeletes: number;
  /**
   * Whether the owning runtime's inventory could be read in full. `false` means
   * no verdict was reached about anything, and nothing was deleted. With no
   * candidates at all it is `true` and measures exactly what it says: no
   * candidate was left unjudged for want of an inventory.
   */
  inventoryComplete: boolean;
}

/** The stores, the binding lookup and the probe, injected for testability. */
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
   * The binding of each session — its runtime and when the row was written.
   * Sessions nobody has claimed must be ABSENT from the map rather than
   * attributed to a default.
   */
  bindingsFor(sessionIds: string[]): Map<string, { runtime: string; boundAt: number | null }>;
  /**
   * Every claude-code session id on disk, fleet-wide, plus whether that
   * inventory read everything it needed to.
   */
  claudeCodeInventory(): Promise<{ ids: Set<string>; complete: boolean }>;
  /**
   * When this process started, epoch ms. A binding written since then belongs
   * to a session being created right now and is never judged (guard 3).
   * Defaults to this process's own start; injectable so a test can place a
   * binding either side of it.
   */
  bootedAt?: number;
}

/** An empty report, for the paths that judge nothing. */
function nothingJudged(candidates: number, inventoryComplete: boolean): SessionRowReconcileReport {
  return { candidates, reaped: 0, rows: 0, kept: candidates, failedDeletes: 0, inventoryComplete };
}

/**
 * Delete `doomed` from one table, counting a failure instead of throwing it.
 *
 * Separate calls per table rather than one summed expression: a staged delete
 * that throws after the queue delete succeeded really did remove rows, and a
 * report saying otherwise is the "indistinguishable from nothing to reclaim"
 * silence this module exists to avoid.
 */
function deleteFrom(
  table: { deleteForSessions(sessionIds: string[]): number },
  doomed: string[],
  which: string
): { rows: number; failed: boolean } {
  try {
    return { rows: table.deleteForSessions(doomed), failed: false };
  } catch (err) {
    logger.warn('[SessionRows] could not clear the rows of vanished sessions', {
      table: which,
      sessions: doomed.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return { rows: 0, failed: true };
  }
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

  let bindings: Map<string, { runtime: string; boundAt: number | null }>;
  try {
    bindings = deps.bindingsFor(candidates);
  } catch (err) {
    logger.warn('[SessionRows] could not read which runtime owns the sessions holding rows', {
      error: err instanceof Error ? err.message : String(err),
    });
    return nothingJudged(candidates.length, false);
  }

  const bootedAt = deps.bootedAt ?? processStartedAt();
  const doomed = candidates.filter((id) => {
    const binding = bindings.get(id);
    // Guard 2: nobody has claimed it, or its owner is a runtime whose store
    // this probe never read.
    if (binding?.runtime !== CLAUDE_CODE_RUNTIME) return false;
    // Guard 3: written by THIS run — a session being created right now, whose
    // transcript the SDK may not have written yet — or written at a time that
    // cannot be read at all. Neither can be judged against a roll call taken a
    // moment ago.
    if (binding.boundAt === null || binding.boundAt >= bootedAt) return false;
    // Guard 4: its owner has no such session, anywhere.
    return !inventory.ids.has(id);
  });
  if (doomed.length === 0) return nothingJudged(candidates.length, true);

  const queued = deleteFrom(deps.queue, doomed, 'session_message_queue');
  const held = deleteFrom(deps.staged, doomed, 'session_staged_context');
  const rows = queued.rows + held.rows;
  const failedDeletes = Number(queued.failed) + Number(held.failed);

  logger.info('[SessionRows] cleared what vanished sessions left behind', {
    candidates: candidates.length,
    sessions: doomed.length,
    rows,
    failedDeletes,
  });
  return {
    candidates: candidates.length,
    reaped: doomed.length,
    rows,
    kept: candidates.length - doomed.length,
    failedDeletes,
    inventoryComplete: true,
  };
}
