/** Shared seat replacement primitive for ordinary moves and narrow failed-seat recovery. */
import { randomUUID } from 'node:crypto';
import { logger } from '../../../lib/logger.js';
import { carrySessionMarks } from '../../core/turn-power/seat-marks.js';
import type { RecoveryBirthContext } from '../../core/runtime-seam/recovery-birth-source.js';
import { reseatSettings } from '../../session/fleet/carry-over-power.js';
import type { RankedAccount } from '../../core/usage/account-ranking.js';
import type { ReseatNoticeReason } from '../notices/notice-copy.js';
import type {
  Seat,
  SeatAccount,
  SeatMoverDeps,
  SeatMove,
  ReseatTrigger,
  PendingLaunch,
} from './seat-mover.js';
import type { FailedSeatCandidate } from './failed-seat-candidate.js';
import type { RecoveryLaunchInput } from './required-launch-store.js';
/** One immutable replacement plan; recovery retains current admission through publication. */
export interface SeatReplacementPlan {
  trigger: ReseatTrigger;
  by?: string;
  entryId: string | null;
  runtime: string;
  current?: SeatAccount;
  target?: RankedAccount;
  alreadyPosted?: boolean;
  hideAccounts: boolean;
  recovery?: { candidate: FailedSeatCandidate; currentAllowed: () => boolean };
}
/** Prepare existing settings/marks then publish via ordinary rebind or atomic recovery CAS. */
export async function replaceRoomSeat(
  deps: SeatMoverDeps,
  seat: Seat,
  plan: SeatReplacementPlan,
  hooks: {
    seedFor: () => Promise<string | undefined>;
    recordSeatMove: (old: string) => void;
    pending: (launch: PendingLaunch) => void;
  }
): Promise<SeatMove> {
  const newSessionId = deps.newSessionId?.() ?? randomUUID();
  const old = seat.sessionId;
  const recovery = plan.recovery;
  let prepared: { input: RecoveryLaunchInput; birth: RecoveryBirthContext } | undefined;
  if (recovery) {
    if (old === null || !deps.requiredLaunches || !recovery.currentAllowed())
      throw new Error('Recovery admission changed.');
    const input = {
      ...recovery.candidate.authority,
      id: randomUUID(),
      destinationSessionId: newSessionId,
      sourceSessionId: old,
      sourceDispatchId: recovery.candidate.sourceDispatchId,
      startSeq: recovery.candidate.startSeq,
      endSeq: recovery.candidate.endSeq,
      roomId: seat.roomId,
      authorId: seat.authorId,
    };
    prepared = {
      input,
      birth: deps.requiredLaunches.prepareReplacement(
        input,
        seat.agentPath,
        recovery.currentAllowed
      ),
    };
  }
  const settings = old === null ? null : await deps.settingsOf(old);
  // A stored mode is the person-set level and wins; with none, the seat ran
  // at its agent's effective level, so that is what it keeps.
  const ranAt = settings?.permissionMode
    ? undefined
    : await deps.effectiveModeOf(seat, plan.runtime);
  if (recovery && !recovery.currentAllowed()) throw new Error('Recovery admission changed.');
  const replacementSettings = reseatSettings(settings, deps.declaredModes(plan.runtime), ranAt);
  let seedContext: string | undefined;
  if (recovery) {
    if (old === null || !deps.requiredLaunches || !prepared || !recovery.currentAllowed())
      throw new Error('Recovery admission changed.');
    deps.requiredLaunches.publish(prepared.input, recovery.currentAllowed, {
      birth: prepared.birth,
      settings: {
        ...replacementSettings,
        ...(settings?.fastMode !== undefined ? { fastMode: settings.fastMode } : {}),
      },
    });
    // Carry process-local marks before exposing the pending launch or yielding.
    carrySessionMarks(old, newSessionId);
    seedContext =
      'Your earlier room chat stopped on a server error. This is new work, not a retry.';
  } else {
    // Power and marks come before publication, in the same order as before.
    await deps.saveSettings(newSessionId, replacementSettings);
    if (old !== null) carrySessionMarks(old, newSessionId);
    seedContext = await hooks.seedFor();
    if (!deps.rebind(seat.roomId, seat.authorId, newSessionId))
      throw new Error('The room would not move this seat to its new session.');
  }
  if (old !== null) hooks.recordSeatMove(old);
  hooks.pending({
    sessionId: newSessionId,
    ...(plan.target ? { accountHint: plan.target.id } : {}),
    ...(seedContext ? { seedContext } : {}),
  });
  deps.recordActivity({
    trigger: plan.trigger,
    ...(plan.by !== undefined ? { by: plan.by } : {}),
    roomId: seat.roomId,
    authorId: seat.authorId,
    entryId: plan.entryId,
    fromSessionId: old,
    toSessionId: newSessionId,
    fromAccountId: plan.current?.id ?? null,
    toAccountId: plan.target?.id ?? null,
    fromAccountLabel: plan.current ? (plan.current.label ?? plan.current.id) : null,
    toAccountLabel: plan.target ? (plan.target.label ?? plan.target.id) : null,
  });
  logger.info('[rooms] moved a seat to a fresh session', {
    roomId: seat.roomId,
    authorId: seat.authorId,
    trigger: plan.trigger,
    fromSessionId: old,
    toSessionId: newSessionId,
    toAccountId: plan.target?.id ?? null,
  });
  return { newSessionId, reason: reasonOf(plan) };
}

/** The room line's reason for a move. */
function reasonOf(plan: {
  trigger: ReseatTrigger;
  by?: string;
  current?: SeatAccount;
  target?: RankedAccount;
}): ReseatNoticeReason {
  const to = plan.target ? (plan.target.label ?? plan.target.id) : '';
  const from = plan.current ? (plan.current.label ?? plan.current.id) : null;
  switch (plan.trigger) {
    case 'failed':
      return { kind: 'failed' };
    case 'stranded':
      return { kind: 'stranded' };
    case 'limit':
      return { kind: 'limit', from, to };
    case 'nearly-out':
      return { kind: 'nearly-out', from, to };
    case 'person':
      return { kind: 'by-hand', by: plan.by ?? 'Somebody', to };
  }
}
