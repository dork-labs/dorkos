/**
 * Turning one gathered collection into a claimed turn, or into the notice that
 * says why it could not be one.
 *
 * Split out of `room-trigger.ts` without changing a line of logic. Each function
 * here is the body of a {@link RoomTriggerDispatcher} method of the same name,
 * which delegates to it with itself as `self`.
 *
 * @module server/services/rooms/room-trigger/claim-collected
 */
import { wakeForBudgetRefusal } from '../../heartbeats/room-wakes.js';
import { randomUUID } from 'node:crypto';
import type { Room, RoomEntry } from '@dorkos/shared/room-schemas';
import { newDispatchId } from '@dorkos/shared/dispatch-id';
import { logError, logger } from '../../../lib/logger.js';
import { type TriggerTarget } from '../room-claims.js';
import { type RoomCollection } from '../room-collect.js';
import type { RoomTriggerDispatcher } from '../room-trigger.js';

/**
 * Turn one agent's collected messages into one claimed turn: afford it, bind
 * it, and claim it.
 *
 * Everything here is per TURN rather than per message, which is the half of
 * RP8 that shows up on a bill. **One budget reservation covers the whole
 * collected window** — three people talking at once cost one automatic turn,
 * not three — and **one claim advances the cursor past all of it**, because
 * the turn really is shown all of it: the last message is what it answers, and
 * everything behind it rides the ambient window (spec §8.3).
 *
 * The trigger is the NEWEST message the guard still allows, and the earlier
 * ones are context. Newest rather than oldest because the ambient window ends
 * at the triggering entry's `seq`, so triggering on the first of a burst would
 * put the rest above the ceiling and show the agent none of them. **Allowed
 * rather than simply last** — see {@link RoomTriggerDispatcher.chooseTrigger}.
 *
 * @param collection - What this agent has been asked and not yet answered.
 * @returns What to run, or `null` when nothing will — every such path has
 *   already settled this collection's accounting or parked it.
 */
export function claimCollected(
  self: RoomTriggerDispatcher,
  collection: RoomCollection
): { room: Room; entry: RoomEntry; target: TriggerTarget } | null {
  const { room, authorId, agentPath, displayName } = collection;
  const newest = collection.entries.at(-1);
  if (!newest) {
    self.settleCollection(collection, 'refused');
    return null;
  }
  // Asked AGAIN, not merely re-read: a window that opened while the agent was
  // free can still close after something else claimed it — an aside turn, or
  // a burst in another room reaching the same checkout.
  const busyWith = self.busyWith(room.id, authorId, agentPath);
  if (busyWith !== null) {
    // Parked, not refused: this is the same steer `collectOne` makes, arrived
    // at from the other direction. The credit stays with the collection —
    // unless parking MERGED it into one already waiting, in which case two
    // pending turns have become one and the surplus is settled here.
    //
    // **The hold is re-stated AFTER the park, against whatever is in the way
    // now.** A batch re-armed by one claim's release frequently finds another
    // room's claim already taken by the time it gets here, and the indicator
    // has to point at that room rather than the one that just finished.
    const merged = self.collector.park(collection);
    if (busyWith.where === 'elsewhere') {
      // The batch's OLDEST message keys a new hold, which is the same choice
      // `collectOne` makes: an indicator is keyed `(room, author, entryId)`,
      // so it has to be an id that does not move while the person keeps
      // typing. An existing hold keeps its own — see `noteHold`.
      self.noteHold(
        room.id,
        authorId,
        agentPath,
        collection.entries[0]?.entry.id ?? newest.entry.id,
        busyWith
      );
    }
    if (merged) self.settleOne();
    return null;
  }

  // **Asked again at the last moment, like the ceilings above it.** A batch can
  // wait here for the best part of an hour, and a room's roster is not frozen
  // while it does: an agent removed from the room, or a room archived, must not
  // buy a turn that then POSTS into a room it is no longer in. `abandonHolds`
  // drops the wait at the moment either happens; this is the second gate, for
  // anything that changes the roster without going through the service.
  if (room.archived || self.deps.store.getMember(room.id, authorId) === null) {
    logger.info('[rooms] a waiting message never ran: the agent is no longer in the room', {
      roomId: room.id,
      authorId,
      archived: room.archived,
    });
    // **And the room says so** (DOR-786), through the same seam
    // {@link RoomTriggerDispatcher.abandonHolds} uses — because this is the
    // same event, reached from the other direction. That one runs inside the
    // operator's own `removeMember` call and handles almost every real case;
    // this is the second gate, for a roster that changed WITHOUT going through
    // the service (a direct write, a reconciler), where there is no act at all
    // for a reader to connect the silence to. One helper, so the two gates
    // cannot drift into saying different things about one event.
    //
    // **THIS BRANCH IS DEFENSIVE, and no test reaches it** — said plainly for
    // the reason `routeCollection`'s own TSDoc says the same thing about its
    // busy and gone skips, rather than leaving the next reader to infer
    // coverage from the tests around it. Removing a member through the service
    // calls `abandonHolds`, which drops every pending collection before this
    // gate is ever asked, and archiving does the same. What is left is a
    // roster changed underneath the service, which nothing in the suite does.
    // The `agent_left` tests therefore exercise the OTHER call site; this one
    // exists so that a direct write cannot produce the silent drop DOR-786 is
    // about, and deleting it would leave every test green.
    //
    // **Read fresh, not from `collection.room`.** The room destructured at the
    // top of this method is the room as it stood when the message was POSTED,
    // and a batch can wait here the best part of an hour — so the archive that
    // matters may have happened during the wait. `reportLeft` promises to take
    // the room as it stands NOW, because that is the value its archived check
    // turns on, and handing it a stale one would have it attempt a notice the
    // store then refuses.
    self.reportLeft(self.deps.store.getRoom(room.id), collection);
    self.settleCollection(collection, 'left');
    return null;
  }

  const chosen = self.chooseTrigger(collection);
  if (!chosen) {
    // EVERY message in the batch was refused, so the batch is refused — and
    // the refusals are already on the log, written by `chooseTrigger` under
    // the same narrowness a single refusal has always had.
    self.settleCollection(collection, 'refused');
    return null;
  }
  const entry = chosen.held.entry;

  const target: TriggerTarget = {
    authorId,
    agentPath,
    displayName,
    // The FRESH verdict's depth, not the one the guard reached when this
    // message was collected. They agree today — depth is derived from the
    // entry rather than from the store — and taking it from the decision that
    // actually allowed this turn is what keeps them from drifting apart.
    depth: chosen.decision.depth,
    engaged: chosen.held.engaged,
    ...(chosen.held.reason === 'conversation' || chosen.held.reason === 'lead'
      ? { answerOwed: chosen.held.reason }
      : {}),
    reason: chosen.held.reason,
    // ONE ID PER (turn, target), minted here rather than per entry. A message
    // addressed to three agents is three dispatches sharing one `entryId`: the
    // fan-out is recovered by the entry, and each agent's own chain — claim,
    // turn, reply, relay hop — is recovered by its dispatch. Minting one id
    // for the entry would put three interleaved turns on one filter and answer
    // no question at all.
    dispatchId: newDispatchId(),
    // Replaced with the real binding once the budget has been charged; a turn
    // that never becomes affordable never mints a session.
    sessionId: '',
    // Replaced with the real cursor at claim time, for the same reason.
    lastReadSeq: 0,
    // Only the messages this turn will actually be SHOWN. The window ends at
    // the trigger's `seq`, so a refused message above it is not in `pending`
    // and marking it would be a claim about a line nobody will read.
    arrivedDuringPrevTurn: new Set(
      collection.entries
        .slice(0, chosen.index)
        .filter((held) => held.arrivedDuringTurn)
        .map((held) => held.entry.id)
    ),
    // Everything gathered behind the trigger, whenever it arrived — the rest
    // of what this one turn is being asked (DOR-1231). Bounded the same way:
    // above the chosen index is refused and unread, so marking it would be a
    // claim about a line nobody will read.
    gathered: new Set(collection.entries.slice(0, chosen.index).map((held) => held.entry.id)),
    // Every message the turn answers, trigger included, so its power is
    // decided by the strictest author in the burst (spec
    // `trusted-by-default-flip` §4) rather than by whoever wrote last.
    answers: collection.entries.slice(0, chosen.index + 1).map((held) => ({
      id: held.entry.id,
      authorId: held.entry.authorId,
    })),
  };

  // The cascade guard allowed these on the merits, one message at a time. The
  // budget is the second, blunter question — can this ROOM afford another
  // automatic turn at all — and it is asked without reference to who wrote the
  // entry, so a caller who reached depth 0 by claiming to be human still stops
  // here. ONCE for the collection, because a collection is one turn.
  //
  // **Limits off means no reservation at all**, not a reservation against a
  // huge number: an hour spent unlimited must not leave a room out of budget
  // the moment somebody turns limits back on, and a counter nothing reads is
  // a counter that lies. The budget owns that decision now, rather than a
  // branch here reading a flag the budget would then read again — one seam,
  // so an unlimited ROOM on a counting install is still charged against the
  // install's wallet and cannot be made unlimited by a caller that forgot the
  // second half of the rule (DOR-1429).
  const afford = self.deps.budget.tryReserve(room.id);
  if (!afford.allowed) {
    // This one CAN be correlated: the target survived the guard and was
    // given its id above, so the refusal belongs to a real dispatch that
    // never ran.
    self.notices.reportBudget(room, entry, afford.scope ?? 'room', target.dispatchId);
    // Its beat looks instead, for a local author's message (spec `heartbeats` §3.3).
    wakeForBudgetRefusal(agentPath, chosen.held.reason, entry, self.deps.authors);
    self.settleCollection(collection, 'refused');
    return null;
  }
  // Spending again means the window moved, so re-arm the notice: the next
  // exhaustion is news, not a repeat. Only when something was actually
  // charged — with nothing counting there is no window to have rolled.
  if (afford.counted) self.notices.budgetRecovered(room.id);

  // Bind the session BEFORE claiming it. Reading the binding inside `runOne`
  // and writing it on completion left a window: two posts before the first
  // reply both saw `null`, both minted a UUID, and the second lost the
  // `onConflictDoNothing` race — leaving a real session with its own projector
  // and `session_metadata` row bound to nothing, whose reply was produced from
  // an empty context. `bindRoomSession` returns the WINNER, so claiming
  // resolves the race to one session per (room, agent).
  //
  // The id minted here is a PLACEHOLDER on the first turn: the runtime names
  // the session itself, mid-turn, and files the transcript under ITS name.
  // What moves the binding onto that name is the projector's rekey — a
  // listener registered by `room-session-convergence.ts` at boot, which fires
  // the instant the id is known. The comparison in `runOne` is the FALLBACK,
  // and it has to be: it reads a value `triggerTurn` resolves best-effort at
  // first-event-or-5s, and turn 1 routinely loses that race and hands back
  // this very placeholder (DOR-784).
  //
  // Wrapped, because it is the last thing here that can throw. It no longer
  // runs inside `RoomService.post` — the collect window put a macrotask
  // between the two — but the failure is the same one either way: a
  // `SQLITE_BUSY` on a `room_sessions` insert must cost this turn and nothing
  // else. Nothing to unwind, since no claim is held yet; the room's spend is
  // already charged and is NOT refunded, because `tryReserve` has no
  // counterpart and inventing one for a path that only fires under database
  // contention would be more machinery than the fault is worth.
  try {
    target.sessionId = self.deps.store.bindRoomSession(
      room.id,
      authorId,
      self.deps.store.getRoomSession(room.id, authorId) ?? randomUUID(),
      new Date().toISOString()
    );
  } catch (err) {
    // Visible, not silent (DOR-1206): a dropped trigger with no room entry is
    // indistinguishable from a broken agent, and in a shared room the person
    // who notices is not the person who configured it. `reportSilence` writes
    // and damps the durable notice; the STACK stays here rather than there,
    // and unlike `turn_failed` it has nowhere else to go — a bind that never
    // happened mints no session, so there is no agent stream for a person to
    // open and no `runOneInDispatch` catch to fall back on.
    logger.warn('[rooms] could not bind a room session, so this agent was not triggered', {
      roomId: room.id,
      authorId,
      entryId: entry.id,
      dispatchId: target.dispatchId,
      ...logError(err),
    });
    self.notices.reportSilence(room, entry, target, 'unavailable', target.dispatchId);
    self.settleCollection(collection, 'refused');
    return null;
  }

  // THE READ CURSOR ADVANCES HERE, AT THE CLAIM — not when the reply posts
  // (room-participation spec §8.3). The turn is about to be shown everything
  // between this cursor and this entry; a turn that then errors, times out or
  // chooses to say nothing has still SEEN those messages, and replaying them
  // on its next turn would show the agent the same conversation twice. It
  // covers the WHOLE collected window for the same reason, because the whole
  // window is what the turn is shown.
  //
  // Read then written in one synchronous pass, before anything awaits, so no
  // other writer can land an entry between the two — and the value that was
  // there rides the target to `buildRoomContext`, which is the only thing that
  // still needs it.
  target.lastReadSeq = self.deps.store.getMember(room.id, authorId)?.lastReadSeq ?? 0;
  // Monotonic in the store, so a target answering an entry BELOW its cursor —
  // a late turn on an old message — cannot walk it backwards.
  self.deps.store.setReadCursor(room.id, authorId, entry.seq);
  self.holdClaim({
    roomId: room.id,
    cascadeRoot: entry.cascadeRoot,
    authorId,
    agentPath,
    entryId: entry.id,
    dispatchId: target.dispatchId,
    depth: target.depth,
    // A real trigger, so a post this agent makes mid-turn inherits this
    // exchange and the guard sees the whole chain.
    aside: false,
    spokeViaTool: false,
    reactedViaTool: false,
    claimedAt: new Date().toISOString(),
    pastDeadline: false,
    // Zero rather than `Date.now()`: the turn's FIRST tool call should reach
    // the room immediately, and a floor set at claim time would hold it back
    // for up to one throttle window.
    activityPublishedAt: 0,
  });
  return { room, entry, target };
}

/**
 * Say, once per message per member, that a member's agent is gone.
 *
 * **Two ways to arrive here, one notice.** A member can be SELECTED as a
 * target and turn out to be a ghost (an `always` member, or one a live
 * room-mate's cascade reached), and a member can be NAMED by a person whose
 * `@ana` reached nobody because releasing that name is exactly what the ghost
 * mechanism does. The two overlap on the commonest shape of all — somebody
 * typing at an `always` ghost — so they are unioned before anything is
 * written rather than reported by two call sites that each look right alone.
 *
 * **Being named is a direct question, and direct questions are never damped.**
 * A ghost owns no name, so ordinary chatter cannot match one and there is no
 * spray path: a person gets back exactly as many lines as they wrote messages
 * naming it. A ghost reached by SELECTION alone is damped like a busy agent,
 * because that is a state and the most persistent one there is.
 *
 * @param room - The room the message landed in.
 * @param entry - The message.
 * @param gone - Every member whose agent is gone, from both routes.
 * @param namedUnreachable - The subset this message actually typed a name for.
 */
export function reportGone(
  self: RoomTriggerDispatcher,
  room: Room,
  entry: RoomEntry,
  gone: ReadonlySet<string>,
  namedUnreachable: readonly string[]
): void {
  if (gone.size === 0) return;
  const named = new Set(namedUnreachable);
  const records = self.deps.authors.getMany([...gone]);
  for (const authorId of gone) {
    const displayName = records.get(authorId)?.displayName ?? 'An agent';
    self.notices.reportSilence(
      room,
      entry,
      { authorId, displayName },
      'gone',
      // Nothing was ever claimed for this member, so it has no dispatch of its
      // own — and the ambient one belongs to whoever's reply triggered this.
      // Same rule as the cascade and busy refusals above.
      null,
      { namedDirectly: named.has(authorId) }
    );
  }
}
