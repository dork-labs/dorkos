import { carryFrom } from '../handoff/seat-carry.js';
import { lastTurnLevelOf } from '../../core/turn-power/turn-levels.js';
import type { AsideCarry } from './aside.js';
import type { TurnPermissionBound } from '@dorkos/shared/agent-runtime';
import { logRecoveredHandoff } from '../handoff/failure-trace.js';
import { stat } from 'node:fs/promises';
import { claudeTranscriptPath } from '../../session/fleet/carry-over-summary.js';
import type { RecoveryAuthority } from '../reseat/required-launch-store.js';
/** Admission-bound new-work recovery; no current-turn replay and no second fallback. */
import { getRoomSeatMover } from '../reseat/create-seat-mover.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import type { AsideRun } from './aside.js';
import type { RoomTriggerDispatcher } from '../room-trigger.js';
import { announceMove } from './reseat.js';

/** Attempt recovery only before this handoff has started work on its old session. */
export async function prepareFailedHandoffSeat(
  self: RoomTriggerDispatcher,
  input: AsideRun
): Promise<boolean> {
  if (!input.handoffRecovery) return false;
  const old = input.sessionId;
  // The old turn's positively recorded effective bounds survive its first fresh turn.
  // Outside-word provenance alone does not manufacture a permission ceiling.
  const prior = carryFrom(old, input.agentPath);
  const level = lastTurnLevelOf(old);
  if (!level) return false;
  const preserved: AsideCarry = { ...prior, ...(level ? { permissionCeiling: level } : {}) };
  const currentAllowed = () => {
    const room = self.deps.store.getRoom(input.room.id);
    const member = self.deps.store.getMember(input.room.id, input.authorId);
    const claim = self.claimed.get(input.key);
    const budget = self.deps.budget.remaining(input.room.id);
    return (
      !!room &&
      !room.archived &&
      !!member &&
      claim?.dispatchId === input.dispatchId &&
      !self.wasHalted(input.dispatchId) &&
      self.deps.store.getRoomSession(input.room.id, input.authorId) === old &&
      (input.admissionDeadlineAt === undefined || Date.now() < input.admissionDeadlineAt) &&
      budget.room !== 0 &&
      budget.global !== 0
    );
  };
  const mover = self.deps.seatMover?.() ?? getRoomSeatMover();
  const moved = await mover?.recoverFailedSeat(
    { roomId: input.room.id, authorId: input.authorId, agentPath: input.agentPath, sessionId: old },
    input.entry.id,
    currentAllowed
  );
  if (!moved) return false;
  input.sessionId = moved.newSessionId;
  input.carried = joinRecoveryCarry(preserved, input.carried);
  const prepare = input.prepareCarry;
  if (prepare) input.prepareCarry = () => joinRecoveryCarry(preserved, prepare());
  if (input.handoffTrace) {
    const witness = runtimeRegistry.requiredLaunches().forSession(moved.newSessionId);
    Object.assign(input.handoffTrace, {
      attempt: 1,
      oldSessionId: old,
      freshSessionId: moved.newSessionId,
      sourceStartSeq: witness?.startSeq,
      sourceEndSeq: witness?.endSeq,
    });
    logRecoveredHandoff(input.handoffTrace);
  }
  self.noteSessionBound(input.room.id, input.authorId, moved.newSessionId);
  const displayName =
    self.deps.authors.getMany([input.authorId]).get(input.authorId)?.displayName ?? 'An agent';
  announceMove(self, input.room, input.entry, { authorId: input.authorId, displayName }, moved);
  return true;
}

/** An ended owned attempt must never leave permission to retry on defaults. */
export async function endFailedHandoffAttempt(
  sessionId: string,
  succeeded: boolean
): Promise<void> {
  const store = runtimeRegistry.requiredLaunches();
  try {
    const requirement = store.forSession(sessionId);
    if (requirement?.state !== 'pending' || !store.hasOwnedAttempt(sessionId)) return;
    if (succeeded) {
      const runtime = await runtimeRegistry.resolveForSession(sessionId);
      const reader = runtime as typeof runtime & {
        readObservedBilling?(
          id: string
        ): (RecoveryAuthority & { sessionId: string; cwd?: string }) | null;
      };
      const observed = reader.readObservedBilling?.(sessionId);
      const nativePath = observed?.cwd
        ? claudeTranscriptPath(observed.root, observed.cwd, observed.sessionId)
        : null;
      const file = nativePath ? await stat(nativePath) : null;
      if (observed && file?.isFile() && file.size > 0) {
        store.settleObserved(sessionId, observed);
        return;
      }
    }
    store.refuse(sessionId);
  } catch {
    // An uncertain proof stays constrained; never turn storage loss into defaults.
    try {
      store.refuse(sessionId);
    } catch {
      /* durable pending remains blocked without an owned token */
    }
  } finally {
    store.endOwnedAttempt();
  }
}

/** Keep every actual source bound while joining current carried provenance. */
function joinRecoveryCarry(prior: AsideCarry, current?: AsideCarry): AsideCarry {
  const bounds = [prior.permissionCeiling, current?.permissionCeiling].flatMap(
    (value): TurnPermissionBound[] =>
      value === undefined ? [] : Array.isArray(value) ? [...value] : [value as TurnPermissionBound]
  );
  return {
    externalAuthor: prior.externalAuthor || current?.externalAuthor === true,
    ...(bounds.length ? { permissionCeiling: bounds } : {}),
    ...(prior.teammate || current?.teammate ? { teammate: true as const } : {}),
    ...(prior.outsider || current?.outsider ? { outsider: true as const } : {}),
    ...(prior.outsideWords || current?.outsideWords ? { outsideWords: true as const } : {}),
  };
}
