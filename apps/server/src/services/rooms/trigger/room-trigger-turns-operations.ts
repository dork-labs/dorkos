import type { Room, RoomEntry } from '@dorkos/shared/room-schemas';
import { logger } from '../../../lib/logger.js';
import { recordDispatchStart } from '../../observability/dispatch-buffers.js';
import { agentKey, type ClaimOutcome, type TriggerTarget } from '../room-claims.js';
import { buildRoomContext } from '../room-context.js';
import { RoomTurnRuntimeGoneError, type RoomTurnRequest } from '../room-turn-port.js';
import { readOriginalRoomTriggerFacetView } from '../room-trigger.js';

/** The body of {@link RoomTriggerDispatcher.runOne}, already inside its scope. */
export async function runOneInDispatch(
  triggerOwner: object,
  room: Room,
  entry: RoomEntry,
  target: TriggerTarget
): Promise<void> {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  const { isEntryAuthorExternal, ceilingForEntries } = facet;
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
    const place = await facet.placeTurn(
      room,
      entry,
      target.authorId,
      target.agentPath,
      target.displayName,
      target.sessionId,
      target.dispatchId
    );
    const { cwd } = place;
    const files = place.files ?? undefined;
    // Built before the request so the context and the projection plan it
    // implies are one value, resolved once.
    const turnContext = buildRoomContext(facet.deps, {
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
      working: facet.workingIn(room.id),
      // The cursor as it stood before the claim moved it. The stored row has
      // already advanced past this entry, so reading it here would describe
      // an empty window every time (room-participation spec §8.3).
      lastReadSeq: target.lastReadSeq,
      // Both halves of what is left to spend, resolved together so they can
      // never disagree about whether anything is counting.
      ...facet.headroomFor(room.id, target.depth),
      engaged: target.engaged,
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
    const request: RoomTurnRequest = {
      room,
      authorId: target.authorId,
      agentPath: target.agentPath,
      // The agent's home, the same value the context was built against —
      // never resolved a second time — and the room's folders it may reach.
      cwd,
      additionalDirectories: place.additionalDirectories,
      worktree: place.worktree,
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
        isEntryAuthorExternal(facet.deps.authors, answered.authorId)
      ),
      // And the turn itself is held to the strictest of its senders' levels,
      // new conversation or not — see `RoomTurnRequest.permissionCeiling`.
      ...ceilingForEntries(facet.deps.authors, target.answers ?? [entry]),
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
        facet.notices.reportWaiting(
          room,
          entry,
          { authorId: target.authorId, displayName: target.displayName },
          waiting
        ),
      // What the turn is doing, for the room's live lane (DOR-1351). Keyed on
      // the claim rather than the frame, so a reading that arrives after this
      // scope is gone reaches nothing rather than a stale object.
      onActivity: (activity) => facet.noteActivity(agentKey(room.id, target.authorId), activity),
      // Onto the live claim, where a mid-turn `post_to_room` reads it: the
      // session id stamps the entry with the turn that wrote it (spec
      // `tool-only-room-replies` §D8).
      onSessionBound: (id) => facet.noteSessionBound(room.id, target.authorId, id),
    };
    Object.assign(request, facet.launchStepFor(request, place));
    facet.associateOriginalRequest(request, target.dispatchId);
    const result = await facet.originalDispatch.runner.run(request);

    // A REFUSAL IS NOT A READING. The claim moved this agent's cursor to the
    // triggering entry on the assumption that the turn would be SHOWN what sits
    // behind it — but `busy` is the runner declining before any model ran, so
    // nothing was shown and nothing was read. Left forward, the whole backlog
    // is permanently invisible, and the notice this outcome writes ("send it
    // again when Ana is free") invites a message that would land ABOVE the
    // advanced cursor and arrive with no context at all.
    if (result.unanswered === 'busy') facet.rewindClaimCursor(room, entry, target);

    // The turn ran on a session; that session is the one this agent must
    // resume here next time. It is not always the one the room asked with —
    // Claude Code assigns its own id on the first turn and files the
    // transcript under it — so the binding follows the runner's answer rather
    // than the id minted before the turn. Written before anything is
    // delivered: a post that throws must not cost the room its memory.
    if (result.sessionId !== target.sessionId) {
      facet.deps.store.rebindRoomSession(room.id, target.authorId, result.sessionId);
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
    if (facet.wasHalted(target.dispatchId)) {
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
      facet.deliverLate({ room, entry, target, late: result.late });
      // Marked only AFTER the release above is armed, and the order is the
      // whole safety of it: the `finally` below reads this flag to decide
      // whether the turn is still running, so a claim marked before
      // `deliverLate` had attached its handlers would be held by a promise
      // chain that never existed and released by nothing.
      const claim = facet.claimed.get(key);
      if (claim) {
        claim.pastDeadline = true;
        // The deadline's only announcement. It is deliberately not a notice:
        // a durable line about every slow turn is a second message about every
        // slow turn, and the late answer already says how long it took
        // (room-presence spec §18). Published once here; every republish from
        // now on carries `working_late` because it reads the same flag.
        facet.publishPresence(claim, 'working_late');
      }
    } else {
      outcome = facet.deliver({ room, entry, target, reply: result });
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
    facet.rewindClaimCursor(room, entry, target);
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
    const runtimeGone = err instanceof RoomTurnRuntimeGoneError ? err.runtime : null;
    // A turn that threw because somebody stopped it did what it was told. The
    // `halted` notice is already on the log and is the whole story; an
    // apology under it would be the room reporting the person's own control
    // action back to them as a fault.
    if (facet.wasHalted(target.dispatchId)) outcome = 'halted';
    else if (runtimeGone !== null) {
      // Named on the claim as well as in the room: `DISPATCH_OUTCOMES` files
      // this as `refused` rather than `failed`, so an operator counting
      // crashes in the debug buffer does not find a missing runtime among
      // them.
      outcome = 'runtime-gone';
      facet.notices.reportSilence(room, entry, target, 'runtime-gone', target.dispatchId, {
        runtime: runtimeGone,
      });
    } else facet.notices.reportSilence(room, entry, target, 'failed', target.dispatchId);
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
    if (facet.claimed.get(key)?.pastDeadline !== true) {
      facet.releaseOwnClaim(key, target.dispatchId, outcome);
    }
    // **Unconditional, and safe even for a turn `deliverLate` still owes an
    // answer.** A dispatch can only be MARKED while its claim is held, and a
    // late turn's claim outlives this frame — so at this line a turn that
    // went late is provably unmarked and this deletes nothing, while the halt
    // that marks it later is followed by `deliverLate`'s own cleanup. A turn
    // marked before it went late never reaches here at all: the halted branch
    // above declines to arm the late delivery.
    facet.forgetHalt(target.dispatchId);
  }
}

/** The body of {@link RoomTriggerDispatcher.askAside}, already inside its scope. */
export async function runAsideInDispatch(
  triggerOwner: object,
  input: {
    room: Room;
    entry: RoomEntry;
    authorId: string;
    agentPath: string;
    sessionId: string;
    key: string;
    dispatchId: string;
    prompt: string;
  }
): Promise<void> {
  const facet = readOriginalRoomTriggerFacetView(triggerOwner);
  const { room, entry, authorId, key } = input;
  const displayName =
    facet.deps.authors.getMany([authorId]).get(authorId)?.displayName ?? 'An agent';
  let outcome: ClaimOutcome = 'quiet';
  recordDispatchStart({
    dispatchId: input.dispatchId,
    origin: 'room',
    roomId: room.id,
    sessionId: input.sessionId,
  });
  try {
    // An aside turn is a real turn, so it is placed the same way an ordinary
    // one is — see `runOneInDispatch`.
    const place = await facet.placeTurn(
      room,
      entry,
      authorId,
      input.agentPath,
      displayName,
      input.sessionId,
      input.dispatchId
    );
    const { cwd } = place;
    const files = place.files ?? undefined;
    const turnContext = buildRoomContext(facet.deps, {
      room,
      agentAuthorId: authorId,
      cwd,
      // An aside is granted the same copy an ordinary turn is, so it is told
      // the same thing about the room's files.
      files,
      entry,
      working: facet.workingIn(room.id),
      // NO AMBIENT WINDOW, and no cursor moved. A trigger replays what the
      // agent missed because it is answering the room; this is a narrow
      // question about the agent's own work, and replaying the conversation
      // into it would both invite an answer to somebody else's message and
      // silently consume the window the next real trigger owes it
      // (room-participation spec §8.3).
      lastReadSeq: entry.seq,
      // The hourly headroom, and NO chain: an offer is one line and the end of
      // it, which is what `'ceiling'` says here and what the ceiling stamp
      // above says to the guard. Asked through the same helper so that an
      // install with limits off answers `null` here too, rather than telling
      // an agent it has zero of something nothing is counting.
      ...facet.headroomFor(room.id, 'ceiling'),
      engaged: null,
      // The same word the claim above uses. Nothing asked for this turn, so
      // the block names no "message you are answering": `entry` here is the
      // greeter's own status post, and pointing the agent at it would point it
      // at a line written about itself (DOR-1263).
      aside: true,
    });
    const request: RoomTurnRequest = {
      room,
      authorId,
      agentPath: input.agentPath,
      cwd,
      additionalDirectories: place.additionalDirectories,
      worktree: place.worktree,
      sessionId: input.sessionId,
      entry,
      // Never external: `entry` here is the greeter's own status post, written
      // by this machine, and nobody off it can ask for an aside turn.
      externalAuthor: false,
      prompt: input.prompt,
      roomContext: turnContext.context,
      attachmentProjection: turnContext.projection,
      onWaiting: (waiting) =>
        facet.notices.reportWaiting(room, entry, { authorId, displayName }, waiting),
      // An aside turn holds a real claim, so it reports what it is doing like
      // any other turn.
      onActivity: (activity) => facet.noteActivity(key, activity),
      onSessionBound: (id) => facet.noteSessionBound(room.id, authorId, id),
    };
    Object.assign(request, facet.launchStepFor(request, place));
    facet.associateOriginalRequest(request, input.dispatchId);
    const result = await facet.originalDispatch.runner.run(request);
    if (result.sessionId !== input.sessionId) {
      facet.deps.store.rebindRoomSession(room.id, authorId, result.sessionId);
    }
    // **An offer somebody stopped is not made**, and this is asked BEFORE the
    // late wait for the same reason `runOne` asks before arming `deliverLate`:
    // an offer nobody will hear must not hold a claim, and an agent reading as
    // working, for the up-to-an-hour the ceiling allows. The aside path is
    // silent about every other refusal already, and this one has a durable
    // line of its own — the room's `halted` notice, written when Stop was
    // pressed.
    if (facet.wasHalted(input.dispatchId)) {
      outcome = 'halted';
      // Resolve-or-reject is the runner's contract; the room has simply
      // stopped listening. Same treatment as `runOne`'s halted branch.
      result.late?.catch(() => undefined);
      return;
    }
    // **A slow turn is late, never lost** (`.claude/rules/room-conduct.md`).
    // The room's wait bounds the WAIT; the turn keeps running, and
    // `rooms.lateReplyCeilingMinutes` is what bounds how late "late" can be —
    // so the answer is waited out here and posted when it lands, rather than
    // dropped on the floor while the busy notice elsewhere promises the
    // opposite. The claim is held throughout, because the agent really is
    // still working in its own checkout, and released by the `finally` below
    // once this has an answer to hand back.
    const settled = result.late === undefined ? result : await facet.awaitLate(result.late, key);
    // Asked AGAIN, over the other window. The check above cannot see a Stop
    // pressed DURING the wait, which is the longest window this method has —
    // and the triggered path answers that same window from inside `deliver`,
    // which an aside does not use because its answer goes back to the greeter
    // rather than into the room.
    if (facet.wasHalted(input.dispatchId)) {
      outcome = 'halted';
      return;
    }
    if (settled.unanswered) {
      outcome = settled.unanswered;
      return;
    }
    // **The same three terminals `deliver` reads, minus the notice.** An offer
    // that posted or reacted has put something in front of the person and
    // releases as `'answered'`; one that did neither is `'quiet'` and says so
    // to nobody, because nobody asked for this turn. Both marks are TAKEN, for
    // the reason `deliver` takes them: the claim is still held here — the
    // `finally` below is what releases it — and a mark left standing would
    // discharge the next turn's obligation.
    const spoke = facet.takeSpokeViaTool(room.id, authorId);
    const reacted = facet.takeReactedViaTool(room.id, authorId);
    outcome = spoke || reacted ? 'answered' : 'quiet';
  } catch (err) {
    outcome = 'failed';
    logger.warn('[rooms] a welcome-back offer turn failed', {
      roomId: room.id,
      authorId,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    // Always, and last. An aside turn releases into the offer the agent
    // posted while it ran, or into the named exception every turn has — an
    // agent that ran and chose to say nothing. Since the offer is now posted
    // from inside the turn, the release genuinely comes after the durable
    // write rather than a tick before it, which is what closes the one hole
    // this path used to carry.
    //
    // Guarded by dispatch like both triggered releases: an aside waits out its
    // own late answer, so a Stop and a fresh message can hand this key to a
    // real turn while it is still waiting.
    facet.releaseOwnClaim(key, input.dispatchId, outcome);
    // An aside waits out its own late answer inline, so this frame is always
    // the turn's last one and the halt mark always ends here.
    facet.forgetHalt(input.dispatchId);
  }
}
