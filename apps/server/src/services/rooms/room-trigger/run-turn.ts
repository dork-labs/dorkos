/**
 * Running one claimed room turn to its terminal, inside its dispatch scope.
 *
 * Split out of `room-trigger.ts` without changing a line of logic. Each function
 * here is the body of a {@link RoomTriggerDispatcher} method of the same name,
 * which delegates to it with itself as `self`.
 *
 * @module server/services/rooms/room-trigger/run-turn
 */
import type { Room, RoomEntry } from '@dorkos/shared/room-schemas';
import { logger } from '../../../lib/logger.js';
import { recordDispatchStart } from '../../observability/dispatch-buffers.js';
import { agentKey, type ClaimOutcome, type TriggerTarget } from '../room-claims.js';
import { ceilingForEntries, isEntryAuthorExternal } from '../limits/turn-ceiling.js';
import { teammateOf } from '../limits/space-teammates.js';
import { turnRefusalOf } from '../turn-guards/paused-turn.js';
import { buildRoomContext } from '../room-context.js';
import { roomLaunchStepFor } from '../repo/room-launch-step.js';
import { type LateRoomReply, type RoomTurnReply } from '../room-turn-port.js';
import type { RoomTriggerDispatcher } from '../room-trigger.js';

/** The body of {@link RoomTriggerDispatcher.runOne}, already inside its scope. */
export async function runOneInDispatch(
  self: RoomTriggerDispatcher,
  room: Room,
  entry: RoomEntry,
  target: TriggerTarget
): Promise<void> {
  const key = agentKey(room.id, target.authorId);
  recordDispatchStart({
    dispatchId: target.dispatchId,
    origin: 'room',
    roomId: room.id,
    sessionId: target.sessionId,
  });
  // What the release in the `finally` will report. Only the paths that reach a
  // terminal here set it; a turn handed to `deliverLate` does not release from
  // this frame at all, so its outcome is that method's to report.
  let outcome: ClaimOutcome = 'quiet';
  try {
    // **Where this turn runs, decided before anything describes it.** Always
    // the agent's home (spec `agent-home-desk` §5.1), with the room's folders
    // granted when it has files of its own — and the files section measured
    // against the copy it is granted. The context below names attachment
    // paths relative to `cwd` and the runner puts the files there.
    const place = await self.placeTurn(room.id, target.agentPath, target.displayName);
    const { cwd } = place;
    const files = place.files ?? undefined;
    // Built before the request so the context and the projection plan it
    // implies are one value, resolved once.
    const turnContext = buildRoomContext(self.deps, {
      room,
      agentAuthorId: target.authorId,
      // What this room's files hold for this agent, measured against the copy
      // the line above granted. Absent for every room without files of its
      // own, which renders nothing (spec §3.7).
      files,
      // The folder the turn below runs in, so a file the context names is
      // named by a path that opens from where the agent stands (DOR-1266).
      // The same value reaches the runner as `cwd` a few lines down.
      cwd,
      entry,
      working: self.workingIn(room.id),
      // The cursor as it stood before the claim moved it. The stored row has
      // already advanced past this entry, so reading it here would describe
      // an empty window every time (room-participation spec §8.3).
      lastReadSeq: target.lastReadSeq,
      // Both halves of what is left to spend, resolved together so they can
      // never disagree about whether anything is counting.
      ...self.headroomFor(room.id, target.depth),
      engaged: target.engaged,
      // A person is owed this agent's answer, though the message did not name
      // it (DOR-2823): the block then never offers silence.
      ...(target.answerOwed ? { answerOwed: target.answerOwed } : {}),
      // Which of the messages in that window landed while this agent was
      // already working (RP8). Without it a steered turn reads as a person
      // repeating themselves, when what actually happened is that they carried
      // on talking while the agent was busy.
      arrivedDuringPrevTurn: target.arrivedDuringPrevTurn,
      // And which of them this turn OWES AN ANSWER TO. The two sets answer
      // different questions and only this one decides what the reply has to
      // cover: without it a gathered burst rendered as unread background, and
      // an agent handed three questions answered the newest and dropped the
      // rest (DOR-1231).
      gathered: target.gathered,
    });
    // A space's local copy, where every message nobody vouched for is a teammate's (DOR-2955).
    const inSpaceRoom = self.deps.isSpaceRoom?.(room.id) === true;
    const result = await self.deps.runner.run({
      room,
      authorId: target.authorId,
      agentPath: target.agentPath,
      // The agent's home, the same value the context was built against —
      // never resolved a second time — and the room's folders it may reach.
      cwd,
      additionalDirectories: place.additionalDirectories,
      worktree: place.worktree,
      ...roomLaunchStepFor(self.deps, room.id, target.authorId, target.agentPath, place),
      sessionId: target.sessionId,
      entry,
      // **Who wrote it, as a trust boundary** — see `RoomTurnRequest`. Read
      // off the author's stored key, and read HERE because this is where the
      // registry is.
      //
      // The missing-record case is spelled out rather than folded into a
      // `?? ''` default, because `authorOrigin('')` answers `'local'` — an
      // empty string does not start with the external prefix — and that is
      // the permissive direction. An author this dispatcher cannot resolve is
      // treated as external: losing the operator's power level for one turn
      // costs a prompt, while reading an unknown author as local would hand
      // it out on the strength of a failed lookup.
      //
      // Over EVERY message the turn answers: a gathered burst that mixes a
      // stranger and a person is external if any author is.
      externalAuthor: (target.answers ?? [entry]).some((answered) =>
        isEntryAuthorExternal(self.deps.authors, answered.authorId)
      ),
      // And the turn itself is held to the strictest of its senders' levels,
      // new conversation or not — see `RoomTurnRequest.permissionCeiling`.
      ...ceilingForEntries(self.deps.authors, target.answers ?? [entry], inSpaceRoom),
      // And whether any of them is a teammate's — a space member who is not
      // the owner — which takes away asking and every room but this one
      // (DOR-2955).
      ...teammateOf(self.deps.authors, target.answers ?? [entry], inSpaceRoom),
      // The message, unchanged. A trigger asks the agent exactly what was
      // said; only the welcome-back offer below asks something else.
      prompt: entry.body.text,
      // Derived HERE rather than in the runner, and after every target of this
      // entry has been claimed: `working` is read off the live claim map, so a
      // second agent addressed by the same message is already in it. Assembling
      // it runs no model and takes no turn — silence has to stay free
      // (`meta/agent-etiquette.md` E7).
      roomContext: turnContext.context,
      // The files that context refers to, carried to the runner so it can put
      // them where the context says they are — never recomputed there, which
      // is the point of returning them together (ADR 260807-233816).
      attachmentProjection: turnContext.projection,
      // Reported WHILE the turn is still running, which is what makes it
      // worth reporting at all: a turn parked on a person produces nothing
      // until that person acts, and on 2026-07-31 that state was invisible
      // everywhere — no room entry, no log line — for up to forty-one minutes
      // per agent (DOR-784). The claim stays held throughout, because the
      // agent has not finished; this only adds the durable line that says why
      // the indicator is not moving.
      onWaiting: (waiting) =>
        self.notices.reportWaiting(
          room,
          entry,
          { authorId: target.authorId, displayName: target.displayName },
          waiting
        ),
      // What the turn is doing, for the room's live lane (DOR-1351). Keyed on
      // the claim rather than the frame, so a reading that arrives after this
      // scope is gone reaches nothing rather than a stale object.
      onActivity: (activity) => self.noteActivity(agentKey(room.id, target.authorId), activity),
      // Onto the live claim, where a mid-turn `post_to_room` reads it: the
      // session id stamps the entry with the turn that wrote it (spec
      // `tool-only-room-replies` §D8).
      onSessionBound: (id) => self.noteSessionBound(room.id, target.authorId, id),
    });

    // A REFUSAL IS NOT A READING. The claim moved this agent's cursor to the
    // triggering entry on the assumption that the turn would be SHOWN what sits
    // behind it — but `busy` is the runner declining before any model ran, so
    // nothing was shown and nothing was read. Left forward, the whole backlog
    // is permanently invisible, and the notice this outcome writes ("send it
    // again when Ana is free") invites a message that would land ABOVE the
    // advanced cursor and arrive with no context at all.
    if (result.unanswered === 'busy') self.rewindClaimCursor(room, entry, target);

    // The turn ran on a session; that session is the one this agent must
    // resume here next time. It is not always the one the room asked with —
    // Claude Code assigns its own id on the first turn and files the
    // transcript under it — so the binding follows the runner's answer rather
    // than the id minted before the turn. Written before anything is
    // delivered: a post that throws must not cost the room its memory.
    if (result.sessionId !== target.sessionId) {
      self.deps.store.rebindRoomSession(room.id, target.authorId, result.sessionId);
    }

    // Armed BEFORE this dispatch settles, so `idle()` cannot report a room
    // quiet while an answer is still on its way to it.
    //
    // **An either/or, and it has to be.** A late result is
    // `{ text: null, late, unanswered: undefined }` — indistinguishable, to
    // `deliver`, from a turn that ran and chose to say nothing. Delivering it
    // anyway ran `deliver`'s recovery branch AT THE WAIT DEADLINE and cleared
    // every damping key for an agent that had not answered a thing, so the
    // next refusal for it wrote a second apology. The answer is delivered
    // through `deliverLate` when it actually lands, which is the moment
    // recovery is honest.
    if (self.wasHalted(target.dispatchId)) {
      // Stop reached this turn while it was running, so there is nothing left
      // to deliver — `deliver` would drop the answer anyway, and this is the
      // branch that also declines to WAIT for one. A halted turn that outran
      // the room's patience would otherwise hold a room dispatch open for up
      // to `rooms.lateReplyCeilingMinutes` to post nothing at the end of it.
      outcome = 'halted';
      // The runner's contract is resolve-or-reject, so a promise nobody reads
      // is still a rejection somebody must catch — the room simply is not
      // listening to this one any more. The turn itself keeps streaming into
      // its own session, where a person can still read what it was saying.
      result.late?.catch(() => undefined);
    } else if (result.late) {
      self.deliverLate({ room, entry, target, late: result.late });
      // Marked only AFTER the release above is armed, and the order is the
      // whole safety of it: the `finally` below reads this flag to decide
      // whether the turn is still running, so a claim marked before
      // `deliverLate` had attached its handlers would be held by a promise
      // chain that never existed and released by nothing.
      const claim = self.claimed.get(key);
      if (claim) {
        claim.pastDeadline = true;
        // The deadline's only announcement. It is deliberately not a notice:
        // a durable line about every slow turn is a second message about every
        // slow turn, and the late answer already says how long it took
        // (room-presence spec §18). Published once here; every republish from
        // now on carries `working_late` because it reads the same flag.
        self.publishPresence(claim, 'working_late');
      }
    } else {
      outcome = self.deliver({ room, entry, target, reply: result });
    }
  } catch (err) {
    outcome = 'failed';
    // Same argument as the `busy` rewind above, over the other half of the
    // same window. A throw out of `run` means the turn NEVER STARTED — the
    // session would not open, the runtime was unreachable — so no model saw
    // the backlog. A model that ran and then failed comes back as
    // `unanswered: 'failed'` instead, and that one keeps the advance: it was
    // shown the messages, and repeating them next turn is the duplicate RP3
    // exists to stop.
    //
    // **That reading is a contract the runner owes this line**, not something
    // observable from here: a throw raised AFTER the model streamed looks
    // identical, and would replay the whole window to the next turn. It held
    // by luck until a `persistSessionRuntime` await sat above the busy guard
    // and turned a `SQLITE_BUSY` on one bookkeeping row into exactly that.
    // `room-turn-runner.ts` now states the rule where it has to be kept —
    // nothing after the model has spoken may throw past `run`.
    self.rewindClaimCursor(room, entry, target);
    // The failure detail belongs on the agent's own session stream, where the
    // turn machinery already surfaces it — a room log is no place for a stack
    // trace. But the FACT belongs here: a turn that threw and said nothing is
    // indistinguishable from an agent that ignored you (DOR-621).
    logger.warn('[rooms] triggered turn failed', {
      roomId: room.id,
      authorId: target.authorId,
      error: err instanceof Error ? err.message : String(err),
    });
    // **One throw out of `run` is not a failure at all, and the room has to
    // say so differently** (DOR-1720). A session bound to a runtime this
    // server is not running refuses every turn by design, and as a
    // `turn_failed` that read as a broken agent, pointed at a session no turn
    // had ever opened, and named neither the program nor a way back. The
    // runner's refusal carries the runtime, which is exactly what the
    // `runtime_gone` line is written out of.
    // A paused agent is not a failure either: somebody chose it, and the
    // room says so once per pause (spec `audit-trail` PR5).
    const refused = turnRefusalOf(err);
    // A turn that threw because somebody stopped it did what it was told. The
    // `halted` notice is already on the log and is the whole story; an
    // apology under it would be the room reporting the person's own control
    // action back to them as a fault.
    if (self.wasHalted(target.dispatchId)) outcome = 'halted';
    else if (refused) {
      // Named on the claim as well as in the room: `DISPATCH_OUTCOMES` files
      // both as `refused` rather than `failed`, so an operator counting
      // crashes in the debug buffer does not find a refusal among them.
      outcome = refused.reason;
      self.notices.reportSilence(room, entry, target, refused.reason, target.dispatchId, refused);
    } else self.notices.reportSilence(room, entry, target, 'failed', target.dispatchId);
  } finally {
    // `runner.run()` resolving is the end of the WAIT, which is only the end
    // of the TURN when the turn beat the deadline. A late turn is still
    // running and must still read as working — to the guard, to a room-mate
    // reading `room_context.working`, and to the person watching.
    // {@link RoomTriggerDispatcher.deliverLate} releases it when the answer
    // finally settles, whichever way it settles.
    //
    // Two reads of the same map entry asking two different questions, which is
    // why they are not one condition: whether this turn is OVER (it is not, if
    // it went late), and whether the claim under this key is still THIS turn's
    // to release ({@link RoomTriggerDispatcher.releaseOwnClaim}).
    if (self.claimed.get(key)?.pastDeadline !== true) {
      self.releaseOwnClaim(key, target.dispatchId, outcome);
    }
    // **Unconditional, and safe even for a turn `deliverLate` still owes an
    // answer.** A dispatch can only be MARKED while its claim is held, and a
    // late turn's claim outlives this frame — so at this line a turn that
    // went late is provably unmarked and this deletes nothing, while the halt
    // that marks it later is followed by `deliverLate`'s own cleanup. A turn
    // marked before it went late never reaches here at all: the halted branch
    // above declines to arm the late delivery.
    self.forgetHalt(target.dispatchId);
  }
}

/**
 * Wait out a turn the room stopped waiting for, saying so while it runs.
 *
 * The claim is NOT released here: the agent is still working in its own
 * checkout, so both busy ceilings must keep seeing it and the room must keep
 * showing it. What changes is only what the indicator says — `working_late`
 * from this point, re-stated by the republish loop because it reads the same
 * flag.
 *
 * Never rejects: `RoomTurnResult.late` is contractually resolve-or-reject and
 * a rejection here is a turn that produced nothing, which is the same silence
 * as an agent with nothing to offer.
 *
 * @param late - The runner's promise of the eventual outcome.
 * @param key - The `(room, agent)` claim key, for the indicator.
 * @returns What the turn finally produced.
 */
export async function awaitLate(
  self: RoomTriggerDispatcher,
  late: Promise<LateRoomReply>,
  key: string
): Promise<RoomTurnReply> {
  const claim = self.claimed.get(key);
  if (claim) {
    claim.pastDeadline = true;
    self.publishPresence(claim, 'working_late');
  }
  try {
    return await late;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn('[rooms] a late welcome-back offer never landed', { error: detail });
    return { text: null, unanswered: 'failed', failure: { detail } };
  }
}

/**
 * Undo the claim's cursor advance for a turn that never reached a model.
 *
 * The advance at claim time is deliberate and load-bearing: a turn that fails
 * midway has still SEEN what it was shown, and replaying that would hand the
 * agent the same conversation twice (room-participation spec §8.3). It buys
 * that by assuming the turn is about to be shown something — and two paths
 * reach a terminal before it is. The session was busy, or `run` threw on the
 * way in. On both, no `room_context` ever reached a model, so the messages
 * behind the cursor were never delivered to anybody and the room owes them to
 * the next turn.
 *
 * **Compare-and-set, not an assignment.** It restores only if the stored value
 * is still exactly the one this claim wrote. A second turn claimed for the
 * same member in between has already moved it forward and is relying on it, so
 * the predicate misses and this does nothing — which is the correct answer,
 * because that turn WAS shown the window.
 *
 * @param room - The room the turn was refused in.
 * @param entry - The entry it would have answered; the value the claim wrote.
 * @param target - The refused target, carrying the cursor it had before.
 */
export function rewindClaimCursor(
  self: RoomTriggerDispatcher,
  room: Room,
  entry: RoomEntry,
  target: TriggerTarget
): void {
  self.deps.store.rewindReadCursor(room.id, target.authorId, {
    from: entry.seq,
    to: target.lastReadSeq,
  });
}
