/**
 * Posting what a turn said back into the room, on time or late.
 *
 * Split out of `room-trigger.ts` without changing a line of logic. Each function
 * here is the body of a {@link RoomTriggerDispatcher} method of the same name,
 * which delegates to it with itself as `self`.
 *
 * @module server/services/rooms/room-trigger/deliver
 */
import type { Room, RoomEntry } from '@dorkos/shared/room-schemas';
import { logger } from '../../../lib/logger.js';
import { agentKey, type ClaimOutcome, type TriggerTarget } from '../room-claims.js';
import { usageLimitNow } from '../notices/usage-limit.js';
import { type LateRoomReply, type RoomTurnReply } from '../room-turn-port.js';
import type { RoomTriggerDispatcher } from '../room-trigger.js';

/**
 * Put one turn's outcome into the room: what it chose to say, or why there is
 * nothing.
 *
 * Only ever called with a SETTLED turn — never with the `{ text: null, late }`
 * a runner returns at the wait deadline, which carries no outcome at all and
 * whose recovery-clearing branch would then fire for an agent that has not
 * answered anything (see {@link RoomTriggerDispatcher.runOne}).
 *
 * ## Nothing here posts the turn's text, and nothing ever will
 *
 * A turn speaks by calling `post_to_room` while it runs, or by reacting, or
 * not at all (spec `tool-only-room-replies`, graduated by DOR-2099). What is
 * left in `reply.text` when this runs is the agent's thinking, written back to
 * its own session, and it belongs to whoever is reading that session. So this
 * function reads MARKS rather than words, and its three terminals, in this
 * order, are the whole design:
 *
 * 1. **The agent posted through the tool** → `'answered'`. Its words are
 *    already in front of the reader, carrying their own timestamp — which is
 *    also why a late answer gets no "how long it took" prefix here: the answer
 *    landed when the agent posted it, and a note about the wait would be
 *    attached to nothing.
 * 2. **The agent reacted** → `'answered'`. A thumbs-up can BE the answer, so
 *    the room shows something and nothing is owed (§D10). Only a reaction that
 *    LANDED sets the mark.
 * 3. **Neither** → `'quiet'`, plus one `agent_declined` line if a person
 *    asked. That split is room-participation §10.2.2's and is not re-derived:
 *    the obligation attaches to being asked, never to running a turn, so an
 *    ambient turn writes nothing durable, ever.
 *
 * **Both marks are TAKEN, not read** — a claim outlives its answer under RP8's
 * park-and-resume, and a standing mark would swallow the next delivery. See
 * {@link RoomTriggerDispatcher.takeSpokeViaTool}.
 *
 * @param opts.reply - What the turn produced, from the runner.
 * @param opts.late - Set on a late answer, for the log line that records one.
 * @returns What happened, for the claim release to report.
 */
export function deliver(
  self: RoomTriggerDispatcher,
  opts: {
    room: Room;
    entry: RoomEntry;
    target: TriggerTarget;
    reply: RoomTurnReply;
    late?: { waitedMs: number };
  }
): ClaimOutcome {
  const { room, entry, target, reply } = opts;
  // **A halted turn delivers nothing, and that includes its notices.** Stop
  // already spoke for this turn — one `halted` line, written before the claims
  // were dropped — and every other outcome here would speak over it: an answer
  // makes the halt look like it did nothing, and a `turn_failed` line about an
  // interrupt the person asked for is the room apologising for obeying.
  // Checked ahead of `unanswered` for exactly that second reason, since a
  // runtime that stops promptly ends its turn in an error.
  //
  // **It skips the RE-ARM below as well as the writes, and that is the right
  // half of "nothing".** `notices.recovered` means "this agent answered here,
  // so whatever was blocking it is over" — evidence a halted turn does not
  // supply: nobody learned whether the agent is still busy, still failing or
  // still gone, because the turn was cut off rather than finished. Re-arming
  // on it would spend the next real refusal's one line on a question this
  // turn never answered. The next turn that genuinely answers re-arms it.
  if (self.wasHalted(target.dispatchId)) {
    logger.info('[rooms] dropped a halted turn answer', {
      roomId: room.id,
      authorId: target.authorId,
      entryId: entry.id,
      dispatchId: target.dispatchId,
      // Whether there was anything to drop, which is what tells a race the
      // interrupt won from one it lost. Never the text: a room log line is no
      // place for what an agent was in the middle of saying.
      hadAnswer: (reply.text?.trim() ?? '') !== '',
    });
    return 'halted';
  }
  if (reply.unanswered === 'busy' && self.retryWhenFree(room, entry, target)) {
    return reply.unanswered;
  }
  if (reply.unanswered) {
    const gaveUp =
      reply.unanswered === 'busy' && self.receipts.isRetrying(room.id, target.authorId, entry.id);
    const limit =
      reply.unanswered === 'failed'
        ? usageLimitNow(
            self.deps.usageLimitFor,
            self.deps.store.getRoomSession(room.id, target.authorId) ?? target.sessionId
          )
        : null;
    self.notices.reportSilence(
      room,
      entry,
      target,
      reply.unanswered,
      target.dispatchId,
      gaveUp ? { busyWith: 'gave-up' } : limit ? { outOfUsageUntil: limit.resetsAt } : {}
    );
  }
  self.receipts.forgetRetry(room.id, target.authorId, entry.id);
  if (reply.unanswered) return reply.unanswered;

  // The turn ran and nothing refused it, so whatever was blocking this agent
  // here is over. Recovery IS the re-arm: the next time it cannot answer, the
  // room says so again — for every reason, because an answer landing is
  // evidence against all of them at once.
  //
  // **A turn that DECLINED reaches this line too, and that is correct.** A
  // quiet turn proves the agent is reachable, which is exactly what the busy /
  // gone / unavailable keys damp on. It is why `agent_declined` re-arms on
  // {@link RoomNoticeLog.answered} instead: a key this line cleared would be
  // cleared by the very turn that set it.
  self.notices.recovered(room.id, target.authorId);

  if (self.takeSpokeViaTool(room.id, target.authorId)) {
    // Taken as well, and discarded. Both marks live on the claim, and under
    // park-and-resume a claim outlives its first answer (spec D1: marks are
    // TAKEN, not read), so a reaction left standing here would count as the
    // answer to that claim's next delivery. No test drives that second
    // delivery today; this line is what keeps it honest when one does.
    self.takeReactedViaTool(room.id, target.authorId);
    if (opts.late !== undefined) {
      logger.info('[rooms] a late turn had already posted its answer', {
        roomId: room.id,
        authorId: target.authorId,
        entryId: entry.id,
        waitedMs: opts.late.waitedMs,
      });
    }
    return 'answered';
  }
  if (self.takeReactedViaTool(room.id, target.authorId)) return 'answered';
  const displayName = self.deps.authors.getById(target.authorId)?.displayName ?? 'An agent';
  self.notices.reportDeclined(
    room,
    entry,
    { authorId: target.authorId, displayName },
    target.dispatchId
  );
  return 'quiet';
}

/**
 * Post an answer the room stopped waiting for, once it lands — and release
 * the claim that has been saying, all along, that the agent is still on it.
 *
 * The turn was never cancelled, so it is still the agent's own to settle: if
 * it posted through the tool while it ran, the answer is already in the room
 * carrying its own timestamp, and if it posted nothing this is where the room
 * says so. The claim on `(room, agent)` is still held when this runs (see
 * {@link RoomTriggerDispatcher.runOne}'s `finally`), which is what makes the
 * late window honest rather than a hole.
 *
 * **The release is in `finally`, and it is deliberately the last thing.** It
 * has to run on both settlements — the answer landing and the delivery
 * throwing — because a claim nothing clears is an agent that is "working"
 * until the process restarts. And it has to run AFTER the durable write above,
 * because the claim is the assertion that this agent owes the room something:
 * dropping it before the post or the notice is on the log is a promise
 * withdrawn a moment before it is kept. Now that the release also publishes
 * `done`, that ordering is what a person sees — the answer lands, and then the
 * indicator goes, never the other way round.
 *
 * @param opts.late - The runner's promise of the eventual outcome.
 */
export function deliverLate(
  self: RoomTriggerDispatcher,
  opts: {
    room: Room;
    entry: RoomEntry;
    target: TriggerTarget;
    late: Promise<LateRoomReply>;
  }
): void {
  const key = agentKey(opts.room.id, opts.target.authorId);
  self.inFlight += 1;
  let outcome: ClaimOutcome = 'quiet';
  void opts.late
    .then((reply) => {
      outcome = self.deliver({
        room: opts.room,
        entry: opts.entry,
        target: opts.target,
        reply,
        late: { waitedMs: reply.waitedMs },
      });
    })
    .catch((err) => {
      outcome = 'failed';
      logger.warn('[rooms] a late answer never landed', {
        roomId: opts.room.id,
        authorId: opts.target.authorId,
        error: err instanceof Error ? err.message : String(err),
      });
      // An infrastructure failure this deep into a turn used to leave a log
      // line and nothing else: the room had shown the agent working for up to
      // an hour and then simply stopped, with no answer and nothing on the log
      // to explain either. It gets the same `turn_failed` notice every other
      // failure gets — best-effort, and undamped like the rest of them,
      // because an error that just happened is never a repeat of one that did.
      self.notices.reportSilence(
        opts.room,
        opts.entry,
        opts.target,
        'failed',
        opts.target.dispatchId
      );
    })
    .finally(() => {
      // Guarded like the in-frame release, and for a window that is WIDER
      // here: this claim has been held across the whole late wait, so a halt
      // and a fresh message have had minutes rather than milliseconds to hand
      // the key to somebody else.
      self.releaseOwnClaim(key, opts.target.dispatchId, outcome);
      // The last delivery this turn had, so the halt mark ends here.
      self.forgetHalt(opts.target.dispatchId);
      self.settleOne();
    });
}
