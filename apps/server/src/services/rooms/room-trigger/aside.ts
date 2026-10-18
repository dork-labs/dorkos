/**
 * A private aside: one agent answers one person without posting to the room.
 *
 * Split out of `room-trigger.ts` without changing a line of logic. Each function
 * here is the body of a {@link RoomTriggerDispatcher} method of the same name,
 * which delegates to it with itself as `self`.
 *
 * @module server/services/rooms/room-trigger/aside
 */
import { randomUUID } from 'node:crypto';
import type { Room, RoomEntry } from '@dorkos/shared/room-schemas';
import { newDispatchId } from '@dorkos/shared/dispatch-id';
import { logger } from '../../../lib/logger.js';
import { runInDispatch } from '../../../lib/dispatch-context.js';
import { recordDispatchStart } from '../../observability/dispatch-buffers.js';
import { agentKey, type ClaimOutcome } from '../room-claims.js';
import { isLiveAuthor } from '../handles/author-handles.js';
import { buildRoomContext } from '../room-context.js';
import { roomLaunchStepFor } from '../repo/room-launch-step.js';
import type { RoomTriggerDispatcher } from '../room-trigger.js';
import { READ_ONLY_LEVEL } from '@dorkos/shared/permission-semantics';
import type { TeammateAsker, TeammatePass } from '@dorkos/shared/agent-runtime';

/**
 * A teammate's one allowed call, run as an aside (DOR-2956): the turn is a teammate's, held to
 * every bound one is, and carries the pass that lets that one call through.
 */
export interface AsideTeammatePass {
  /** The teammate the request was made for. */
  asker: TeammateAsker;
  /** The call the owner allowed. */
  pass: TeammatePass;
}

/** How an aside request ended before its turn: it ran, the agent was busy, or it could not run. */
export type AsideOutcome = 'ran' | 'busy' | 'skipped';

/**
 * The body of {@link RoomTriggerDispatcher.askAside}, which documents it.
 *
 * @param self - The dispatcher whose state this reads and writes.
 */
export async function askAside(
  self: RoomTriggerDispatcher,
  input: {
    room: Room;
    entry: RoomEntry;
    authorId: string;
    prompt: string;
    teammate?: AsideTeammatePass;
  }
): Promise<AsideOutcome> {
  const { room, entry, authorId } = input;
  const record = self.deps.authors.getMany([authorId]).get(authorId);
  // Only an agent takes a turn, and only a live one: a directory that no
  // longer holds this agent has nothing to offer and no session to offer it
  // on (ADR 260801-003051).
  if (!record || record.kind !== 'agent') return 'skipped';
  if (!isLiveAuthor(record, self.deps.agents)) return 'skipped';
  // It posted its status line a moment ago, so this is all but guaranteed —
  // and it costs one indexed read to not spend a model turn on the case where
  // it left the room in between.
  if (!self.deps.store.getMember(room.id, authorId)) return 'skipped';
  const agentPath = record.naturalKey;

  const busyWith = self.busyWith(room.id, authorId, agentPath);
  if (busyWith !== null) {
    logger.debug('[rooms] skipped a welcome-back offer: the agent is already working', {
      roomId: room.id,
      authorId,
      // The ceiling only — never the blocking claim, which carries an
      // `agentPath`, and a filesystem path does not belong in a log context.
      busyWith: busyWith.where,
    });
    return 'busy';
  }
  // Charged through the same seam `claimCollected` uses, which is what keeps
  // an offer from being the one path that spends without counting: with every
  // cap off the budget allows it and charges nothing, and there is then no
  // window to re-arm.
  const afford = self.deps.budget.tryReserve(room.id);
  if (!afford.allowed) {
    logger.debug('[rooms] skipped a welcome-back offer: the room is out of automatic turns', {
      roomId: room.id,
      authorId,
    });
    return 'skipped';
  }
  // **The re-arm, exactly as `claimCollected` does it, and it is not optional
  // here.** Spending again means the hourly window moved, so the next
  // exhaustion is news rather than a repeat. Without this line an offer
  // silently consumes the freshly-rolled window and leaves the memory of the
  // LAST refusal standing — so the next person to be refused is refused with
  // no notice at all. An invisible refusal of a message somebody addressed is
  // the shape `.claude/rules/room-conduct.md` forbids, and an offer nobody
  // asked for must not be the thing that causes it.
  if (afford.counted) self.notices.budgetRecovered(room.id);

  let sessionId: string;
  try {
    // The room's own session for this agent, exactly as a trigger binds it —
    // an offer is part of the same conversation, not a thread of its own.
    sessionId = self.deps.store.bindRoomSession(
      room.id,
      authorId,
      self.deps.store.getRoomSession(room.id, authorId) ?? randomUUID(),
      new Date().toISOString()
    );
  } catch (err) {
    logger.warn('[rooms] could not bind a session for a welcome-back offer', {
      roomId: room.id,
      authorId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'skipped';
  }

  const dispatchId = newDispatchId();
  const key = agentKey(room.id, authorId);
  self.holdClaim({
    roomId: room.id,
    cascadeRoot: entry.cascadeRoot,
    authorId,
    agentPath,
    entryId: entry.id,
    dispatchId,
    // AT the ceiling. Kept as defence in depth rather than as the thing
    // standing between an aside and a cascade — `aside: true` below is that,
    // and it is why nothing this turn writes can inherit a root either. Both
    // fields are read: this one by the diagnostic claim view, that one by
    // `deepestClaimOf`.
    depth: self.deps.limitsFor(room.id).maxAgentDepth,
    // Nothing in the room asked for this turn, so it has no cascade to hand
    // to a post the agent makes while it runs. See {@link ActiveClaim.aside}.
    aside: true,
    spokeViaTool: false,
    reactedViaTool: false,
    claimedAt: new Date().toISOString(),
    pastDeadline: false,
    // Zero rather than `Date.now()`: the turn's FIRST tool call should reach
    // the room immediately, and a floor set at claim time would hold it back
    // for up to one throttle window.
    activityPublishedAt: 0,
  });
  await runInDispatch({ dispatchId, origin: 'room', entryId: entry.id }, () =>
    self.runAsideInDispatch({
      room,
      entry,
      authorId,
      agentPath,
      sessionId,
      key,
      dispatchId,
      prompt: input.prompt,
      ...(input.teammate ? { teammate: input.teammate } : {}),
    })
  );
  return 'ran';
}

/** The body of {@link RoomTriggerDispatcher.askAside}, already inside its scope. */
export async function runAsideInDispatch(
  self: RoomTriggerDispatcher,
  input: {
    room: Room;
    entry: RoomEntry;
    authorId: string;
    agentPath: string;
    sessionId: string;
    key: string;
    dispatchId: string;
    prompt: string;
    teammate?: AsideTeammatePass;
  }
): Promise<void> {
  const { room, entry, authorId, key } = input;
  const displayName =
    self.deps.authors.getMany([authorId]).get(authorId)?.displayName ?? 'An agent';
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
    const place = await self.placeTurn(room.id, input.agentPath, displayName);
    const { cwd } = place;
    const files = place.files ?? undefined;
    const turnContext = buildRoomContext(self.deps, {
      room,
      agentAuthorId: authorId,
      cwd,
      // An aside is granted the same copy an ordinary turn is, so it is told
      // the same thing about the room's files.
      files,
      entry,
      working: self.workingIn(room.id),
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
      ...self.headroomFor(room.id, 'ceiling'),
      engaged: null,
      // The same word the claim above uses. Nothing asked for this turn, so
      // the block names no "message you are answering": `entry` here is the
      // greeter's own status post, and pointing the agent at it would point it
      // at a line written about itself (DOR-1263).
      aside: true,
    });
    const result = await self.deps.runner.run({
      room,
      authorId,
      agentPath: input.agentPath,
      cwd,
      additionalDirectories: place.additionalDirectories,
      worktree: place.worktree,
      ...roomLaunchStepFor(self.deps, room.id, authorId, input.agentPath, place),
      sessionId: input.sessionId,
      entry,
      // Never external for a welcome-back offer: `entry` is the greeter's own status post,
      // written by this machine. A teammate's allowed call is the teammate's turn (DOR-2956):
      // external, read-only, nobody to ask, fenced to this room, with the one pass.
      ...(input.teammate
        ? {
            externalAuthor: true,
            permissionCeiling: ['runtime-default', READ_ONLY_LEVEL] as const,
            teammate: true as const,
            teammateAsker: input.teammate.asker,
            teammatePass: input.teammate.pass,
          }
        : { externalAuthor: false }),
      prompt: input.prompt,
      roomContext: turnContext.context,
      attachmentProjection: turnContext.projection,
      onWaiting: (waiting) =>
        self.notices.reportWaiting(room, entry, { authorId, displayName }, waiting),
      // An aside turn holds a real claim, so it reports what it is doing like
      // any other turn.
      onActivity: (activity) => self.noteActivity(key, activity),
      onSessionBound: (id) => self.noteSessionBound(room.id, authorId, id),
    });
    if (result.sessionId !== input.sessionId) {
      self.deps.store.rebindRoomSession(room.id, authorId, result.sessionId);
    }
    // **An offer somebody stopped is not made**, and this is asked BEFORE the
    // late wait for the same reason `runOne` asks before arming `deliverLate`:
    // an offer nobody will hear must not hold a claim, and an agent reading as
    // working, for the up-to-an-hour the ceiling allows. The aside path is
    // silent about every other refusal already, and this one has a durable
    // line of its own — the room's `halted` notice, written when Stop was
    // pressed.
    if (self.wasHalted(input.dispatchId)) {
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
    const settled = result.late === undefined ? result : await self.awaitLate(result.late, key);
    // Asked AGAIN, over the other window. The check above cannot see a Stop
    // pressed DURING the wait, which is the longest window this method has —
    // and the triggered path answers that same window from inside `deliver`,
    // which an aside does not use because its answer goes back to the greeter
    // rather than into the room.
    if (self.wasHalted(input.dispatchId)) {
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
    const spoke = self.takeSpokeViaTool(room.id, authorId);
    const reacted = self.takeReactedViaTool(room.id, authorId);
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
    self.releaseOwnClaim(key, input.dispatchId, outcome);
    // An aside waits out its own late answer inline, so this frame is always
    // the turn's last one and the halt mark always ends here.
    self.forgetHalt(input.dispatchId);
  }
}
