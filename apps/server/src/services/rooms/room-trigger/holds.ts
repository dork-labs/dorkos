/**
 * Messages waiting on an agent that is busy elsewhere: the held indicator,
 * re-arming, expiry, and the retries that run when the agent is free.
 *
 * Split out of `room-trigger.ts` without changing a line of logic. Each function
 * here is the body of a {@link RoomTriggerDispatcher} method of the same name,
 * which delegates to it with itself as `self`.
 *
 * @module server/services/rooms/room-trigger/holds
 */
import type { Room, RoomEntry, RoomHeldBehind } from '@dorkos/shared/room-schemas';
import { logger } from '../../../lib/logger.js';
import {
  agentKey,
  type ClaimBusy,
  type HeldRecord,
  type HoldEnd,
  type TriggerTarget,
} from '../room-claims.js';
import { toAuthorRef } from '../author-registry.js';
import { type RoomCollection } from '../room-collect.js';
import type { RoomTriggerDispatcher } from '../room-trigger.js';

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
  self: RoomTriggerDispatcher,
  roomId: string,
  authorId: string,
  agentPath: string,
  entryId: string,
  busy: ClaimBusy
): void {
  const key = agentKey(roomId, authorId);
  const open = self.held.get(key);
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
  self.held.set(key, record);
  self.publishHold(record, 'held');
  // A NEW wait changes what every other waiting room can say: `othersWaiting`
  // is the only thing that decides whether "Answer here first" is offered, and
  // it has just become true for all of them. Restated now rather than left to
  // the ten-second republish, because a control that appears seconds after the
  // fact reads as the room having thought about it.
  if (open === undefined) self.restateSiblingHolds(record);
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
export function restateSiblingHolds(self: RoomTriggerDispatcher, record: HeldRecord): void {
  for (const other of self.held.values()) {
    if (other.agentPath !== record.agentPath || other.roomId === record.roomId) continue;
    self.publishHold(other, 'held');
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
export function releaseHold(self: RoomTriggerDispatcher, key: string, reason: HoldEnd): void {
  // Nothing will answer a hold that ends any way but starting, so its 👀 goes.
  if (reason !== 'started') self.receipts.clearUpTo(key, Number.POSITIVE_INFINITY);
  const record = self.held.get(key);
  if (record === undefined) return;
  self.held.delete(key);
  logger.info('[rooms] a message that was waiting on a busy agent stopped waiting', {
    roomId: record.roomId,
    authorId: record.authorId,
    entryId: record.entryId,
    behindRoomId: record.behindRoomId,
    heldMs: Math.max(0, Date.now() - Date.parse(record.since)),
    reason,
  });
  self.publishHold(record, 'done');
  // And the other side of it: one wait fewer can take "Answer here first" away
  // from every room that is still waiting, which it should, because there may
  // now be nothing to be answered ahead of.
  self.restateSiblingHolds(record);
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
export function resumeElsewhere(
  self: RoomTriggerDispatcher,
  agentPath: string,
  from?: number
): void {
  self.collector.resumeAgent(agentPath, from);
  for (const record of self.held.values()) {
    if (record.agentPath !== agentPath) continue;
    const busy = self.busyWith(record.roomId, record.authorId, record.agentPath);
    if (busy === null) continue;
    record.behindRoomId = busy.blocking.roomId;
    self.publishHold(record, 'held');
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
export function resumeFreedHolds(
  self: RoomTriggerDispatcher,
  onlyPath?: string,
  from?: number
): void {
  const freed = new Set<string>();
  for (const record of self.held.values()) {
    if (onlyPath !== undefined && record.agentPath !== onlyPath) continue;
    if (freed.has(record.agentPath)) continue;
    if (self.busyWith(record.roomId, record.authorId, record.agentPath) === null) {
      freed.add(record.agentPath);
    }
  }
  for (const agentPath of freed) self.resumeElsewhere(agentPath, from);
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
export function expireHolds(self: RoomTriggerDispatcher): void {
  const ceiling = self.deps.holdCeilingMs();
  const now = Date.now();
  for (const [key, record] of [...self.held]) {
    if (now - Date.parse(record.since) < ceiling) continue;
    // A list, because one key can hold both a cap-closed batch and the fresh
    // collection behind it — see {@link RoomCollector.dropOne}. The NEWEST of
    // them is what the notice is about, and every one of them owes a credit.
    const dropped = self.collector.dropOne(record.roomId, record.authorId);
    self.releaseHold(key, 'expired');
    const last = dropped.at(-1);
    // One credit back per collection, exactly as a halt returns them.
    for (const _each of dropped) self.settleOne();
    if (last === undefined) continue;
    const newest = last.entries.at(-1);
    const room = self.deps.store.getRoom(record.roomId);
    if (newest === undefined || room === null) continue;
    self.notices.reportSilence(
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
 * The body of {@link RoomTriggerDispatcher.abandonHolds}, which documents it.
 *
 * @param self - The dispatcher whose state this reads and writes.
 */
export function abandonHolds(self: RoomTriggerDispatcher, roomId: string, authorId?: string): void {
  const dropped =
    authorId === undefined ? self.collector.drop(roomId) : self.collector.dropOne(roomId, authorId);
  // Read fresh rather than taken from `collection.room`, which is the room as
  // it stood when the message was posted: the whole reason this method runs is
  // that something about the room has just changed.
  const room = self.deps.store.getRoom(roomId);
  for (const collection of dropped) {
    logger.info('[rooms] a waiting message was given up on: the agent is no longer in the room', {
      roomId,
      authorId: collection.authorId,
      waiting: collection.entries.length,
    });
    self.reportLeft(room, collection);
    self.settleCollection(collection, 'left');
  }
  // A hold with no collection behind it should not exist — but if one ever
  // did, the indicator is the promise, so it goes either way.
  for (const [key, record] of [...self.held]) {
    if (record.roomId !== roomId) continue;
    if (authorId !== undefined && record.authorId !== authorId) continue;
    self.releaseHold(key, 'left');
  }
  // And the Stop mark goes too. It is otherwise cleared only by the next claim
  // there ({@link RoomTriggerDispatcher.stoppedHere}), and a room that has been
  // archived — or an agent taken off its roster — will never claim again, so
  // without this the key would outlive everything it is about. Nothing is
  // weakened by dropping it: the pair has no room to speak into any more, and
  // an agent added back is being asked to take part again.
  for (const [key, stopped] of [...self.stoppedHere]) {
    if (stopped.roomId !== roomId) continue;
    if (authorId !== undefined && stopped.authorId !== authorId) continue;
    self.stoppedHere.delete(key);
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
  self: RoomTriggerDispatcher,
  room: Room | null,
  collection: RoomCollection
): void {
  if (room === null || room.archived) return;
  const entry = collection.entries[0]?.entry;
  if (entry === undefined) return;
  self.notices.reportSilence(
    room,
    entry,
    {
      authorId: collection.authorId,
      displayName:
        self.deps.authors.getById(collection.authorId)?.displayName ?? collection.displayName,
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
  self: RoomTriggerDispatcher,
  record: HeldRecord,
  state: 'held' | 'done'
): void {
  self.deps.publishPresence(record.roomId, record.authorId, {
    state,
    entryId: record.entryId,
    since: record.since,
    // Only on the `held` frame. A `done` clears an indicator by its key and
    // says nothing else; carrying a room id on it would be a last disclosure
    // for no reader's benefit.
    ...(state === 'held' ? { heldBehind: self.heldBehind(record) } : {}),
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
export function heldBehind(self: RoomTriggerDispatcher, record: HeldRecord): RoomHeldBehind {
  let othersWaiting = false;
  for (const other of self.held.values()) {
    if (other.agentPath !== record.agentPath || other.roomId === record.roomId) continue;
    othersWaiting = true;
    break;
  }
  let running = 0;
  for (const claim of self.claimed.values()) {
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
  self: RoomTriggerDispatcher,
  collection: RoomCollection,
  reason: HoldEnd
): void {
  const key = agentKey(collection.room.id, collection.authorId);
  const newest = collection.entries.at(-1)?.entry.seq;
  if (newest !== undefined) self.receipts.clearUpTo(key, newest);
  self.releaseHold(key, reason);
  self.settleOne();
}

/**
 * Put a launch the runtime refused as busy back in line, instead of dropping
 * it (DOR-2823). The agent was working in its own chat, or finishing work the
 * runtime would not interrupt; neither is a reason to leave a person without
 * an answer. Tried again on a backoff (`BUSY_RETRY_DELAYS_MS`), through
 * the same collector a new message goes through, so a room archived or an
 * agent removed in the meantime is handled the way it always is. The first
 * retry writes the one notice that says so, and it is true.
 *
 * @param room - The room.
 * @param entry - The message the refused turn would have answered.
 * @param target - The refused turn.
 * @returns `false` once every retry is spent, so the caller says the room
 *   gave up.
 */
export function retryWhenFree(
  self: RoomTriggerDispatcher,
  room: Room,
  entry: RoomEntry,
  target: TriggerTarget
): boolean {
  const next = self.receipts.scheduleRetry(room.id, target.authorId, entry.id, () =>
    self.retryNow(room.id, entry.id, target)
  );
  if (next === null) return false;
  if (next.attempt === 1) {
    self.notices.reportSilence(room, entry, target, 'busy', target.dispatchId, {
      busyWith: 'retrying',
    });
  }
  logger.info('[rooms] a busy agent will be tried again', {
    roomId: room.id,
    authorId: target.authorId,
    entryId: entry.id,
    attempt: next.attempt,
    inMs: next.inMs,
  });
  return true;
}

/**
 * Put one busy launch back through the collector, as it was first picked.
 *
 * @param roomId - The room.
 * @param entryId - The message to answer.
 * @param target - The turn that was refused.
 */
export function retryNow(
  self: RoomTriggerDispatcher,
  roomId: string,
  entryId: string,
  target: TriggerTarget
): void {
  const room = self.deps.store.getRoom(roomId);
  const entry = self.deps.store.getEntryById(roomId, entryId);
  const record = self.deps.authors.getById(target.authorId);
  const member = self.deps.store.listMembers(roomId).find((m) => m.authorId === target.authorId);
  // Nothing to answer any more: the room or the agent is gone, or a turn the
  // agent took since has already read this message.
  if (!room || room.archived || !entry || !record || !member || member.lastReadSeq >= entry.seq) {
    self.receipts.forgetRetry(roomId, target.authorId, entryId);
    self.receipts.clear(roomId, target.authorId, entryId);
    return;
  }
  self.collectOne(
    room,
    entry,
    {
      authorId: target.authorId,
      agentPath: target.agentPath,
      displayName: target.displayName,
      author: toAuthorRef(record),
      depth: target.depth,
      engaged: target.engaged,
      reason: target.reason ?? 'mention',
    },
    Date.now()
  );
  if (self.deps.authors.getById(entry.authorId)?.kind === 'human') {
    self.receipts.mark(roomId, entry, target.authorId);
  }
}
