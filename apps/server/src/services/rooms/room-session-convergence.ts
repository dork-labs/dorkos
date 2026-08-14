/**
 * Keeping a room's memory pointed at the session that actually holds it
 * (DOR-784).
 *
 * A room binds one session per agent (`room_sessions`), and that binding is what
 * makes an agent in a room remember yesterday. It is written BEFORE the first
 * turn, from a placeholder UUID the room mints itself, because two posts
 * arriving before the first reply have to resolve to one session
 * (`room-trigger.ts`). Claude Code then names the session itself, mid-turn, and
 * files the transcript under ITS name. Two things have to happen for the room to
 * keep up, and this module is both of them.
 *
 * **Following the rename, not the turn.** `runOne` compares the runner's answer
 * to the id it asked with, once, when the turn ends. On turn 1 — the only turn
 * where the id moves — that answer is routinely the placeholder, because
 * `triggerTurn` resolves the canonical id best-effort at first-event-or-5s and a
 * cold first turn regularly loses that race. The real name lands milliseconds
 * later through the projector's own per-event rekey, and nothing was listening.
 * So the binding follows `onProjectorRekey`, which fires the instant the name is
 * known, and the return-value rebind stays as the fallback it always should have
 * been.
 *
 * **Reporting what is already stranded.** The bindings written before this
 * existed point at ids no transcript will ever be under. Nothing errors: the
 * next message probes for a transcript, finds none, reports `hasStarted: false`,
 * and the agent starts over from nothing — every time, silently, forever.
 *
 * **At boot the sweep now repairs what it can prove, and reports the rest**
 * (DOR-1205). Repair needs a successor, and the only thing that knows one is
 * {@link RoomSessionLedger} — whose memory of retired ids used to be
 * per-process and therefore empty at startup, so on a fresh process every dead
 * binding took the warn branch by construction. Retirements are written to
 * `room_session_retirements` now, so a rename recorded by ANY previous process
 * repairs its binding at the next boot, and the branch that was a seam waiting
 * for a durable ledger is the one that does the work.
 *
 * **A stranding with no recorded successor is still only reported, and that is
 * a decision rather than a gap.** The obvious next guess — "the newest
 * transcript in this agent's directory" — would silently graft one room's
 * conversation onto another's, which is worse than the amnesia it would be
 * curing. Unknown stays unknown, out loud, with everything a person needs to
 * find the transcript by hand.
 *
 * Nothing here deletes a binding either. A binding pointing somewhere useless is
 * a conversation whose transcript may still be found by hand; a deleted one is a
 * decision nobody can review.
 *
 * @module server/services/rooms/room-session-convergence
 */
import { logger } from '../../lib/logger.js';
import { onProjectorRekey } from '../session/index.js';
import type { RoomStore } from './room-store.js';
import { resolveRoomRuntimeType } from './room-turn-runner.js';

/** The runtime whose sessions rename themselves, and the only one to sweep. */
const CLAUDE_CODE_RUNTIME = 'claude-code';

/**
 * Move every room binding across a projector rekey, for as long as the returned
 * function is not called.
 *
 * Wired at the composition root beside the connector-attach migration, which
 * answers the same event for the same reason. Not wired inside
 * `createRoomSubsystem`, deliberately: that factory is constructed per test as
 * well as per process, and a module-level listener registered there would
 * outlive the subsystem that owns it and rebind a later test's store.
 *
 * @param store - The room store whose bindings follow the rekey.
 * @returns An unsubscribe function.
 */
export function followSessionRekeys(store: RoomStore): () => void {
  return onProjectorRekey((oldId, newId) => {
    let moved;
    try {
      moved = store.sessionLedger.rebindBySessionId(oldId, newId);
    } catch (err) {
      // A rekey is a notification, not a transaction: a busy database here must
      // not break the rename for every other subsystem listening to the same
      // event. The binding stays on the old id and `runOne`'s return-value
      // rebind is still there to catch it.
      logger.warn('[rooms] could not follow a session rename', {
        oldSessionId: oldId,
        newSessionId: newId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    for (const binding of moved) {
      logger.info('[rooms] a room binding followed its session rename', {
        roomId: binding.roomId,
        authorId: binding.authorId,
        oldSessionId: oldId,
        newSessionId: newId,
      });
    }
  });
}

/** What the repair sweep needs from the world, so a test can supply all of it. */
export interface RoomBindingRepairDeps {
  /** The store holding the bindings. */
  store: RoomStore;
  /**
   * The agent directory behind a room author id, or `null` when the author is
   * not an agent this install knows. The sweep asks the author registry for
   * `naturalKey`, exactly as the dispatcher does.
   */
  agentPathFor(authorId: string): string | null;
  /**
   * Whether a transcript for this session exists on disk under this agent's
   * working directory. The claude-code transcript probe, injected rather than
   * imported so the sweep does not reach into a runtime's internals.
   */
  hasTranscript(agentPath: string, sessionId: string): Promise<boolean>;
}

/** What one sweep found, for the caller to log and for tests to assert on. */
export interface RoomBindingRepairReport {
  /**
   * Bindings this sweep reached a VERDICT on — a claude-code agent whose
   * transcript could actually be probed. A binding whose probe failed is not
   * counted here; it is in {@link RoomBindingRepairReport.unreadable}.
   */
  checked: number;
  /** Bindings moved onto a canonical id the ledger could name. */
  repaired: number;
  /** Bindings left pointing at an id with no transcript and no known successor. */
  stranded: number;
  /**
   * Bindings whose successor was named but whose write the store REFUSED,
   * because the successor is itself a retired id.
   *
   * Counted apart from {@link RoomBindingRepairReport.repaired} because a
   * refused write moves nothing: counting it as a repair would report a room
   * fixed while it still points at a dead session, and would take it out of the
   * stranded count that is the only thing telling anyone to look. Reachable
   * whenever the retirement table describes a loop, which nothing in SQLite
   * forbids across two processes.
   */
  refused: number;
  /**
   * Bindings whose repair write threw — a locked or busy database, most
   * likely.
   *
   * The write is the one piece of I/O in this loop that can fail after a
   * verdict, and before it was counted here a single `SQLITE_BUSY` rejected the
   * whole sweep: the report was discarded and every remaining binding went
   * unexamined and unwarned, out of a function whose contract is that it never
   * throws.
   */
  failed: number;
  /**
   * Bindings whose transcript could not be read at all, so nothing is known
   * about them either way.
   *
   * Counted rather than swallowed. One unreadable `~/.claude/projects` — a
   * permissions change, a mount that did not come back — makes every probe throw
   * and would otherwise leave a sweep that reported `checked: 0, stranded: 0`
   * and said nothing, which reads exactly like a clean bill of health. That is
   * the shape of a check that cannot fail, and the deep-health branch's own
   * room-binding check rejects it for the same reason.
   */
  unreadable: number;
}

/**
 * Sweep every room binding for one that points at a session with no transcript,
 * reporting what it finds and repairing the few it can prove.
 *
 * Scoped hard, because it runs at startup and startup is not the place to walk a
 * disk: only rooms that HAVE a binding (the table is the input, not the room
 * list), and only bindings whose agent runs on claude-code — the one runtime
 * that renames a session out from under its caller. Codex, OpenCode and
 * test-mode all return `undefined` from `getInternalSessionId`, so their ids
 * never moved and there is nothing to look for.
 *
 * **A binding is repaired only when the ledger can NAME its successor**, which
 * since DOR-1205 includes renames recorded by an earlier process — that is the
 * case boot-time repair exists for. The successor is followed to the end of its
 * chain, so a session renamed twice lands on the id that is live rather than on
 * another dead one, and the move goes through `RoomStore.rebindRoomSession` so
 * it obeys the same retired-id refusal every other rebind does.
 *
 * When the ledger knows nothing, the sweep says what it found — with everything
 * a person needs to find the transcript by hand — and leaves the row alone.
 * Guessing instead ("the newest transcript in this agent's directory") would
 * silently graft one room's conversation onto another's, which is worse than the
 * amnesia it would be curing.
 *
 * Never throws, and never goes quiet: a sweep that could judge nothing says so.
 * Every step that can fail — the binding read, the transcript probe, and the
 * repair WRITE — is counted into its own field and the loop continues, because
 * one busy database on row three must not cost rows four onwards their warning.
 *
 * @param deps - The store, the agent lookup and the transcript probe.
 */
export async function repairRoomSessionBindings(
  deps: RoomBindingRepairDeps
): Promise<RoomBindingRepairReport> {
  const report: RoomBindingRepairReport = {
    checked: 0,
    repaired: 0,
    stranded: 0,
    refused: 0,
    failed: 0,
    unreadable: 0,
  };
  let bindings;
  try {
    bindings = deps.store.sessionLedger.list();
  } catch (err) {
    logger.warn('[rooms] could not read room session bindings to check them', {
      error: err instanceof Error ? err.message : String(err),
    });
    return report;
  }

  for (const binding of bindings) {
    const agentPath = deps.agentPathFor(binding.authorId);
    if (agentPath === null) continue;
    // `resolveRoomRuntimeType` swallows its own manifest read and falls back to
    // the registry default, so it cannot throw and is not wrapped. If that ever
    // stops being true, this loop is the caller that would silently skip every
    // binding — so the guarantee belongs in that function, not in a catch here.
    if ((await resolveRoomRuntimeType(agentPath)) !== CLAUDE_CODE_RUNTIME) continue;

    let exists: boolean;
    try {
      exists = await deps.hasTranscript(agentPath, binding.sessionId);
    } catch (err) {
      report.unreadable += 1;
      logger.debug('[rooms] could not probe a room session for its transcript', {
        roomId: binding.roomId,
        authorId: binding.authorId,
        sessionId: binding.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    report.checked += 1;
    if (exists) continue;

    const successor = deps.store.sessionLedger.successorFor(binding.sessionId);
    if (successor !== undefined) {
      let moved: boolean;
      try {
        moved = deps.store.rebindRoomSession(binding.roomId, binding.authorId, successor);
      } catch (err) {
        // The one piece of I/O here that can fail AFTER a verdict. Unwrapped, a
        // single busy database threw out of this loop and took the report and
        // every remaining binding's warning with it.
        report.failed += 1;
        logger.warn('[rooms] could not write the repair for a room binding', {
          roomId: binding.roomId,
          authorId: binding.authorId,
          deadSessionId: binding.sessionId,
          canonicalSessionId: successor,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (moved) {
        report.repaired += 1;
        logger.info('[rooms] repaired a room binding that pointed at a renamed session', {
          roomId: binding.roomId,
          authorId: binding.authorId,
          deadSessionId: binding.sessionId,
          canonicalSessionId: successor,
        });
        continue;
      }
      // The store refused: the successor is itself retired, so nothing moved and
      // the room is still stranded. Saying "repaired" here would be a lie the
      // report told about a row it had not touched.
      report.refused += 1;
      logger.warn(
        '[rooms] could not repair a room binding — the id that replaced its session is retired too',
        {
          roomId: binding.roomId,
          authorId: binding.authorId,
          agentPath,
          deadSessionId: binding.sessionId,
          refusedSessionId: successor,
        }
      );
      continue;
    }

    report.stranded += 1;
    // The one line the 2026-07-31 incident never got. Everything needed to find
    // the lost conversation by hand is in it, and the binding is left alone so
    // it can still be corrected once it is found.
    logger.warn(
      '[rooms] a room is bound to a session with no transcript, so this agent will start over here',
      {
        roomId: binding.roomId,
        authorId: binding.authorId,
        agentPath,
        deadSessionId: binding.sessionId,
      }
    );
  }
  // A sweep that judged nothing has to say so. Silence here is indistinguishable
  // from "every room is fine", and the one condition that produces it —
  // `~/.claude/projects` unreadable, so every probe throws — is exactly the
  // condition under which every room in the install has lost its memory.
  if (report.checked === 0 && report.unreadable > 0) {
    logger.warn(
      `[rooms] checked 0 of ${report.unreadable} room bindings — their transcripts could not be read`,
      { unreadable: report.unreadable }
    );
  }
  return report;
}
