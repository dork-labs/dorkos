import type { RoomPresenceState, RoomWorkingClaim } from '@dorkos/shared/room-schemas';
import type { SessionActivity } from '@dorkos/shared/session-stream';
import { ACTIVITY_FANOUT_THROTTLE_MS } from '../../session/session-state-projector.js';
import {
  claimBusyWith,
  claimedAgentPaths,
  claimsWorkingIn,
  describeClaims,
  type ActiveClaim,
  type ActiveClaimView,
  type ClaimBusy,
} from '../room-claims.js';
import { readOriginalRoomTriggerFacetView, sameActivity } from '../room-trigger.js';

/**
 * Take in what a turn says it is doing, and decide whether the room hears it
 * now.
 *
 * **A new reading is throttled; a CLEAR never is.** Exactly the shape the
 * session projector uses for the same fact and for the same reason (its own
 * doc at {@link ACTIVITY_FANOUT_THROTTLE_MS}): a busy turn starts tools
 * several times a second, and every publish here is a frame on every open
 * reader of this room plus a change to a store four client hooks are
 * watching. Clearing is never delayed, because a verb that outlives its turn
 * is the one thing this feature must not do.
 *
 * The trailing flush is what keeps the throttle honest: without it the LAST
 * tool of a burst would wait for the ten-second republish, and the lane would
 * name a tool the agent finished nine seconds ago.
 *
 * A repeat of the reading already published is dropped outright — the same
 * tool on the same target is not a change, and republishing it would restart
 * nothing and cost a frame.
 *
 * @param key - The `(room, agent)` claim key this turn is running under.
 * @param activity - What the turn just started, or `null` to clear.
 */
export function noteActivity(
  triggerOwner: object,
  key: string,
  activity: SessionActivity | null
): void {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  const claim = facet.claimed.get(key);
  // Released, halted, or never taken. A turn that outlives its claim says
  // nothing: there is no indicator left for this to be about.
  if (claim === undefined) return;

  if (activity === null) {
    if (claim.activity === undefined) return;
    claim.activity = undefined;
    facet.disarmActivityFlush(claim);
    facet.publishActivityNow(claim);
    return;
  }

  if (sameActivity(claim.activity, activity)) return;

  claim.activity = activity;
  const waited = Date.now() - claim.activityPublishedAt;
  if (waited >= ACTIVITY_FANOUT_THROTTLE_MS) {
    facet.disarmActivityFlush(claim);
    facet.publishActivityNow(claim);
    return;
  }
  if (claim.activityFlush !== undefined) return;
  const flush = setTimeout(() => {
    claim.activityFlush = undefined;
    // Whatever the claim holds WHEN THIS FIRES, not what it held when the
    // timer was armed: a burst of six tools inside one window should leave
    // the sixth on screen, not the second. And if the burst ended where it
    // started — A → B → A — the room is already showing the right thing, so
    // the flush costs nothing.
    if (sameActivity(claim.activity, claim.activityPublished)) return;
    facet.publishActivityNow(claim);
  }, ACTIVITY_FANOUT_THROTTLE_MS - waited);
  // A trailing repaint is not a reason for the process to stay alive, for the
  // reason the republish interval is unref'd.
  flush.unref?.();
  claim.activityFlush = flush;
}

/**
 * Put a claim's current reading on the room's stream, and remember that the
 * room has now seen it.
 *
 * The one place an activity-DRIVEN publish happens — not the only frame that
 * carries a reading, which is the distinction worth keeping straight: the
 * claim frame, both `working_late` publishes, every republish and the `done`
 * all carry `claim.activity` too, because {@link
 * RoomTriggerDispatcher.publishPresence} spreads it unconditionally. This is
 * the one that happens BECAUSE the reading changed, and it is what stamps the
 * throttle's floor.
 *
 * @param claim - The claim whose reading is going out.
 */
export function publishActivityNow(triggerOwner: object, claim: ActiveClaim): void {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  facet.publishPresence(claim, claim.pastDeadline ? 'working_late' : 'working');
  claim.activityPublishedAt = Date.now();
}

/**
 * Forget a claim's armed trailing publish, if it has one.
 *
 * Called wherever a publish has just happened or the claim is going away — a
 * timer holding a released claim is a publish for work that is over.
 *
 * @param claim - The claim whose flush is no longer wanted.
 */
export function disarmActivityFlush(triggerOwner: object, claim: ActiveClaim): void {
  readOriginalRoomTriggerFacetView(triggerOwner);
  if (claim.activityFlush === undefined) return;
  clearTimeout(claim.activityFlush);
  claim.activityFlush = undefined;
}

/**
 * Re-state every live claim and every live hold, on the interval.
 *
 * One event per claim, carrying the indicator's full identity —
 * `(room, author, entryId)` — because that is what the client keys its store
 * on (room-presence spec §3.2, §5.1). An agent holds at most one claim per
 * room, so this is also one event per working agent per room.
 *
 * Holds ride the same tick, and must: the client expires an indicator it has
 * not heard about for 30 s, so a hold that was not restated would blink off
 * the lane while it was still true. The tick runs whenever any claim exists,
 * and a hold cannot exist without one.
 */
export function republishPresence(triggerOwner: object): void {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  // Before the re-state, so nothing that has outlived the room's patience is
  // announced one more time on its way out.
  facet.expireHolds();
  facet.resumeFreedHolds();
  const rooms = new Set<string>();
  for (const claim of facet.claimed.values()) {
    facet.publishPresence(claim, claim.pastDeadline ? 'working_late' : 'working');
    rooms.add(claim.roomId);
  }
  for (const record of facet.held.values()) facet.publishHold(record, 'held');
  // One repaint per ROOM, not per claim: the sidebar draws a count, so two
  // claims in one room are one dot and one event. The global stream has no
  // replay, so this tick is the only way a reader who opened the cockpit
  // mid-turn — or reconnected — learns that a room they do not have open is
  // busy. Nothing is compared against a previous count here: the tick's job
  // is to re-state, and a tick that suppressed an unchanged count would never
  // reach the reader who missed the transition.
  for (const roomId of rooms) {
    facet.deps.publishWorkingCount(roomId, facet.workingCount(roomId));
  }
}

/**
 * Tell the fan-out a room's working count, but only when it actually moved.
 *
 * The count is over distinct AGENTS, so an agent taking a second claim in a
 * room that already shows it as working changes nothing a reader can see, and
 * an event for it would be a repaint of the identical dot. Transitions
 * therefore publish on change only; the republish tick above publishes
 * unconditionally, because those two are answering different questions —
 * "something happened" versus "this is still true".
 *
 * @param roomId - The room whose count may have moved.
 * @param before - The count taken before the claim map was mutated.
 */
export function publishWorkingCount(triggerOwner: object, roomId: string, before: number): void {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  const after = facet.workingCount(roomId);
  if (after !== before) facet.deps.publishWorkingCount(roomId, after);
}

/**
 * Put one claim's state on its room's ephemeral stream.
 *
 * `since` is the claim's OWN start on every publish, including the republishes
 * and the `done`. An event that carried "now" would make an indicator reset its
 * age every ten seconds, and a client that connected mid-turn could never learn
 * how long the work has been running.
 *
 * @param claim - The claim this is about.
 * @param state - Where it is in its life.
 */
export function publishPresence(
  triggerOwner: object,
  claim: ActiveClaim,
  state: RoomPresenceState,
  outcome?: 'answered' | 'silent'
): void {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  // Every frame carries the current reading, so every frame is one the room
  // has now SEEN — including a republish or a `working_late` that lands
  // between a trailing flush being armed and firing. Recording it here rather
  // than only on the activity path is what stops that flush repeating a
  // reading already on screen. It can never suppress a needed frame: this only
  // ever equals what actually went out.
  claim.activityPublished = claim.activity;
  facet.deps.publishPresence(claim.roomId, claim.authorId, {
    state,
    entryId: claim.entryId,
    since: claim.claimedAt,
    // Every publish is self-contained, exactly as `since` already is: the
    // claim frame, the `working_late` frame, each ten-second republish and
    // the `done` all carry whatever is current. A client that connects
    // mid-turn therefore sees the verb on its first frame, with no separate
    // activity event to miss.
    ...(claim.activity ? { activity: claim.activity } : {}),
    // Only ever on a `done` frame, and only for the two outcomes that have
    // nothing durable to explain them — see {@link PRESENCE_OUTCOMES}.
    ...(outcome ? { outcome } : {}),
  });
}

/**
 * Who is mid-turn in one room right now, whatever cascade they are answering.
 *
 * Presence, and only presence. An agent that can see a colleague is already on
 * something can choose not to duplicate it — but nothing here waits, orders or
 * defers, and adding any of that would be the arbitration this domain has
 * declined twice (ADR 260726-170125).
 *
 * Includes turns the room has stopped WAITING for, because they are still
 * running. Those used to be missing, so the longest turns — the ones a
 * colleague most wants to know about before starting the same work — were the
 * only ones nobody was told about.
 *
 * **One entry per agent, and no de-duplication needed to get there.** The
 * map's grain IS `(room, agent)` and {@link RoomTriggerDispatcher.busyIn}
 * refuses a second claim, so an agent cannot appear twice. It could, before
 * DOR-752 was fixed, and the roster block an agent reads rendered "Working
 * right now: Ana, Ana" — a symptom of the real fault, which was that Ana was
 * running two turns. The collapse that hid it is gone with the cause.
 *
 * **Public, and narrowly so.** Two readers outside this class want it: the room
 * context an agent's turn is handed, and `RoomWithRoster.workingAgents` — the room
 * read a person's app does when it opens a room. Both are answering the
 * same question a member is entitled to ask about a room they are in, and the
 * row carries an author id and a start time and nothing else. What a claim also
 * knows — its cascade, its dispatch id, the entry it answers, the checkout it
 * runs in — stays inside, exactly as {@link RoomTriggerDispatcher.workingCount}
 * describes.
 *
 * @param roomId - The room being described.
 * @returns One row per agent mid-turn there, oldest claim first. Empty when the
 *   room is idle.
 */
export function workingIn(triggerOwner: object, roomId: string): RoomWorkingClaim[] {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  return claimsWorkingIn(facet.claimed, roomId);
}

/**
 * Every claim held right now, for the diagnostic read surface.
 *
 * "Which agent is holding a claim, and since when?" was the first question the
 * 2026-07-31 incident asked and could not answer: the claim map is in this
 * object's memory, and nothing outside the process could see it. Ids, an ISO
 * timestamp and a duration — no room text, no prompt, no path.
 *
 * @returns One row per live claim, newest hold last.
 */
export function listClaims(triggerOwner: object): ActiveClaimView[] {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  return describeClaims(facet.claimed);
}

/**
 * Every agent workspace with a turn running in it right now.
 *
 * An in-process seam for the room-worktree reap, which must not delete the
 * directory a live turn is standing in. Unlike
 * {@link RoomTriggerDispatcher.listClaims} this carries filesystem paths, so
 * it is deliberately not part of the diagnostic read surface.
 *
 * @returns Each distinct workspace path holding a claim.
 */
export function busyAgentPaths(triggerOwner: object): string[] {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  return claimedAgentPaths(facet.claimed);
}

/**
 * How many agents are working in one room right now.
 *
 * The narrow read the room list and the `room_presence` fan-out are given, in
 * place of the claim map itself: a count cannot be mistaken for a roster, and
 * no caller outside this class can start reasoning about cascades, sessions or
 * entry ids it has no business knowing.
 *
 * Agents and claims are the same number here, structurally rather than by
 * arithmetic: the map is keyed `(room, agent)`, so "one agent, two claims" is
 * not a state this class can hold. Nothing counts distinct authors, because
 * there is nothing to distinguish.
 *
 * @param roomId - The room being asked about.
 * @returns The number of agents holding a claim there. `0` when idle.
 */
export function workingCount(triggerOwner: object, roomId: string): number {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  return facet.workingIn(roomId).length;
}

/**
 * Whether this agent already has a turn running, and where — `null` when it is
 * free to take one.
 *
 * **Two ceilings, one lookup, because there are two different things a second
 * turn would collide with.**
 *
 * The first is this room's SESSION. A room binds one session per
 * `(room, agent)`, so a second turn there is a second writer on one
 * transcript answering a room that asked once. Deliberately blind to the
 * cascade, which is the whole point: this used to be a cascade-scoped union
 * fed into the guard's repeat rule, and that shape could only ever see a
 * re-trigger arriving inside the SAME exchange — so the common case, the next
 * message a person sends, sailed past it under a fresh root (DOR-752).
 *
 * The second is the agent's WORKING DIRECTORY, which is shared by every room
 * it is a member of. An agent is one checkout; two turns in it are two
 * processes editing the same files, and neither knows about the other
 * (room-participation spec, constraint 8). The `(room, agent)` key cannot see
 * this at all, so an agent in three rooms ran three turns in one tree — the
 * contention DOR-500 measured. The claim map spans every room this process
 * serves, so the answer is a scan of it rather than a guess.
 *
 * Both include turns the room has stopped WAITING for, because those are
 * still running — and on the shipped defaults that window is up to fifty
 * minutes, so it is where nearly every collision lives.
 *
 * **Both ceilings hold the message; the answer is a record rather than a
 * boolean because they differ in what a reader is shown.** A `here` hold marks
 * its messages as having arrived mid-turn and needs no indicator of its own —
 * the room is already showing the agent working. An `elsewhere` hold marks
 * nothing and publishes a `held` indicator pointing at the claim in the way,
 * which is why the claim itself comes back with the answer. See
 * {@link RoomTriggerDispatcher.collectOne}.
 *
 * @param roomId - The room being triggered.
 * @param authorId - The agent a trigger would run.
 * @param agentPath - That agent's directory, which is what the second ceiling
 *   is really about.
 * @returns What the room can truthfully say it is doing and the claim in the
 *   way, or `null` when it is doing nothing.
 */
export function busyWith(
  triggerOwner: object,
  roomId: string,
  authorId: string,
  agentPath: string
): ClaimBusy | null {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  return claimBusyWith(
    facet.claimed,
    roomId,
    authorId,
    agentPath,
    facet.deps.maxConcurrentTurnsPerAgent()
  );
}
