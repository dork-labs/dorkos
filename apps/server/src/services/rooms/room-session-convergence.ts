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
 * **Repairing what is already stranded.** The bindings written before this
 * existed point at ids no transcript will ever be under. Nothing errors: the
 * next message probes for a transcript, finds none, reports `hasStarted: false`,
 * and the agent starts over from nothing — every time, silently, forever. The
 * sweep cannot invent the session that was lost, and it does not try; it repairs
 * what it can prove and says the rest out loud, with the room, the agent and the
 * dead id in the line.
 *
 * Nothing here deletes a binding. A binding pointing somewhere useless is a
 * conversation whose transcript may still be found by hand; a deleted one is a
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
  /** Bindings examined — claude-code agents with a binding, and nothing else. */
  checked: number;
  /** Bindings moved onto a canonical id this process knew the successor for. */
  repaired: number;
  /** Bindings left pointing at an id with no transcript and no known successor. */
  stranded: number;
}

/**
 * Sweep every room binding for one that points at a session with no transcript,
 * repairing what can be proved and warning about the rest.
 *
 * Scoped hard, because it runs at startup and startup is not the place to walk a
 * disk: only rooms that HAVE a binding (the table is the input, not the room
 * list), and only bindings whose agent runs on claude-code — the one runtime
 * that renames a session out from under its caller. Codex, OpenCode and
 * test-mode all return `undefined` from `getInternalSessionId`, so their ids
 * never moved and there is nothing to repair.
 *
 * A binding with no transcript is repaired only when the store can NAME its
 * successor — an id it watched a rekey retire. Anything else would be a guess:
 * picking "the newest transcript in this agent's directory" would silently graft
 * one room's conversation onto another's, which is worse than the amnesia it is
 * trying to cure. So the rest are logged at warn, with everything a person needs
 * to find the transcript by hand, and left exactly where they are.
 *
 * Never throws. A probe that fails is a binding this sweep says nothing about,
 * not a server that will not start.
 *
 * @param deps - The store, the agent lookup and the transcript probe.
 */
export async function repairRoomSessionBindings(
  deps: RoomBindingRepairDeps
): Promise<RoomBindingRepairReport> {
  const report: RoomBindingRepairReport = { checked: 0, repaired: 0, stranded: 0 };
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
    let runtimeType: string;
    try {
      runtimeType = await resolveRoomRuntimeType(agentPath);
    } catch {
      continue;
    }
    if (runtimeType !== CLAUDE_CODE_RUNTIME) continue;

    report.checked += 1;
    let exists: boolean;
    try {
      exists = await deps.hasTranscript(agentPath, binding.sessionId);
    } catch (err) {
      logger.debug('[rooms] could not probe a room session for its transcript', {
        roomId: binding.roomId,
        authorId: binding.authorId,
        sessionId: binding.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (exists) continue;

    const successor = deps.store.sessionLedger.successorFor(binding.sessionId);
    if (successor !== undefined) {
      deps.store.rebindRoomSession(binding.roomId, binding.authorId, successor);
      report.repaired += 1;
      logger.info('[rooms] repaired a room binding that pointed at a renamed session', {
        roomId: binding.roomId,
        authorId: binding.authorId,
        deadSessionId: binding.sessionId,
        canonicalSessionId: successor,
      });
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
  return report;
}
