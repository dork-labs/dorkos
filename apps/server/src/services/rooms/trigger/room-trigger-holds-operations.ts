import type { Room, RoomHeldBehind } from '@dorkos/shared/room-schemas';
import { logger } from '../../../lib/logger.js';
import {
  agentKey,
  describeHolds,
  type ClaimBusy,
  type HeldRecord,
  type HoldEnd,
  type HeldView,
} from '../room-claims.js';
import { type RoomCollection } from '../room-collect.js';
import { readOriginalRoomTriggerFacetView } from '../room-trigger.js';

/**
 * Record that this room's message is waiting behind a turn somewhere else, and
 * put that on the room's stream.
 *
 * **Idempotent, and the two fields it keeps are why.** An existing hold keeps
 * its `since` — the lane counts up from when the person's message actually
 * started waiting, not from the last time something re-checked — and its
 * `entryId`, because the indicator is keyed on that and a moving id would open
 * a second indicator every time the person typed again. Only `behindRoomId`
 * is re-pointed, because the room in the way genuinely changes as claims come
 * and go.
 *
 * @param roomId - The room whose message is waiting.
 * @param authorId - The agent it is waiting for.
 * @param agentPath - That agent's directory — the ceiling being waited on.
 * @param entryId - The message to key a NEW hold on. Ignored when one exists.
 * @param busy - What is in the way, from the live claim map.
 */
export function noteHold(
  triggerOwner: object,
  roomId: string,
  authorId: string,
  agentPath: string,
  entryId: string,
  busy: ClaimBusy
): void {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  const key = agentKey(roomId, authorId);
  const open = facet.held.get(key);
  const record: HeldRecord =
    open === undefined
      ? {
          roomId,
          authorId,
          agentPath,
          entryId,
          since: new Date().toISOString(),
          behindRoomId: busy.blocking.roomId,
        }
      : { ...open, behindRoomId: busy.blocking.roomId };
  facet.held.set(key, record);
  facet.publishHold(record, 'held');
  // A NEW wait changes what every other waiting room can say: `othersWaiting`
  // is the only thing that decides whether "Answer here first" is offered, and
  // it has just become true for all of them. Restated now rather than left to
  // the ten-second republish, because a control that appears seconds after the
  // fact reads as the room having thought about it.
  if (open === undefined) facet.restateSiblingHolds(record);
}

/**
 * Re-state every OTHER room waiting on the same agent.
 *
 * `heldBehind.othersWaiting` is a fact about the set of waits rather than about
 * any one of them, so it goes stale in every other room the moment this one
 * starts or stops waiting. The republish tick would fix it within ten seconds;
 * a person watching would see "Answer here first" appear, or linger after it
 * had stopped meaning anything, for that whole window.
 *
 * @param record - The hold that just opened or closed. Its own room is skipped
 *   — it has either just been published or just been cleared.
 */
export function restateSiblingHolds(triggerOwner: object, record: HeldRecord): void {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  for (const other of facet.held.values()) {
    if (other.agentPath !== record.agentPath || other.roomId === record.roomId) continue;
    facet.publishHold(other, 'held');
  }
}

/**
 * Drop a hold and publish `done` for it.
 *
 * **Called from every path that ends a collection without taking a claim**, so
 * "no hold is ever left standing" is structural rather than remembered — the
 * same shape {@link RoomTriggerDispatcher.releaseClaim} gives claims. Releasing
 * a key that holds nothing is a no-op, because most collections never had one.
 *
 * **It writes no notice, whatever the reason**, and each reason has a durable
 * sibling written by the path that caused it: `started` is the turn itself,
 * `halted` is the room-wide `halted` line, `refused` is the guard's or the
 * budget's own notice, and `expired` is the one `agent_busy` line
 * {@link RoomTriggerDispatcher.expireHolds} writes — there, because only there
 * is the dropped collection in hand to write it about.
 *
 * @param key - The `(room, agent)` key whose hold is ending.
 * @param reason - How it ended, for the log. Never rendered.
 */
export function releaseHold(triggerOwner: object, key: string, reason: HoldEnd): void {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  const record = facet.held.get(key);
  if (record === undefined) return;
  facet.held.delete(key);
  logger.info('[rooms] a message that was waiting on a busy agent stopped waiting', {
    roomId: record.roomId,
    authorId: record.authorId,
    entryId: record.entryId,
    behindRoomId: record.behindRoomId,
    heldMs: Math.max(0, Date.now() - Date.parse(record.since)),
    reason,
  });
  facet.publishHold(record, 'done');
  // And the other side of it: one wait fewer can take "Answer here first" away
  // from every room that is still waiting, which it should, because there may
  // now be nothing to be answered ahead of.
  facet.restateSiblingHolds(record);
}

/**
 * Re-arm every held collection for one agent, and re-point the ones that are
 * still blocked.
 *
 * Two halves, and the second is what keeps the lane honest. Re-arming is the
 * cross-room `resume`. Re-pointing is for the collections that will find
 * ANOTHER claim in the way when they reach `claimCollected` a macrotask later:
 * their indicator has to name the room that is in the way now, not the one
 * that just finished. A hold with nothing left in its way is left alone — the
 * turn it is waiting for is about to start, and `holdClaim` resolves it then.
 *
 * @param agentPath - The working directory whose claim just released.
 * @param from - The clock reading to arm from, passed through to
 *   {@link RoomCollector.resumeAgent}. Omitted means now.
 */
export function resumeElsewhere(triggerOwner: object, agentPath: string, from?: number): void {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  facet.collector.resumeAgent(agentPath, from);
  for (const record of facet.held.values()) {
    if (record.agentPath !== agentPath) continue;
    const busy = facet.busyWith(record.roomId, record.authorId, record.agentPath);
    if (busy === null) continue;
    record.behindRoomId = busy.blocking.roomId;
    facet.publishHold(record, 'held');
  }
}

/**
 * Re-arm the waits whose agent has room for another turn without any turn
 * having ended — which only a raised `rooms.maxConcurrentTurnsPerAgent` does.
 *
 * A held collection is otherwise re-armed by a claim RELEASING
 * ({@link RoomTriggerDispatcher.resumeElsewhere}), which is the only event
 * that frees a slot while the limit stands still. Raising the limit in
 * Settings frees one too, and without this the message that had been waiting
 * longest would sit parked behind a turn it no longer needs to wait for —
 * while a message sent a second later started at once. Riding the republish
 * tick bounds that to one beat; the tick is running, because a hold cannot
 * exist without a claim.
 *
 * Nothing is decided here: re-arming routes each collection back through
 * `claimCollected`, which asks the ceiling again and re-parks any that still
 * do not fit.
 *
 * Also called by {@link RoomTriggerDispatcher.collectOne} for the one agent a
 * fresh message is for, which is what keeps the order first-come: without it,
 * a message sent inside that beat would take the freed slot ahead of one that
 * had been waiting.
 *
 * @param onlyPath - Consider only this agent's waits. Omitted on the beat,
 *   which considers every agent's.
 * @param from - The clock reading to arm the waits from. `collectOne` passes
 *   the fresh message's `arrivedAt`, so the re-armed waits are due no later
 *   than it and share its sweep, oldest first; a later reading could put
 *   them one millisecond behind and let the fresh message take the slot.
 */
export function resumeFreedHolds(triggerOwner: object, onlyPath?: string, from?: number): void {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  const freed = new Set<string>();
  for (const record of facet.held.values()) {
    if (onlyPath !== undefined && record.agentPath !== onlyPath) continue;
    if (freed.has(record.agentPath)) continue;
    if (facet.busyWith(record.roomId, record.authorId, record.agentPath) === null) {
      freed.add(record.agentPath);
    }
  }
  for (const agentPath of freed) facet.resumeElsewhere(agentPath, from);
}

/**
 * Give up on the holds that have waited longer than the room's late ceiling,
 * and say so once each.
 *
 * **The bound exists to stop a chain, not to hurry anybody.** A blocks B and B
 * blocks C is a wait with no natural end, and a lane that says "it will pick
 * this up" for an hour has stopped being a promise and become furniture.
 * `rooms.lateReplyCeilingMinutes` is reused rather than a new setting invented:
 * it already means "when the room stops listening", which is this same fact at
 * a different grain.
 *
 * The notice is written HERE rather than in `releaseHold`, because only here is
 * the dropped collection in hand — a notice has to be about a message somebody
 * actually sent, and the newest one in the batch is the one they are waiting on.
 */
export function expireHolds(triggerOwner: object): void {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  const ceiling = facet.deps.holdCeilingMs();
  const now = Date.now();
  for (const [key, record] of [...facet.held]) {
    if (now - Date.parse(record.since) < ceiling) continue;
    // A list, because one key can hold both a cap-closed batch and the fresh
    // collection behind it — see {@link RoomCollector.dropOne}. The NEWEST of
    // them is what the notice is about, and every one of them owes a credit.
    const dropped = facet.collector.dropOne(record.roomId, record.authorId);
    facet.releaseHold(key, 'expired');
    const last = dropped.at(-1);
    // One credit back per collection, exactly as a halt returns them.
    for (const _each of dropped) facet.settleOne();
    if (last === undefined) continue;
    const newest = last.entries.at(-1);
    const room = facet.deps.store.getRoom(record.roomId);
    if (newest === undefined || room === null) continue;
    facet.notices.reportSilence(
      room,
      newest.entry,
      { authorId: last.authorId, displayName: last.displayName },
      'busy',
      // No dispatch of its own: no turn was ever started for this batch.
      null,
      { busyWith: 'held-too-long' }
    );
  }
}

/**
 * Put one room's waiting message at the front of that agent's queue.
 *
 * The whole body of `POST /api/rooms/:id/holds/:authorId/promote`. It reorders
 * and never preempts: the blocking turn is untouched, and a promoted hold still
 * waits for the agent to be free.
 *
 * @param roomId - The room asking to be answered first.
 * @param authorId - The agent it is waiting on.
 * @returns `false` when there was no hold to promote — a stale button rather
 *   than an error.
 */
export function promoteHold(triggerOwner: object, roomId: string, authorId: string): boolean {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  if (!facet.held.has(agentKey(roomId, authorId))) return false;
  return facet.collector.promote(roomId, authorId);
}

/**
 * Give up on what a room owes an agent that is no longer there to answer it.
 *
 * **The wait used to outlive the roster, and this change is what made that
 * matter.** A parked collection was bounded by one collect debounce — half a
 * second — so an agent removed mid-park was a race nobody could lose. A
 * cross-room hold lasts up to `rooms.lateReplyCeilingMinutes`, which is
 * fifty minutes on the shipped defaults: plenty of time to take the agent out
 * of the room, or to put the room away, while the lane goes on promising an
 * answer that can no longer come.
 *
 * **It used to write no notice, and DOR-786 changed that for one half of it.**
 * The old reasoning was that the act reaching here is operator-only and already
 * visible — the agent is off the roster, or the room is archived — so the room
 * was not going quiet for no reason. That held while a post promised nothing.
 * It does not now: `POST /api/rooms/:id/entries` answers with the agents it
 * asked to reply (`PostToRoomResponse.triggered`), and the person who sent the
 * message is not necessarily the person who changed the roster. A promise the
 * room makes and then drops in silence is exactly the shape
 * `.claude/rules/room-conduct.md` forbids, so the room now says the member
 * left. The held indicator's `done` still withdraws the live indicator; this is
 * the durable half, which survives a reader who was not watching.
 *
 * **Archiving still writes nothing, and cannot.** `postNotice` refuses an
 * archived room, because archiving promises the room stops gaining entries —
 * so there is nowhere to put the line, and forcing one in would be either an
 * entry after the archive or a swallowed failure dressed up as a notice. The
 * archive is its own announcement, and the room is closed to the reader anyway.
 *
 * @param roomId - The room whose waits are over.
 * @param authorId - One agent, or omitted for every agent in the room —
 *   which is what archiving means.
 */
export function abandonHolds(triggerOwner: object, roomId: string, authorId?: string): void {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  const dropped =
    authorId === undefined
      ? facet.collector.drop(roomId)
      : facet.collector.dropOne(roomId, authorId);
  // Read fresh rather than taken from `collection.room`, which is the room as
  // it stood when the message was posted: the whole reason this method runs is
  // that something about the room has just changed.
  const room = facet.deps.store.getRoom(roomId);
  for (const collection of dropped) {
    logger.info('[rooms] a waiting message was given up on: the agent is no longer in the room', {
      roomId,
      authorId: collection.authorId,
      waiting: collection.entries.length,
    });
    facet.reportLeft(room, collection);
    facet.settleCollection(collection, 'left');
  }
  // A hold with no collection behind it should not exist — but if one ever
  // did, the indicator is the promise, so it goes either way.
  for (const [key, record] of [...facet.held]) {
    if (record.roomId !== roomId) continue;
    if (authorId !== undefined && record.authorId !== authorId) continue;
    facet.releaseHold(key, 'left');
  }
  // And the Stop mark goes too. It is otherwise cleared only by the next claim
  // there ({@link RoomTriggerDispatcher.stoppedHere}), and a room that has been
  // archived — or an agent taken off its roster — will never claim again, so
  // without this the key would outlive everything it is about. Nothing is
  // weakened by dropping it: the pair has no room to speak into any more, and
  // an agent added back is being asked to take part again.
  for (const [key, stopped] of [...facet.stoppedHere]) {
    if (stopped.roomId !== roomId) continue;
    if (authorId !== undefined && stopped.authorId !== authorId) continue;
    facet.stoppedHere.delete(key);
  }
}

/**
 * Say that a member left before the turn it was owed ever ran.
 *
 * The one place the two abandonment gates agree — {@link
 * RoomTriggerDispatcher.abandonHolds}, which runs inside the operator's own
 * roster write, and the last-moment re-check in `claimCollected` for a roster
 * that changed without going through the service. One event, one sentence,
 * whichever path notices it.
 *
 * **Silent for an archived room, and that is structural rather than a
 * choice.** `postNotice` refuses one, because archiving promises the room stops
 * gaining entries. Checked here rather than left to fail inside the writer, so
 * the reason is written down where somebody looking for the missing line will
 * find it.
 *
 * The notice is ABOUT the oldest message in the batch, which is the one the
 * person has been waiting on longest and the id the hold was keyed to.
 *
 * @param room - The room as it stands NOW, or `null` if it has been deleted
 *   out from under this call.
 * @param collection - The batch that will never become a turn.
 */
export function reportLeft(
  triggerOwner: object,
  room: Room | null,
  collection: RoomCollection
): void {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  if (room === null || room.archived) return;
  const entry = collection.entries[0]?.entry;
  if (entry === undefined) return;
  facet.notices.reportSilence(
    room,
    entry,
    {
      authorId: collection.authorId,
      displayName:
        facet.deps.authors.getById(collection.authorId)?.displayName ?? collection.displayName,
    },
    'left',
    // No dispatch id: this batch never reached the half of `claimCollected`
    // that mints one. Left null rather than borrowed from the ambient scope,
    // which would file a drop about this agent under whichever turn happened
    // to be running when the roster changed.
    null
  );
}

/**
 * Every message waiting on a busy agent right now, for the diagnostic read
 * surface.
 *
 * {@link RoomTriggerDispatcher.listClaims}'s sibling, and it answers what that
 * one cannot: a room showing no claim and no answer is otherwise
 * indistinguishable from a room whose message went nowhere.
 *
 * @returns One row per live hold.
 */
export function listHolds(triggerOwner: object): HeldView[] {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  return describeHolds(facet.held);
}

/**
 * Put one hold's state on its room's ephemeral stream.
 *
 * `since` is the hold's own start on every publish, for the reason
 * {@link RoomTriggerDispatcher.publishPresence} carries the claim's: an event
 * that said "now" would reset the wait every ten seconds, and a client that
 * connected mid-wait could never learn how long it has been.
 *
 * @param record - The hold this is about.
 * @param state - `'held'` while it waits, `'done'` once it stops.
 */
export function publishHold(
  triggerOwner: object,
  record: HeldRecord,
  state: 'held' | 'done'
): void {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  facet.deps.publishPresence(record.roomId, record.authorId, {
    state,
    entryId: record.entryId,
    since: record.since,
    // Only on the `held` frame. A `done` clears an indicator by its key and
    // says nothing else; carrying a room id on it would be a last disclosure
    // for no reader's benefit.
    ...(state === 'held' ? { heldBehind: facet.heldBehind(record) } : {}),
  });
}

/**
 * What one hold is waiting behind, as the wire carries it.
 *
 * An id and two booleans, and no more: the reader may not be a member of the
 * room in the way, so the name is resolved on the client against the rooms it
 * can already see. `othersWaiting` is a boolean rather than a count because it
 * exists only to decide whether "Answer here first" would change anything —
 * a count would let a reader enumerate rooms it cannot see.
 *
 * `severalInTheWay` is the same shape for the same reason. Once an agent may
 * work in more than one conversation at once (`rooms.maxConcurrentTurnsPerAgent`),
 * the room named is only the turn that has run longest, and whichever of its
 * turns finishes first can be the one that lets this message start — so the
 * sentence must not promise the named one (DOR-2104).
 *
 * @param record - The hold being described.
 */
export function heldBehind(triggerOwner: object, record: HeldRecord): RoomHeldBehind {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  let othersWaiting = false;
  for (const other of facet.held.values()) {
    if (other.agentPath !== record.agentPath || other.roomId === record.roomId) continue;
    othersWaiting = true;
    break;
  }
  let running = 0;
  for (const claim of facet.claimed.values()) {
    if (claim.agentPath === record.agentPath) running += 1;
  }
  return { roomId: record.behindRoomId, othersWaiting, severalInTheWay: running > 1 };
}

/**
 * End one collection's accounting AND its hold, in one call.
 *
 * **The seam that makes "no hold is ever forgotten" structural.**
 * `claimCollected` gives up in four places and each one used to call
 * `settleOne` alone; a fifth added later would have had to remember the hold.
 * The same shape {@link RoomTriggerDispatcher.releaseClaim} uses for claims:
 * one function, every terminal.
 *
 * @param collection - The batch that will not become a turn.
 * @param reason - How it ended, for the log.
 */
export function settleCollection(
  triggerOwner: object,
  collection: RoomCollection,
  reason: HoldEnd
): void {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  facet.releaseHold(agentKey(collection.room.id, collection.authorId), reason);
  facet.settleOne();
}
