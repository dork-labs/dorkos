/**
 * Stop: interrupting a room's turns, or one agent's, and saying so once.
 *
 * Split out of `room-trigger.ts` without changing a line of logic. Each function
 * here is the body of a {@link RoomTriggerDispatcher} method of the same name,
 * which delegates to it with itself as `self`.
 *
 * @module server/services/rooms/room-trigger/halt
 */
import type { Room } from '@dorkos/shared/room-schemas';
import type { InterruptReceipt } from '@dorkos/shared/types';
import { logger } from '../../../lib/logger.js';
import { agentKey, type ActiveClaim } from '../room-claims.js';
import type { RoomTriggerDispatcher } from '../room-trigger.js';

/**
 * Say, in the log, that a Stop found no turn to stop (DOR-1425).
 *
 * Both halt scopes report through this one method so the sentence and its
 * fields cannot drift. It is a LOG line and not a room notice on purpose: the
 * `halted` line is already written, the claim is dropped either way, and a
 * second line saying the machinery could not reach a process is plumbing
 * aimed at whoever reads logs rather than at whoever pressed Stop.
 *
 * @param roomId - The room the stop was pressed in.
 * @param claim - The turn it was aimed at.
 * @param sessionId - The session the interrupt was sent to.
 * @param receipt - What the runtime answered; its outcome picks the sentence.
 */
export function reportUnreachedStop(
  self: RoomTriggerDispatcher,
  roomId: string,
  claim: ActiveClaim,
  sessionId: string,
  receipt: InterruptReceipt
): void {
  // Two different facts, and the boolean this replaced said the first about
  // both: `not-running` is a stop that found nothing (most often a turn still
  // booting), while `unconfirmed` / `failed` is a turn that IS there and did
  // not stop.
  const message =
    receipt.outcome === 'not-running'
      ? '[rooms] a stop found no turn to stop — it may still be starting'
      : '[rooms] a stop was not confirmed — the agent may still be working';
  logger.warn(message, {
    roomId,
    authorId: claim.authorId,
    dispatchId: claim.dispatchId,
    sessionId,
    outcome: receipt.outcome,
    ...(receipt.reason ? { reason: receipt.reason } : {}),
    runtime: receipt.runtime,
  });
}

/**
 * The body of {@link RoomTriggerDispatcher.halt}, which documents it.
 *
 * @param self - The dispatcher whose state this reads and writes.
 */
export async function halt(self: RoomTriggerDispatcher, room: Room): Promise<number> {
  self.receipts.cancelRetries(room.id);
  const claims = [...self.claimed.values()].filter((claim) => claim.roomId === room.id);
  // **Marked before anything else, and before the first `await`.** A turn
  // whose stream closes while this method is still delivering interrupts must
  // find the mark already there, or it posts the answer Stop was pressed to
  // prevent — the two-second race measured on 2026-08-15. Nothing after this
  // line can be reached by a turn that started AFTER the halt, because a new
  // turn is a new dispatch id (see {@link RoomTriggerDispatcher.haltedTurns}).
  for (const claim of claims) {
    self.haltedTurns.add(claim.dispatchId);
    // And the same statement at the pair, for the half of a turn's voice the
    // dispatch mark cannot reach: `post_to_room`
    // ({@link RoomTriggerDispatcher.stoppedHere}). Marked here rather than in
    // the release loop below for the same reason the dispatch mark is — before
    // the first `await`, so a turn that is quicker than the interrupt cannot
    // slip a post through the gap.
    self.stoppedHere.set(agentKey(room.id, claim.authorId), {
      roomId: room.id,
      authorId: claim.authorId,
    });
  }
  logger.info('[rooms] a room was halted', { roomId: room.id, stopped: claims.length });
  // **The durable write comes first, and the whole invariant is in that
  // order.** Releasing a claim publishes `done`, so a halt that stopped the
  // turns before saying so would drop every working indicator in the room a
  // beat ahead of the line explaining why — a room going quiet for no visible
  // reason, which is the exact shape `.claude/rules/room-conduct.md` forbids.
  //
  // The room's own voice speaks whether or not anything was running: pressing
  // Stop in an idle room is a question, and silence is not an answer to it.
  // Damped per room and re-armed by the next claim, so pressing it twice is
  // one line and not two. Best-effort like every other notice — a room
  // archived between the button and this line must not leave the turns
  // running — which is what routing it through the log rather than the writer
  // buys.
  self.notices.reportHalted(room, claims.length);
  // **Before the claims, and that ordering is the whole of it.** Releasing a
  // claim is what resumes a held collection, so dropping the buffers second
  // would start, one macrotask later, exactly the turns the person pressed
  // Stop to prevent — and a gathering window that nobody stopped would answer
  // a halted room half a second after it went quiet. Nothing is lost that the
  // room log does not still hold: a collection is a marker of what has not
  // been read, and the next message a person sends collects afresh.
  for (const dropped of self.collector.drop(room.id)) {
    logger.info('[rooms] a halt dropped messages that were waiting for a turn', {
      roomId: room.id,
      authorId: dropped.authorId,
      waiting: dropped.entries.length,
    });
    // Its held indicator goes with it, and the `halted` line written a few
    // lines above is its durable sibling. Stopping THIS room drops what it was
    // waiting for; stopping the room that was in the way is the opposite case
    // and runs the wait, because the person stopped one conversation and not
    // the other.
    self.settleCollection(dropped, 'halted');
  }
  for (const claim of claims) {
    try {
      // The session lookup is INSIDE the try, and it is a database read: a
      // `SQLITE_BUSY` escaping here would abandon the loop with every
      // remaining claim marked and none of them released, so a room would show
      // agents working for the life of the process and refuse each of them
      // every message after.
      const sessionId = self.deps.store.getRoomSession(room.id, claim.authorId);
      if (sessionId !== null && sessionId !== undefined) {
        const receipt = await self.deps.runner.interrupt({
          sessionId,
          agentPath: claim.agentPath,
        });
        // **The one place the room can say it could not reach an agent**
        // (DOR-1425). The answer was thrown away here, so a stop that landed
        // on nothing — a turn still booting, most often — logged exactly like
        // one that stopped a turn. The claim goes either way; what changes is
        // that an operator reading the log can tell the three apart.
        if (receipt.outcome !== 'acked' && receipt.outcome !== 'closed') {
          self.reportUnreachedStop(room.id, claim, sessionId, receipt);
        }
      }
    } catch (err) {
      // One agent that will not stop must not leave the others running, and
      // its claim is dropped either way: a claim held for a turn nobody can
      // interrupt is an indicator with nothing behind it.
      logger.warn('[rooms] could not interrupt a turn while halting a room', {
        roomId: room.id,
        authorId: claim.authorId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    self.releaseClaim(agentKey(room.id, claim.authorId), 'halted');
  }
  return claims.length;
}

/**
 * The body of {@link RoomTriggerDispatcher.haltAgent}, which documents it.
 *
 * @param self - The dispatcher whose state this reads and writes.
 */
export async function haltAgent(
  self: RoomTriggerDispatcher,
  room: Room,
  authorId: string,
  byAuthorId: string
): Promise<number> {
  self.receipts.cancelRetries(room.id, authorId);
  const key = agentKey(room.id, authorId);
  const claim = self.claimed.get(key);
  // Read BEFORE the mark, or it would always be true. A press that is still
  // awaiting its interrupt leaves the claim in place, so a second press lands
  // on the same dispatch — one turn, stopped once, and counted once. The mark
  // cannot be stale: it is dropped at the turn's own terminal, and the next
  // turn for this pair is a different dispatch.
  const alreadyStopping = claim !== undefined && self.wasHalted(claim.dispatchId);
  // **Marked first, before anything that can yield.** See point 1 above: a
  // turn whose stream closes while this method is still delivering the
  // interrupt must find the mark already there, or it posts the answer Stop
  // was pressed to prevent.
  if (claim !== undefined) {
    self.haltedTurns.add(claim.dispatchId);
    // The other half of this turn's voice, at the pair rather than at the
    // dispatch, and scoped to this key like everything else here — stopping
    // Ana never takes Bo's hand off the tool
    // ({@link RoomTriggerDispatcher.stoppedHere}).
    self.stoppedHere.set(key, { roomId: room.id, authorId });
  }
  logger.info('[rooms] an agent was stopped in a room', {
    roomId: room.id,
    authorId,
    // What THIS press did, which is what a person reading two lines for one
    // turn needs to tell them apart.
    stopped: claim !== undefined && !alreadyStopping,
    alreadyStopping,
  });

  // Dropped before the notice only to KNOW what to say; nothing here can
  // yield, so the durable-write-before-release ordering is untouched. Scoped
  // to this agent, so what anybody else is waiting to answer is left alone.
  const waiting = self.collector.dropOne(room.id, authorId);
  for (const dropped of waiting) {
    logger.info('[rooms] a stop dropped messages that were waiting for a turn', {
      roomId: room.id,
      authorId,
      waiting: dropped.entries.length,
    });
    // Through the seam, so the held indicator goes with the collection rather
    // than standing until the next republish tick with nothing durable under
    // it. Stopping a HELD agent is the case this covers: nothing is running
    // here to interrupt, and what the person stopped is this conversation
    // waiting. The `halted` line written just below is its durable sibling —
    // and the turn in the OTHER room is untouched, which is the whole
    // difference between this and stopping the room that is in the way.
    self.settleCollection(dropped, 'halted');
  }

  self.notices.reportAgentHalted(room, {
    byAuthorId,
    subjectAuthorId: authorId,
    outcome: claim !== undefined ? 'interrupted' : waiting.length > 0 ? 'unstarted' : 'idle',
  });

  if (claim === undefined) return 0;
  // The earlier press owns the interrupt and the release; a second one here
  // would interrupt a turn that is already being stopped and then release a
  // key the first press is about to release itself.
  if (alreadyStopping) return 0;

  try {
    // **The session lookup is inside the try, and that is the whole reason
    // there is one line of nesting here.** It is a database read, and a
    // `SQLITE_BUSY` escaping at this point would leave a marked, un-released
    // claim: the room would show that agent working for the life of the
    // process, and the `(room, agent)` ceiling would refuse it every message
    // after. Whatever went wrong, the claim goes.
    const sessionId = self.deps.store.getRoomSession(room.id, authorId);
    if (sessionId !== null && sessionId !== undefined) {
      const receipt = await self.deps.runner.interrupt({
        sessionId,
        agentPath: claim.agentPath,
      });
      // Same answer, same reading, at the narrower scope (DOR-1425).
      if (receipt.outcome !== 'acked' && receipt.outcome !== 'closed') {
        self.reportUnreachedStop(room.id, claim, sessionId, receipt);
      }
    }
  } catch (err) {
    // An agent that will not stop still loses its claim: a claim held for a
    // turn nobody can interrupt is an indicator with nothing behind it.
    logger.warn('[rooms] could not interrupt a turn while stopping an agent', {
      roomId: room.id,
      authorId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // By KEY, not by dispatch: this is stopping whoever holds the claim rather
  // than finishing a turn of its own, which is the one case room-conduct
  // reserves `releaseClaim` for.
  self.releaseClaim(key, 'halted');
  return 1;
}
