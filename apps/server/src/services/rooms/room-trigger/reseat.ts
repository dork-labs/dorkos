/**
 * Where the room dispatcher moves an agent's seat to a fresh session (Re-seat
 * P0), so a seat whose account runs out keeps answering with nobody involved.
 *
 * Two moments, both through the server's {@link RoomSeatMover}, and both while
 * the turn's claim is still HELD:
 *
 * - **Before a turn** ({@link prepareSeat}): the seat's pending launch from an
 *   earlier move, else a move for a seat whose transcript expired or whose
 *   account is nearly out. The turn then runs on the new seat.
 * - **After a turn failed on a usage limit** ({@link reseatAfterLimit}): move
 *   once per message and answer the same message again on the new seat. The
 *   re-run goes back through the collector exactly as a busy retry does, so its
 *   ceiling is rebuilt from the same entries (Security Must 3). No account
 *   left: today's out-of-usage line, with the soonest reset, once.
 *
 * **Why the claim stays held through the move.** A move reads accounts and
 * summarises the old chat, which takes seconds. With the claim released, a new
 * message could claim the old seat and move it a second time, a person's move
 * could land in between, and the re-run could find its cursor walked past. Held,
 * a new message parks behind it, a by-hand move is refused as `AGENT_WORKING`,
 * and the re-run itself parks until this turn releases (park-and-resume, RP8).
 *
 * Neither ever blocks a turn: a mover that throws is logged, and the room does
 * what it did before re-seating existed.
 *
 * @module server/services/rooms/room-trigger/reseat
 */
import type { ReseatOptions, Room, RoomEntry } from '@dorkos/shared/room-schemas';
import { logger } from '../../../lib/logger.js';
import { agentKey, type TriggerTarget } from '../room-claims.js';
import { RoomError } from '../room-errors.js';
import { buildAgentReseatedNotice } from '../notices/notice-copy.js';
import { usageLimitNow } from '../notices/usage-limit.js';
import type { RoomTurnReply } from '../room-turn-port.js';
import type { PendingLaunch, Seat, SeatMove } from '../reseat/seat-mover.js';
import type { RoomTriggerDispatcher } from '../room-trigger.js';

/** What a turn launches with after a move: the account to start on and the summary. */
export type SeatLaunch = Pick<PendingLaunch, 'accountHint' | 'seedContext'>;

/**
 * Re-runs that CONTINUE a message the failed turn had already posted to, per
 * dispatcher, keyed `room · agent · entry`. Such a re-run may rightly say
 * nothing more, and the room must not then call that a decline.
 */
const continuations = new WeakMap<RoomTriggerDispatcher, Set<string>>();

function continuationKey(roomId: string, authorId: string, entryId: string): string {
  return `${roomId}\u0000${authorId}\u0000${entryId}`;
}

/**
 * Whether this delivery is a re-run continuing a message its agent already
 * answered in part, taken (so it counts once). `deliver` reads it before
 * writing "did not reply".
 *
 * @param roomId - The room.
 * @param authorId - The agent.
 * @param entryId - The message.
 */
export function takeContinuation(
  self: RoomTriggerDispatcher,
  roomId: string,
  authorId: string,
  entryId: string
): boolean {
  return continuations.get(self)?.delete(continuationKey(roomId, authorId, entryId)) === true;
}

function seatOf(room: Room, target: TriggerTarget): Seat {
  return {
    roomId: room.id,
    authorId: target.authorId,
    agentPath: target.agentPath,
    sessionId: target.sessionId,
  };
}

/** Whether a room's lines and a moved agent's summary must name no account (Must 7). */
function hideAccountsIn(self: RoomTriggerDispatcher, roomId: string): boolean {
  try {
    return self.deps.roomHasOutsiders?.(roomId) ?? true;
  } catch {
    // Unknown is outside.
    return true;
  }
}

/**
 * Write the room's one quiet line for a move. Accounts are named only when the
 * room has nobody from outside (Security Must 7); a room the dispatcher cannot
 * read is treated as having outsiders.
 *
 * @param room - The room.
 * @param entry - The message the move answers, or `null` for a move by hand.
 * @param agent - The agent whose seat moved.
 * @param move - The move.
 */
export function announceMove(
  self: RoomTriggerDispatcher,
  room: Room,
  entry: RoomEntry | null,
  agent: { authorId: string; displayName: string },
  move: SeatMove
): void {
  self.notices.reportReseat(
    room,
    entry,
    buildAgentReseatedNotice(
      agent.displayName,
      agent.authorId,
      move.reason,
      hideAccountsIn(self, room.id)
    )
  );
}

/**
 * Settle which session a turn runs on, moving the seat first when it must.
 * Updates `target.sessionId` to the seat's session, so the turn, its rebind and
 * any limit read after it all name the same one. The launch is read, not
 * spent: {@link settleSeatLaunch} spends it once the turn has launched.
 *
 * @param room - The room.
 * @param entry - The message the turn answers.
 * @param target - The claimed turn; its `sessionId` may change.
 * @returns What the launch carries, empty when nothing moved.
 */
export async function prepareSeat(
  self: RoomTriggerDispatcher,
  room: Room,
  entry: RoomEntry,
  target: TriggerTarget
): Promise<SeatLaunch> {
  const mover = self.deps.seatMover?.() ?? null;
  if (mover === null) return {};
  try {
    let launch = mover.pendingLaunch(room.id, target.authorId, target.sessionId);
    if (launch === undefined) {
      const move = await mover.beforeTurn(seatOf(room, target), entry.id, {
        hideAccounts: hideAccountsIn(self, room.id),
      });
      if (move !== null) {
        target.sessionId = move.newSessionId;
        announceMove(self, room, entry, target, move);
        launch = mover.pendingLaunch(room.id, target.authorId, move.newSessionId);
      }
    }
    return launchOf(launch);
  } catch (err) {
    logger.warn('[rooms] could not check whether a seat should move; running it where it is', {
      roomId: room.id,
      authorId: target.authorId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

/**
 * A moved seat's launch, for a turn that does not go through
 * {@link prepareSeat} (the welcome-back aside): read, never moved for.
 *
 * @param roomId - The room.
 * @param authorId - The agent.
 * @param sessionId - The session the turn runs on.
 */
export function pendingSeatLaunch(
  self: RoomTriggerDispatcher,
  roomId: string,
  authorId: string,
  sessionId: string
): SeatLaunch {
  return launchOf(self.deps.seatMover?.()?.pendingLaunch(roomId, authorId, sessionId));
}

/**
 * A turn ran on this session, so a pending launch for it is spent. Called for
 * every turn that was not refused as busy before it launched.
 *
 * @param roomId - The room.
 * @param authorId - The agent.
 * @param sessionId - The session the turn ran on.
 */
export function settleSeatLaunch(
  self: RoomTriggerDispatcher,
  roomId: string,
  authorId: string,
  sessionId: string
): void {
  self.deps.seatMover?.()?.settleLaunch(roomId, authorId, sessionId);
}

function launchOf(launch: PendingLaunch | undefined): SeatLaunch {
  if (launch === undefined) return {};
  return {
    ...(launch.accountHint !== undefined ? { accountHint: launch.accountHint } : {}),
    ...(launch.seedContext !== undefined ? { seedContext: launch.seedContext } : {}),
  };
}

/**
 * Put the agent's read cursor back where it stood before the failed turn, so
 * the re-run reads the message again (the collector drops a message the agent
 * has read past). The claim moved the cursor to the message, and a turn that
 * posted before it failed moved it on to its own post; either is this turn's
 * own doing and is walked back. Anything else means another turn has read on
 * since, and the cursor stays (compare-and-set, as `rewindReadCursor` is).
 */
function rewindForRerun(
  self: RoomTriggerDispatcher,
  room: Room,
  entry: RoomEntry,
  target: TriggerTarget
): void {
  const at = self.deps.store.getMember(room.id, target.authorId)?.lastReadSeq;
  if (at === undefined || at < entry.seq) return;
  if (at !== entry.seq) {
    const [last] = self.deps.store.listEntriesBySeq(room.id, [at]);
    if (last?.authorId !== target.authorId) return;
  }
  self.deps.store.rewindReadCursor(room.id, target.authorId, { from: at, to: target.lastReadSeq });
}

/**
 * After a turn failed: when its account ran out, move the seat and answer the
 * same message again, at most once per message. Awaited while the claim is
 * held (see the module TSDoc).
 *
 * `true` means this owns what the room hears about the failure: the moved line
 * and the re-run, or the out-of-usage line with the soonest reset. `false`
 * (not a usage limit, no mover, this message already moved the seat, or a seat
 * a move does not apply to) leaves `deliver` to report as it always has.
 *
 * The failed turn's posting mark decides the re-run's job: a turn that already
 * posted is CONTINUED, never answered again, and if the re-run then says
 * nothing more that is not a decline ({@link takeContinuation}).
 *
 * @param room - The room.
 * @param entry - The message the failed turn was answering.
 * @param target - The failed turn.
 * @param reply - What the turn came back with.
 */
export async function reseatAfterLimit(
  self: RoomTriggerDispatcher,
  room: Room,
  entry: RoomEntry,
  target: TriggerTarget,
  reply: RoomTurnReply
): Promise<boolean> {
  if (reply.unanswered !== 'failed') return false;
  const mover = self.deps.seatMover?.() ?? null;
  if (mover === null) return false;
  const limit = usageLimitNow(
    self.deps.usageLimitFor,
    self.deps.store.getRoomSession(room.id, target.authorId) ?? target.sessionId
  );
  if (
    limit === null ||
    !mover.mayMoveFor({ roomId: room.id, authorId: target.authorId }, entry.id)
  ) {
    return false;
  }
  const alreadyPosted = self.takeSpokeViaTool(room.id, target.authorId);
  self.takeReactedViaTool(room.id, target.authorId);
  let result: Awaited<ReturnType<typeof mover.afterLimit>>;
  try {
    result = await mover.afterLimit(seatOf(room, target), entry.id, {
      alreadyPosted,
      hideAccounts: hideAccountsIn(self, room.id),
    });
  } catch (err) {
    logger.warn('[rooms] could not move a seat whose account ran out', {
      roomId: room.id,
      authorId: target.authorId,
      entryId: entry.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  if (result.kind === 'cannot-move' || result.kind === 'already-moved') return false;
  self.receipts.forgetRetry(room.id, target.authorId, entry.id);
  if (result.kind === 'none') {
    self.notices.reportSilence(room, entry, target, 'failed', target.dispatchId, {
      outOfUsageUntil: result.earliestResetAt ?? limit.resetsAt,
      noOtherAccount: true,
    });
    return true;
  }
  announceMove(self, room, entry, target, result.move);
  // Somebody pressed Stop while the seat moved: the move stands and is said,
  // and nothing answers.
  if (self.wasHalted(target.dispatchId)) return true;
  if (alreadyPosted) {
    let pending = continuations.get(self);
    if (pending === undefined) continuations.set(self, (pending = new Set()));
    pending.add(continuationKey(room.id, target.authorId, entry.id));
  }
  rewindForRerun(self, room, entry, target);
  self.retryNow(room.id, entry.id, target);
  return true;
}

/**
 * Move an agent's seat by hand to another account (`rooms.reseat`), writing
 * the room's line. The caller has already checked who may ask.
 *
 * @param room - The room.
 * @param agent - The agent whose seat moves.
 * @param byAuthorId - Who asked, named in the line.
 * @param accountId - The account to move to; the best one when absent.
 * @returns The seat's new session.
 * @throws {RoomError} `AGENT_WORKING` while it answers here; `NOTHING_TO_MOVE`
 *   before it has answered here at all; `NO_ACCOUNT_LEFT` when no account it
 *   may use can take it.
 */
export async function reseatByHand(
  self: RoomTriggerDispatcher,
  room: Room,
  agent: { authorId: string; agentPath: string; displayName: string },
  byAuthorId: string,
  accountId: string | undefined
): Promise<{ sessionId: string }> {
  if (self.claimed.has(agentKey(room.id, agent.authorId))) {
    throw new RoomError(
      'AGENT_WORKING',
      `${agent.displayName} is answering here right now. Move it when it's done.`
    );
  }
  const mover = self.deps.seatMover?.() ?? null;
  const move =
    mover === null
      ? null
      : await mover.byHand(
          {
            roomId: room.id,
            authorId: agent.authorId,
            agentPath: agent.agentPath,
            sessionId: self.deps.store.getRoomSession(room.id, agent.authorId),
          },
          {
            ...(accountId !== undefined ? { accountId } : {}),
            by: self.notices.nameOf(byAuthorId),
            hideAccounts: hideAccountsIn(self, room.id),
          }
        );
  if (move === 'nothing-to-move') {
    throw new RoomError(
      'NOTHING_TO_MOVE',
      `${agent.displayName} hasn't answered here yet, so there's nothing to move.`
    );
  }
  if (move === null) throw new RoomError('NO_ACCOUNT_LEFT', 'No other account has usage left.');
  announceMove(self, room, null, agent, move);
  return { sessionId: move.newSessionId };
}

/**
 * The accounts a person may move an agent's seat to, for the picker.
 *
 * @param room - The room.
 * @param agent - The agent whose seat would move.
 */
export async function reseatOptionsFor(
  self: RoomTriggerDispatcher,
  room: Room,
  agent: { authorId: string; agentPath: string }
): Promise<ReseatOptions> {
  const sessionId = self.deps.store.getRoomSession(room.id, agent.authorId);
  const seated = sessionId !== null;
  const mover = self.deps.seatMover?.() ?? null;
  if (mover === null) return { current: null, accounts: [], seated };
  const { current, accounts } = await mover.options({
    roomId: room.id,
    authorId: agent.authorId,
    agentPath: agent.agentPath,
    sessionId,
  });
  return {
    seated,
    current: current.id === null ? null : { id: current.id, label: current.label },
    accounts: accounts.map((row) => ({
      id: row.id,
      label: row.label,
      color: row.color,
      eligible: row.eligible,
      reason: row.reason,
    })),
  };
}
