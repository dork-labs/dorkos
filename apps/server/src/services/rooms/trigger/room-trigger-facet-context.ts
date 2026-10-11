import type { TurnReceipts } from '../receipts/turn-receipts.js';
import type {
  Room,
  RoomEntry,
  RoomHeldBehind,
  RoomPresenceState,
  RoomWorkingClaim,
} from '@dorkos/shared/room-schemas';
import type { SessionActivity } from '@dorkos/shared/session-stream';
import type { InterruptReceipt } from '@dorkos/shared/types';
import type { ActiveClaim, ClaimBusy, ClaimOutcome, HeldRecord, HoldEnd } from '../room-claims.js';
import type { RoomCollection, RoomCollector } from '../room-collect.js';
import type { RoomNoticeLog } from '../notices/notice-log.js';
import type { CascadeRefusalReason } from '../cascade-guard.js';
import type { RoomTriggerDeps, isEntryAuthorExternal, ceilingForEntries } from '../room-trigger.js';
import type { RoomStore } from '../room-store.js';
import type { RoomTurnBudget } from '../limits/turn-budget.js';
import type { RoomTurnReply, LateRoomReply, RoomTurnRequest } from '../room-turn-port.js';
import type { RoomTurnRunner } from '../room-turn-port.js';
import type { RoomTurnPlace, RoomTurnLaunch } from '../repo/room-turn-place.js';
import type { TriggerTarget } from '../room-claims.js';

/** Exact live original Trigger fields and dynamic method captures, resolved only by its private constructor key. */
export interface OriginalRoomTriggerFacetView {
  readonly isEntryAuthorExternal: typeof isEntryAuthorExternal;
  readonly ceilingForEntries: typeof ceilingForEntries;
  readonly deps: RoomTriggerDeps;
  readonly claimed: Map<string, ActiveClaim>;
  readonly held: Map<string, HeldRecord>;
  readonly collector: RoomCollector;
  readonly notices: RoomNoticeLog;
  readonly receipts: TurnReceipts;
  readonly haltedTurns: Set<string>;
  readonly stoppedHere: Map<string, { roomId: string; authorId: string }>;
  readonly originalDispatch: Readonly<{
    store: RoomStore;
    runner: RoomTurnRunner;
    budget: RoomTurnBudget;
  }>;
  associateOriginalRequest(request: RoomTurnRequest, dispatchId: string): void;
  launchStepFor(
    request: RoomTurnRequest,
    place: RoomTurnPlace
  ): { prepareLaunch?: (sessionId: string) => Promise<RoomTurnLaunch> };
  placeTurn(
    room: Room,
    entry: RoomEntry,
    authorId: string,
    agentPath: string,
    displayName: string,
    sessionId: string | null,
    dispatchId: string
  ): Promise<RoomTurnPlace>;
  releaseOriginalClaim(key: string, outcome: ClaimOutcome): void;
  announceCascade(
    room: Room,
    entry: RoomEntry,
    authorId: string,
    displayName: string | undefined,
    reason: CascadeRefusalReason
  ): void;
  awaitLate(late: Promise<LateRoomReply>, key: string): Promise<RoomTurnReply>;
  busyWith(roomId: string, authorId: string, agentPath: string): ClaimBusy | null;
  cascadeLimitsFor(
    roomId: string
  ): { maxAgentDepth: number; maxTurnsPerAgentPerCascade: number } | null;
  deliver(opts: {
    room: Room;
    entry: RoomEntry;
    target: TriggerTarget;
    reply: RoomTurnReply;
    late?: { waitedMs: number };
  }): ClaimOutcome;
  deliverLate(opts: {
    room: Room;
    entry: RoomEntry;
    target: TriggerTarget;
    late: Promise<LateRoomReply>;
  }): void;
  disarmActivityFlush(claim: ActiveClaim): void;
  expireHolds(): void;
  forgetHalt(dispatchId: string): void;
  headroomFor(
    roomId: string,
    depth: number | 'ceiling'
  ): {
    budget: { room: number | null; global: number | null };
    repliesLeftInThisChain: number | null;
  };
  heldBehind(record: HeldRecord): RoomHeldBehind;
  noteActivity(key: string, activity: SessionActivity | null): void;
  noteSessionBound(roomId: string, authorId: string, sessionId: string): void;
  publishActivityNow(claim: ActiveClaim): void;
  publishHold(record: HeldRecord, state: 'held' | 'done'): void;
  publishPresence(
    claim: ActiveClaim,
    state: RoomPresenceState,
    outcome?: 'answered' | 'silent'
  ): void;
  releaseHold(key: string, reason: HoldEnd): void;
  releaseOwnClaim(key: string, dispatchId: string, outcome: ClaimOutcome): void;
  reportGone(
    room: Room,
    entry: RoomEntry,
    gone: ReadonlySet<string>,
    namedUnreachable: readonly string[]
  ): void;
  reportLeft(room: Room | null, collection: RoomCollection): void;
  reportUnreachedStop(
    roomId: string,
    claim: ActiveClaim,
    sessionId: string,
    receipt: InterruptReceipt
  ): void;
  restateSiblingHolds(record: HeldRecord): void;
  resumeElsewhere(agentPath: string, from?: number): void;
  resumeFreedHolds(onlyPath?: string, from?: number): void;
  rewindClaimCursor(room: Room, entry: RoomEntry, target: TriggerTarget): void;
  settleCollection(collection: RoomCollection, reason: HoldEnd): void;
  settleOne(): void;
  takeReactedViaTool(roomId: string, authorId: string): boolean;
  takeSpokeViaTool(roomId: string, authorId: string): boolean;
  wasHalted(dispatchId: string): boolean;
  workingCount(roomId: string): number;
  workingIn(roomId: string): RoomWorkingClaim[];
}
