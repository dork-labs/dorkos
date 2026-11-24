/** Admission-bound new-work recovery; no current-turn replay and no second fallback. */
import { carryFrom, joinCeilings } from '../handoff/seat-carry.js';
import { failedSeatLedger, failedTurnCarry } from '../reseat/failed-seat-record.js';
import { getAccountUsageStore } from '../../core/usage/current-usage-store.js';
import type { AsideCarry } from './aside.js';
import { logRecoveredHandoff } from '../handoff/failure-trace.js';
import { stat } from 'node:fs/promises';
import { claudeTranscriptPath } from '../../session/fleet/carry-over-summary.js';
import type { RecoveryAuthority } from '../reseat/required-launch-store.js';
import type { SeatMove } from '../reseat/seat-mover.js';
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
  const ledger = failedSeatLedger();
  // A record an earlier process kept is what a restored authority answers to (DOR-4626), so it
  // decides the path, never whether this process happens to hold some level for the chat: a
  // level recorded here without the failed turn behind it must not stand in for that turn's.
  // Restored, the record's carry joins whatever the chat carries now, and both only add.
  const restored = read(() => ledger?.restore(old) ?? null);
  const live = failedTurnCarry(old, input.agentPath);
  const preserved: AsideCarry | null = restored
    ? joinRecoveryCarry(restored.carry, live ?? carryFrom(old, input.agentPath))
    : live;
  if (!preserved) return false;
  const currentAllowed = () => {
    const room = self.deps.store.getRoom(input.room.id);
    const member = self.deps.store.getMember(input.room.id, input.authorId);
    const claim = self.claimed.get(input.key);
    const budget = self.deps.budget.remaining(input.room.id);
    return (
      !!room &&
      !room.archived &&
      !!member &&
      input.validateTarget?.() !== false &&
      claim?.dispatchId === input.dispatchId &&
      !self.wasHalted(input.dispatchId) &&
      self.deps.store.getRoomSession(input.room.id, input.authorId) === old &&
      (input.admissionDeadlineAt === undefined || Date.now() < input.admissionDeadlineAt) &&
      budget.room !== 0 &&
      budget.global !== 0
    );
  };
  const mover = self.deps.seatMover?.() ?? getRoomSeatMover();
  // One recovery per failure: a durable record is spent before the attempt, so a restart in
  // the middle of it can never start another. The candidate refuses a restored authority
  // without this claim. Usage not yet read since boot is a wait, not a reason to spend it.
  if (
    restored &&
    (!currentAllowed() ||
      getAccountUsageStore()?.peekByRoot('claude-code', restored.root)?.state !== 'ok' ||
      !spend(() => ledger?.claim(old) === true))
  )
    return false;
  let moved: SeatMove | null | undefined;
  try {
    moved = await mover?.recoverFailedSeat(
      {
        roomId: input.room.id,
        authorId: input.authorId,
        agentPath: input.agentPath,
        sessionId: old,
      },
      input.entry.id,
      currentAllowed
    );
  } finally {
    if (restored) ledger?.endClaim(old);
  }
  if (!moved) return false;
  // The seat has moved, so its old chat's record is spent whichever process kept it.
  spend(() => {
    ledger?.consume(old);
    return true;
  });
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
  input.onSeatRecovered?.(old, moved.newSessionId);
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

/** A ledger write that cannot complete reads as refused; storage loss never grants a retry. */
function spend(write: () => boolean): boolean {
  try {
    return write();
  } catch {
    return false;
  }
}

/** A ledger read that cannot complete restores nothing. */
function read<T>(load: () => T | null): T | null {
  try {
    return load();
  } catch {
    return null;
  }
}

/** Keep every actual source bound while joining current carried provenance. */
function joinRecoveryCarry(prior: AsideCarry, current?: AsideCarry): AsideCarry {
  const ceiling = joinCeilings(prior.permissionCeiling, current?.permissionCeiling);
  return {
    externalAuthor: prior.externalAuthor || current?.externalAuthor === true,
    ...(ceiling !== undefined ? { permissionCeiling: ceiling } : {}),
    ...(prior.teammate || current?.teammate ? { teammate: true as const } : {}),
    ...(prior.outsider || current?.outsider ? { outsider: true as const } : {}),
    ...(prior.outsideWords || current?.outsideWords ? { outsideWords: true as const } : {}),
  };
}
