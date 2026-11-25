/**
 * A hand-off its busy room chat has not taken in time, posted for that chat (DOR-4252).
 *
 * A hand-off used to wait up to an hour for a room chat busy with a long turn, and could then end
 * with only "it stayed busy for an hour". Now the room chat gets {@link HANDOFF_SEAT_WAIT_MS},
 * counted from when the draft was accepted. If it has not taken the hand-off as its own turn by
 * then, and nothing has been said in the room since the draft was written, DorkOS posts the draft
 * as written, as the agent, with the line that says where it came from.
 *
 * **Why a post for the room chat, not a second turn in it.** A busy room chat cannot take a turn:
 * the room's one-turn-per-agent claim is held, or the runtime refuses the chat while background
 * work runs. Posting a draft that is still current needs no model. The post goes through
 * {@link RoomPosting.postStandIn}, which is `postFromTool`'s checks without the live turn, and it
 * binds the hand-off's saved record in the same transaction, so it lands once or not at all.
 *
 * **Only a draft that is still current, and only one the drafting chat could vouch for.** At
 * acceptance the hand-off records what the drafting chat had itself read of the room
 * (`chatSeenThroughSeq`). A stand-in posts only when no post has landed there since, by anyone,
 * the agent's own room chat included. Otherwise the draft stays with the room chat, which re-reads
 * the room when it is free and posts it or says why not (the 0.126.4 rule: a second chat of one
 * agent must not bring back a plan the room has moved past). Three drafts never get a stand-in, and
 * the receipt says so at once: one whose chat read words from outside the team (scenario E), one
 * whose chat's reads DorkOS could not confirm, and one whose chat never read the room.
 *
 * @module server/services/rooms/handoff/seat-stand-in
 */
import { newDispatchId } from '@dorkos/shared/dispatch-id';
import type { TurnPermissionBound } from '@dorkos/shared/agent-runtime';
import { logger } from '../../../lib/logger.js';
import { mergeMarks, NO_MARKS, type TurnMarks } from '../../core/turn-power/turn-marks.js';
import { agentPause } from '../../mesh/pause/agent-pause.js';
import { chatSeenThroughSeq } from '../messages/room-freshness.js';
import type { RoomPosting } from '../messages/room-posting.js';
import { RoomError } from '../room-errors.js';
import type { AsideCarry } from '../room-trigger/aside.js';
import type { RoomCore } from '../service/room-core.js';
import {
  renderPostedHandoff,
  type HandoffOutcome,
  type HandoffStandIn,
  type RoomHandoff,
} from './handoff-presentation.js';

/** How long a room chat gets to take a hand-off as its own turn, from when it was accepted. */
export const HANDOFF_SEAT_WAIT_MS = 2 * 60_000;

/** What a stand-in post needs from the room service beyond the shared state. */
export interface SeatStandInPort {
  /** The posting door, with every check the room chat's own post gets. */
  post: RoomPosting['postStandIn'];
}

/** The hand-off's owner, for the durable record and the end notice. */
interface StandInOwner {
  /** This process's claim on the hand-off's record. */
  bootOwner: string;
  /** Whether the room, the membership and the room chat are still the ones it was accepted for. */
  targetCurrent: () => boolean;
  /** The notice the sender gets once it is posted. */
  postedNotice: string;
}

/** How a stand-in ended: posted, declined with a reason, or kept for the room chat. */
export type StandInResult = HandoffOutcome | { kept: true };

const GONE = 'it is no longer in that room, or its room chat changed.';
const NOT_POSTED = "it couldn't be posted while its room chat was busy. Send it again.";
/** The most posts a currency check reads past the draft's floor before it calls the room moved. */
const CURRENCY_SCAN = 50;
/** Posts this module made, by the chat whose draft each was, so that chat's next draft is current. */
const postedFor = new Map<string, string>();
const POSTED_FOR_MAX = 5_000;

/**
 * The marks a hand-off saved from the chat that wrote it, as a post keeps them: the outsider mark
 * when outside words reached that chat, and every teammate its ceiling names.
 *
 * @param carried - What the drafting chat's turn carried.
 */
function marksOfCarry(carried: AsideCarry): TurnMarks {
  const ceiling = carried.permissionCeiling;
  const bounds: readonly TurnPermissionBound[] =
    ceiling === undefined
      ? []
      : Array.isArray(ceiling)
        ? ceiling
        : [ceiling as TurnPermissionBound];
  const outside = carried.externalAuthor || carried.outsider || carried.outsideWords;
  return bounds.reduce<TurnMarks>(
    (marks, bound) => (typeof bound === 'object' ? mergeMarks(marks, bound) : marks),
    outside ? { outsider: true } : NO_MARKS
  );
}

/**
 * Whether this hand-off may ever be posted for its room chat, decided once at acceptance.
 *
 * @param handoff - The hand-off just admitted.
 * @param acceptedAt - When it was accepted; the room chat's wait counts from here.
 * @returns The stand-in's window and the room as the drafting chat had read it, or why none.
 */
export function standInFor(handoff: RoomHandoff, acceptedAt: number): HandoffStandIn {
  // Conservative evidence marks a chat as outside-marked because nothing was recorded; say that.
  if (handoff.admission.wordEvidence !== 'recorded') return { refused: 'unconfirmed' };
  if (marksOfCarry(handoff.carried).outsider === true) return { refused: 'outside-words' };
  const freshThroughSeq = chatSeenThroughSeq(handoff.admission.callerSessionId, handoff.roomId);
  if (freshThroughSeq === undefined) return { refused: 'unread' };
  return {
    until: Math.min(acceptedAt + HANDOFF_SEAT_WAIT_MS, handoff.waitDeadlineAt),
    freshThroughSeq,
  };
}

/** Whether a post landed in the room after the draft's floor, other than this chat's own. */
function roomMovedOn(core: RoomCore, handoff: RoomHandoff, freshThroughSeq: number): boolean {
  const since = core.store.listEntries(handoff.roomId, {
    afterSeq: freshThroughSeq,
    limit: CURRENCY_SCAN,
  });
  const drafter = handoff.admission.callerSessionId;
  const posted = since.some(
    (entry) => entry.kind === 'post' && postedFor.get(entry.id) !== drafter
  );
  return posted || since.length === CURRENCY_SCAN;
}

/** Why the stand-in refused, or `kept` for an error it can't name: the room chat still has it. */
function refusalOf(error: unknown): StandInResult {
  const code = error instanceof RoomError ? error.code : undefined;
  if (code === 'TURN_WAS_STOPPED') return { posted: false, reason: 'somebody stopped it.' };
  if (code === 'ROOM_ARCHIVED') return { posted: false, reason: 'the room is archived.' };
  if (code === 'ROOM_NOT_FOUND' || code === 'MEMBER_NOT_FOUND')
    return { posted: false, reason: GONE };
  return { kept: true };
}

/** Whether a pause holds this agent, read by its home and, as a second guard, by its room chat. */
function paused(handoff: RoomHandoff): boolean {
  const pauses = agentPause();
  if (!pauses) return false;
  const forAgent = handoff.admission.agentPath;
  return (
    pauses.pausedAgentOfTurn({ forAgent }) !== undefined ||
    pauses.pausedAgentOfSession(handoff.ownedSeatSessionId, () => forAgent) !== undefined
  );
}

/**
 * Post a hand-off for its busy room chat, keep it for that chat, or say why not. Synchronous end
 * to end, so nothing else can move the hand-off's record between the checks and the post. Every
 * throw is caught: a named refusal declines it, and anything else keeps it for the room chat.
 *
 * @param core - The room service's shared state.
 * @param port - The posting door.
 * @param handoff - The hand-off whose room chat did not take it in time.
 * @param owner - This process's ownership of it.
 * @returns How it ended; a refusal leaves the record for the caller to decline.
 */
export function postForBusySeat(
  core: RoomCore,
  port: SeatStandInPort,
  handoff: RoomHandoff,
  owner: StandInOwner
): StandInResult {
  const scope = handoff.standIn;
  if (scope === undefined || 'refused' in scope) return { kept: true };
  const outbox = core.store.handoffOutbox;
  const dispatchId = newDispatchId();
  try {
    const room = core.store.getRoom(handoff.roomId);
    if (room === null || room.archived) return { posted: false, reason: 'the room is archived.' };
    // A pause holds every turn of the agent's, and this post speaks for one (M2).
    if (paused(handoff)) return { posted: false, reason: 'it is paused.' };
    if (!owner.targetCurrent()) return { posted: false, reason: GONE };
    if (roomMovedOn(core, handoff, scope.freshThroughSeq)) return { kept: true };
    const now = Date.now();
    const row = outbox.readOwned(handoff.id, handoff.authorId);
    if (row?.state === 'queued') {
      outbox.claimQueued(handoff.id, handoff.envelopeJson, owner.bootOwner, now, () => {
        if (!owner.targetCurrent()) throw new Error('Handoff target changed before its claim.');
      });
    } else if (row?.state !== 'preparing' && row?.state !== 'running') {
      return { posted: false, reason: NOT_POSTED };
    }
    outbox.markRunning(handoff.id, owner.bootOwner, dispatchId, now);
    const rendered = renderPostedHandoff(handoff, { text: handoff.draft });
    const entry = port.post(
      handoff.roomId,
      {
        authorId: handoff.authorId,
        text: rendered.text,
        ...(rendered.replyTo !== undefined ? { replyTo: rendered.replyTo } : {}),
        vouching: [handoff.admission.callerSessionId, handoff.ownedSeatSessionId],
        carriedMarks: marksOfCarry(handoff.carried),
        dispatchId,
      },
      (entryId, tx, seq) => {
        if (!owner.targetCurrent()) throw new Error('Handoff no longer owns this post.');
        outbox.postedBinder(
          handoff.id,
          owner.bootOwner,
          dispatchId,
          entryId,
          owner.postedNotice
        )(tx, seq);
      }
    );
    postedFor.set(entry.id, handoff.admission.callerSessionId);
    if (postedFor.size > POSTED_FOR_MAX) postedFor.delete(postedFor.keys().next().value!);
    return { posted: true, entryId: entry.id };
  } catch (error) {
    // Server diagnostics stay in the local log, never in the shared reason.
    logger.warn('[rooms] a hand-off for a busy room chat was not posted', {
      roomId: handoff.roomId,
      authorId: handoff.authorId,
      cause:
        error instanceof RoomError ? error.code : error instanceof Error ? error.name : 'unknown',
    });
    return refusalOf(error);
  }
}
