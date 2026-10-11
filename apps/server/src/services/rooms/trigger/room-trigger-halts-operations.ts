import type { Room } from '@dorkos/shared/room-schemas';
import { logger } from '../../../lib/logger.js';
import { agentKey } from '../room-claims.js';
import { readOriginalRoomTriggerFacetView } from '../room-trigger.js';

/**
 * Stop everything running in one room: interrupt every in-flight turn, drop
 * every claim, and say so once.
 *
 * RP8's halt verb (room-participation spec §10.4). Three things about it are
 * load-bearing and none of them is the interrupt:
 *
 * 1. **It is a control action and can never be inferred.** Nothing in this
 *    file, or any file, pattern-matches a message for "stop". In the Hermes
 *    loop incident of 26 May 2026 an operator typed "you are in a loop, stop"
 *    and the bot treated it as one more conversational turn; inferring the
 *    verb from text would be that same failure wearing the opposite clothes,
 *    because the model would then be the thing deciding whether to obey.
 * 2. **The notice is written BEFORE the claims are dropped.** Releasing a
 *    claim publishes `done`, and an indicator that vanishes ahead of the entry
 *    explaining it is a room going quiet for no visible reason — the exact
 *    shape `.claude/rules/room-conduct.md` forbids.
 * 3. **Claims are dropped through {@link RoomTriggerDispatcher.releaseClaim},
 *    never deleted from the map.** That is the only place `done` is published
 *    and the only place the republish timer is cleared, so a halt that reached
 *    into the map itself would leave a room permanently showing work that had
 *    stopped.
 *
 * The turns themselves are not awaited. Each one's own stream still closes and
 * its `runOne` still runs its `finally`, which finds this key either empty or
 * held by a LATER turn and releases neither
 * ({@link RoomTriggerDispatcher.releaseOwnClaim}) — so a halt returns as soon
 * as every interrupt is delivered. "Releasing an already-released claim is a
 * no-op" is what that used to rest on, and it was only ever true while nobody
 * re-claimed the key: a halt plus one more message put a live turn's claim
 * under a stopped turn's `finally`, which then dropped it.
 *
 * @param room - The room to stop.
 * @returns How many in-flight turns were interrupted. `0` is a real answer: it
 *   says the room was already idle.
 */
export async function halt(triggerOwner: object, room: Room): Promise<number> {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  const claims = [...facet.claimed.values()].filter((claim) => claim.roomId === room.id);
  // **Marked before anything else, and before the first `await`.** A turn
  // whose stream closes while this method is still delivering interrupts must
  // find the mark already there, or it posts the answer Stop was pressed to
  // prevent — the two-second race measured on 2026-08-15. Nothing after this
  // line can be reached by a turn that started AFTER the halt, because a new
  // turn is a new dispatch id (see {@link RoomTriggerDispatcher.haltedTurns}).
  for (const claim of claims) {
    facet.haltedTurns.add(claim.dispatchId);
    // And the same statement at the pair, for the half of a turn's voice the
    // dispatch mark cannot reach: `post_to_room`
    // ({@link RoomTriggerDispatcher.stoppedHere}). Marked here rather than in
    // the release loop below for the same reason the dispatch mark is — before
    // the first `await`, so a turn that is quicker than the interrupt cannot
    // slip a post through the gap.
    facet.stoppedHere.set(agentKey(room.id, claim.authorId), {
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
  facet.notices.reportHalted(room, claims.length);
  // **Before the claims, and that ordering is the whole of it.** Releasing a
  // claim is what resumes a held collection, so dropping the buffers second
  // would start, one macrotask later, exactly the turns the person pressed
  // Stop to prevent — and a gathering window that nobody stopped would answer
  // a halted room half a second after it went quiet. Nothing is lost that the
  // room log does not still hold: a collection is a marker of what has not
  // been read, and the next message a person sends collects afresh.
  for (const dropped of facet.collector.drop(room.id)) {
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
    facet.settleCollection(dropped, 'halted');
  }
  for (const claim of claims) {
    try {
      // The session lookup is INSIDE the try, and it is a database read: a
      // `SQLITE_BUSY` escaping here would abandon the loop with every
      // remaining claim marked and none of them released, so a room would show
      // agents working for the life of the process and refuse each of them
      // every message after.
      const sessionId = facet.deps.store.getRoomSession(room.id, claim.authorId);
      if (sessionId !== null && sessionId !== undefined) {
        const receipt = await facet.deps.runner.interrupt({
          sessionId,
          agentPath: claim.agentPath,
        });
        // **The one place the room can say it could not reach an agent**
        // (DOR-1425). The answer was thrown away here, so a stop that landed
        // on nothing — a turn still booting, most often — logged exactly like
        // one that stopped a turn. The claim goes either way; what changes is
        // that an operator reading the log can tell the three apart.
        if (receipt.outcome !== 'acked' && receipt.outcome !== 'closed') {
          facet.reportUnreachedStop(room.id, claim, sessionId, receipt);
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
    facet.releaseOriginalClaim(agentKey(room.id, claim.authorId), 'halted');
  }
  return claims.length;
}

/**
 * Stop one agent in one room: interrupt its turn, drop what it has not read
 * yet here, and say so once. Everybody else in the room keeps working.
 *
 * **It is {@link RoomTriggerDispatcher.halt} scoped to one key, and it is held
 * to the same three constraints — not to the same statement order.** All three
 * are about what must be true BEFORE the claim is released; the two bodies
 * order the middle pair differently, and deliberately, because this one has to
 * know what it dropped before it can say what it found (`interrupted`,
 * `unstarted`, `idle`) while `halt` speaks for the whole room and can say it
 * first.
 *
 * 1. **The dispatch is marked before the first `await`** — the one ordering
 *    that is load-bearing here and is pinned by a test. An interrupt is a
 *    request and not a guarantee, so the turn's own stream still closes the
 *    ordinary way and a model that had all but finished streams its last words
 *    either side of the signal — the two-second race measured on 2026-08-15
 *    (DOR-1232).
 * 2. **The notice is written before the claim is released.** Releasing
 *    publishes `done`, and an indicator that vanishes ahead of the entry
 *    explaining it is a room going quiet for no visible reason.
 * 3. **The collection is dropped before the claim is released.** Be exact
 *    about this one, because the tempting version of the comment overstates
 *    it: releasing a claim resumes a held collection by arming a
 *    `setTimeout(0)`, and nothing in THIS method awaits after the release — so
 *    a drop moved below it would still delete the collection before any sweep
 *    could run, and every test here stays green. It was measured. The order is
 *    defence in depth for what changes underneath it: `halt` already awaits an
 *    interrupt per claim between its own release calls, which is where the
 *    same mistake really does answer the messages the person pressed Stop
 *    over, and the day anything is awaited below the release here this method
 *    inherits that. `room-per-agent-stop.test.ts` pins the drop as happening
 *    while the claim is still held, so a future `await` cannot silently
 *    reorder it.
 *
 * Nothing here reads any other key. The other agents' claims and collections
 * are never enumerated, which is what makes "the others keep working" a
 * property of this code rather than of a test.
 *
 * **A HELD agent can be stopped too**, and it is the same act at a smaller
 * scope: nothing is running here to interrupt, so what the person stops is
 * this conversation waiting. The dropped collection goes through
 * {@link RoomTriggerDispatcher.settleCollection}, so its held indicator is
 * released rather than standing until the next republish tick, and the room
 * writes the `unstarted` line. The turn in the room that was in the way is
 * NOT touched — that is the refusal `specs/room-hold-when-busy` was right to
 * make, and `Open where it's working` is still the one-click path to it.
 *
 * What it deliberately does NOT do is mute. Messages that arrive after this
 * collect and are answered normally: Stop ends a turn, it does not change a
 * setting. And it does not forget the halt mark — that is cleared at the
 * stopped turn's own terminal, exactly as `halt`'s is.
 *
 * @param room - The room the agent is working in.
 * @param authorId - The agent to stop.
 * @param byAuthorId - The person stopping it, for the room's own line.
 * @returns How many in-flight turns THIS call stopped: `1`, or `0` when the
 *   agent was not running one here — or when a press that has not finished
 *   delivering its interrupt yet had already stopped this same turn, which is
 *   one turn and is counted once.
 */
export async function haltAgent(
  triggerOwner: object,
  room: Room,
  authorId: string,
  byAuthorId: string
): Promise<number> {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  const key = agentKey(room.id, authorId);
  const claim = facet.claimed.get(key);
  // Read BEFORE the mark, or it would always be true. A press that is still
  // awaiting its interrupt leaves the claim in place, so a second press lands
  // on the same dispatch — one turn, stopped once, and counted once. The mark
  // cannot be stale: it is dropped at the turn's own terminal, and the next
  // turn for this pair is a different dispatch.
  const alreadyStopping = claim !== undefined && facet.wasHalted(claim.dispatchId);
  // **Marked first, before anything that can yield.** See point 1 above: a
  // turn whose stream closes while this method is still delivering the
  // interrupt must find the mark already there, or it posts the answer Stop
  // was pressed to prevent.
  if (claim !== undefined) {
    facet.haltedTurns.add(claim.dispatchId);
    // The other half of this turn's voice, at the pair rather than at the
    // dispatch, and scoped to this key like everything else here — stopping
    // Ana never takes Bo's hand off the tool
    // ({@link RoomTriggerDispatcher.stoppedHere}).
    facet.stoppedHere.set(key, { roomId: room.id, authorId });
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
  const waiting = facet.collector.dropOne(room.id, authorId);
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
    facet.settleCollection(dropped, 'halted');
  }

  facet.notices.reportAgentHalted(room, {
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
    const sessionId = facet.deps.store.getRoomSession(room.id, authorId);
    if (sessionId !== null && sessionId !== undefined) {
      const receipt = await facet.deps.runner.interrupt({
        sessionId,
        agentPath: claim.agentPath,
      });
      // Same answer, same reading, at the narrower scope (DOR-1425).
      if (receipt.outcome !== 'acked' && receipt.outcome !== 'closed') {
        facet.reportUnreachedStop(room.id, claim, sessionId, receipt);
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
  facet.releaseOriginalClaim(key, 'halted');
  return 1;
}
