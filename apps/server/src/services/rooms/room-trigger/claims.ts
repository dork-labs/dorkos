/**
 * Releasing turn claims, and the working indicator the claim map publishes on
 * the room's ephemeral lane. Taking a claim stays on the dispatcher
 * (`holdClaim`), beside the republish interval it arms.
 *
 * Split out of `room-trigger.ts` without changing a line of logic. Each function
 * here is the body of a {@link RoomTriggerDispatcher} method of the same name,
 * which delegates to it with itself as `self`.
 *
 * @module server/services/rooms/room-trigger/claims
 */
import type { RoomPresenceState } from '@dorkos/shared/room-schemas';
import type { SessionActivity } from '@dorkos/shared/session-stream';
import { sameActivity } from '../presence/same-activity.js';
import { logger } from '../../../lib/logger.js';
import { recordDispatchEnd } from '../../observability/dispatch-buffers.js';
import { ACTIVITY_FANOUT_THROTTLE_MS } from '../../session/index.js';
import {
  DISPATCH_OUTCOMES,
  PRESENCE_OUTCOMES,
  type ActiveClaim,
  type ClaimOutcome,
} from '../room-claims.js';
import type { RoomTriggerDispatcher } from '../room-trigger.js';

/**
 * Release the claim a turn is holding — **but only if it is still that turn's
 * claim.**
 *
 * A claim key is `(room, agent)` and a turn is a DISPATCH, and the two part
 * company exactly once: when something releases a claim early and the same
 * agent is claimed again before the first turn's own terminal arrives. RP8's
 * halt is that something. Stop drops the claim, the person types again, the
 * next turn claims the same key — and then the stopped turn's runtime finally
 * comes back and its `finally` releases a claim belonging to a turn that is
 * still running. Measured: the room shows nobody working while an agent is
 * mid-answer, the `(room, agent)` ceiling is gone, and a third message starts
 * a SECOND concurrent turn in the same working tree — which is the contention
 * DOR-500 measured and the ceiling exists to prevent.
 *
 * It also fixes what the log said. `releaseClaim` records the dispatch end
 * against the CLAIM's dispatch id, so an unguarded release closed out the live
 * turn's dispatch carrying the dead turn's outcome.
 *
 * The dead turn needs no release of its own: whatever released its claim early
 * — the halt — already published `done` and recorded its dispatch end while it
 * still held the key.
 *
 * @param key - The `(room, agent)` key this turn claimed.
 * @param dispatchId - The turn asking to release, which must still be the
 *   holder.
 * @param outcome - What the turn produced, for the log. Never rendered.
 */
export function releaseOwnClaim(
  self: RoomTriggerDispatcher,
  key: string,
  dispatchId: string,
  outcome: ClaimOutcome
): void {
  const held = self.claimed.get(key);
  // Already released by whatever stopped this turn — the halt, and nothing
  // else today. Releasing nothing has always been a no-op here.
  if (held === undefined) return;
  if (held.dispatchId !== dispatchId) {
    logger.debug('[rooms] a finished turn left a newer turn holding the claim', {
      roomId: held.roomId,
      authorId: held.authorId,
      finished: dispatchId,
      holding: held.dispatchId,
      outcome,
    });
    return;
  }
  self.releaseClaim(key, outcome);
}

/**
 * Release a claim, and tell the room the agent is done.
 *
 * **Every terminal releases here and only here**, which is what makes the
 * ordering rule structural rather than remembered: `deliver` and
 * `reportSilence` have already returned by the time either `finally` calls
 * this, so the durable entry that explains the release is on the stream before
 * the indicator drops. A `done` published at each terminal instead would be
 * four call sites, and the fifth — RP8's halt, which drops every pending claim
 * — would have to remember to be the fifth.
 *
 * **Whether a turn may release is not asked here**, and deliberately: this
 * takes a KEY, and the two turn `finally`s must ask about a DISPATCH. They go
 * through {@link RoomTriggerDispatcher.releaseOwnClaim} for that. Halting is
 * the one caller that releases by key alone, because it is stopping whatever
 * holds the key rather than finishing a turn of its own.
 *
 * Releasing a key that is not held is a no-op rather than a throw, because
 * this is reached on paths where the claim may already be gone. The map is the
 * only record that an indicator is outstanding, so a `done` for a claim nobody
 * holds would be an event about nothing.
 *
 * @param key - The `(room, agent)` key being released.
 * @param outcome - What the turn produced, for the log. Never rendered.
 */
export function releaseClaim(
  self: RoomTriggerDispatcher,
  key: string,
  outcome: ClaimOutcome
): void {
  const claim = self.claimed.get(key);
  if (!claim) return;
  logger.info('[rooms] an agent finished a room turn', {
    roomId: claim.roomId,
    authorId: claim.authorId,
    entryId: claim.entryId,
    dispatchId: claim.dispatchId,
    heldMs: Math.max(0, Date.now() - Date.parse(claim.claimedAt)),
    outcome,
  });
  // Every terminal reaches here — the ordinary one, a late answer settling,
  // and a halt — so this is the one place a room dispatch can be closed out
  // exactly once. Recorded beside the log line rather than at each terminal,
  // for the reason the release itself is here.
  recordDispatchEnd(claim.dispatchId, DISPATCH_OUTCOMES[outcome]);
  // The turn is over, so whatever it was waiting for is over too. Cleared
  // here rather than beside an outcome because a halted turn, a crashed turn
  // and an answered one all end the wait equally, and only this line runs on
  // all three.
  self.notices.turnEnded(claim.roomId, claim.authorId);
  // The turn that owned these messages is over, so their 👀 comes off: up to
  // the message it answered, never one that arrived later and still waits.
  self.receipts.clearUpTo(
    key,
    self.deps.store.getEntryById(claim.roomId, claim.entryId)?.seq ?? Number.POSITIVE_INFINITY
  );
  const before = self.workingCount(claim.roomId);
  self.claimed.delete(key);
  // Before the `done`, in the same block that stops the republish timer: an
  // armed trailing publish for a claim nobody holds is a `working` frame
  // landing AFTER the `done` that retired it, which is a lane that never
  // clears. `halt` releases through this seam and inherits it.
  self.disarmActivityFlush(claim);
  // And the `done` itself carries no reading. A turn that has ended is not
  // doing anything, which is what `RoomSignalEvent.activity` promises — and a
  // halt reaches here without the runner ever having cleared.
  claim.activity = undefined;
  // **How the turn finished, on the lane that drops it** (spec
  // `tool-only-room-replies` §D7). A working pill that appears and vanishes
  // with nothing to show reads as a crash, and a turn that decides nothing
  // needs saying is now an ordinary outcome rather than a rare one. Only the
  // two outcomes a person can act on are said: `answered` and `silent`. Every
  // other one — halted, busy, failed, gone — already has a durable line of its
  // own explaining it, and a second, ephemeral statement beside it would be
  // the room saying the same thing twice.
  //
  // **On every room turn**, since every room turn now speaks by calling the
  // tool or not at all (spec §A2, D7). It was once published only for a turn
  // that had resolved `'tool-only'`, so that a flag-off install stayed
  // byte-identical to the release before the experiment; there is no flag and
  // no other mode to be identical to.
  //
  // Past tense, and deliberately not durable: E16a exempts a mechanical
  // presence signal from every speaking rule, and a restart forgetting this
  // costs nothing because the fact was already over.
  self.publishPresence(claim, 'done', PRESENCE_OUTCOMES[outcome]);
  self.publishWorkingCount(claim.roomId, before);
  if (self.republishing !== null && self.claimed.size === 0) {
    clearInterval(self.republishing);
    self.republishing = null;
  }
  // **The steer's other half, and it belongs exactly here** (RP8). Whatever
  // this agent was asked while it was working has been held rather than
  // refused, and this is the moment it can be answered. Hung off the one place
  // every claim is released — the ordinary terminal, a late answer settling,
  // and a halt all reach it — so there is no path that can forget to look. A
  // halt has already dropped the room's collections by the time it gets here,
  // which is why stopping a room does not answer the messages it was stopped
  // over.
  self.collector.resume(claim.roomId, claim.authorId);
  // **And the cross-room half of it** (spec `room-hold-when-busy`). One agent
  // is one working directory, so the rooms this agent was asked something in
  // while it worked here have been waiting rather than being refused, and this
  // is the moment they can run. Hung off the same one seam for the same reason:
  // the ordinary terminal, a late answer settling, a failure and a halt all
  // reach it, so a held message runs however the blocking turn ended.
  self.resumeElsewhere(claim.agentPath);
  // A hand-off waiting on this seat, or on this agent's working tree, may run now (DOR-3397).
  // Not after a turn the runtime refused as busy: that turn freed nothing, and waking on it let
  // two waiting hand-offs wake each other with every refusal, ten times a second (DOR-3516).
  if (outcome !== 'busy') for (const wake of [...self.releaseWaiters]) wake(claim);
}

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
  self: RoomTriggerDispatcher,
  key: string,
  activity: SessionActivity | null
): void {
  const claim = self.claimed.get(key);
  // Released, halted, or never taken. A turn that outlives its claim says
  // nothing: there is no indicator left for this to be about.
  if (claim === undefined) return;

  if (activity === null) {
    if (claim.activity === undefined) return;
    claim.activity = undefined;
    self.disarmActivityFlush(claim);
    self.publishActivityNow(claim);
    return;
  }

  if (sameActivity(claim.activity, activity)) return;

  claim.activity = activity;
  const waited = Date.now() - claim.activityPublishedAt;
  if (waited >= ACTIVITY_FANOUT_THROTTLE_MS) {
    self.disarmActivityFlush(claim);
    self.publishActivityNow(claim);
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
    self.publishActivityNow(claim);
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
export function publishActivityNow(self: RoomTriggerDispatcher, claim: ActiveClaim): void {
  self.publishPresence(claim, claim.pastDeadline ? 'working_late' : 'working');
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
export function disarmActivityFlush(self: RoomTriggerDispatcher, claim: ActiveClaim): void {
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
export function republishPresence(self: RoomTriggerDispatcher): void {
  // Before the re-state, so nothing that has outlived the room's patience is
  // announced one more time on its way out.
  self.expireHolds();
  self.resumeFreedHolds();
  const rooms = new Set<string>();
  for (const claim of self.claimed.values()) {
    self.publishPresence(claim, claim.pastDeadline ? 'working_late' : 'working');
    rooms.add(claim.roomId);
  }
  for (const record of self.held.values()) self.publishHold(record, 'held');
  // One repaint per ROOM, not per claim: the sidebar draws a count, so two
  // claims in one room are one dot and one event. The global stream has no
  // replay, so this tick is the only way a reader who opened the cockpit
  // mid-turn — or reconnected — learns that a room they do not have open is
  // busy. Nothing is compared against a previous count here: the tick's job
  // is to re-state, and a tick that suppressed an unchanged count would never
  // reach the reader who missed the transition.
  for (const roomId of rooms) {
    self.deps.publishWorkingCount(roomId, self.workingCount(roomId));
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
export function publishWorkingCount(
  self: RoomTriggerDispatcher,
  roomId: string,
  before: number
): void {
  const after = self.workingCount(roomId);
  if (after !== before) self.deps.publishWorkingCount(roomId, after);
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
  self: RoomTriggerDispatcher,
  claim: ActiveClaim,
  state: RoomPresenceState,
  outcome?: 'answered' | 'silent'
): void {
  // Every frame carries the current reading, so every frame is one the room
  // has now SEEN — including a republish or a `working_late` that lands
  // between a trailing flush being armed and firing. Recording it here rather
  // than only on the activity path is what stops that flush repeating a
  // reading already on screen. It can never suppress a needed frame: this only
  // ever equals what actually went out.
  claim.activityPublished = claim.activity;
  self.deps.publishPresence(claim.roomId, claim.authorId, {
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
