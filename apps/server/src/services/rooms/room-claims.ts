/**
 * What a room claim is: the record that one agent is mid-turn in one room.
 *
 * Lifted out of `room-trigger.ts` because two readers now need this vocabulary
 * and only one of them owns the dispatcher: the dispatcher, which takes and
 * releases claims, and the diagnostic read surface, which reports who is holding
 * one and since when. Keeping the shape beside the class that mutates it made
 * the second reader import the first's whole module for a type.
 *
 * Nothing here has behaviour. The claim MAP still lives in
 * {@link import('./room-trigger').RoomTriggerDispatcher}, which is the only
 * thing allowed to write it — presence is the claim map made visible, and a
 * second writer would be a second source of the working indicator.
 *
 * @module server/services/rooms/room-claims
 */
import type { DispatchOutcome } from '../observability/dispatch-buffers.js';
import type { BusyContext } from './room-notices.js';
import type { CascadeStamp, RoomTurnUnanswered } from './room-notice-log.js';
import type { EngagementWindow } from './engagement.js';

/**
 * One turn in flight: which cascade it belongs to, how deep it sits, what it is
 * answering, and whether the room has stopped waiting for it.
 *
 * A claim is taken before its turn runs and released when that turn reaches a
 * terminal — an answer, a notice, or the agent choosing to say nothing. It is
 * the only live record that an agent is working, so three readers depend on it
 * today, and holding it for the whole turn changed what each of them sees:
 *
 * 1. {@link RoomTriggerDispatcher.busyIn} — whether this agent is already
 *    working here. A late turn is still running, so a fresh trigger for it is
 *    refused rather than started beside it on the same session.
 * 2. {@link RoomTriggerDispatcher.workingIn} — `room_context.working`. A late
 *    turn is still reported there, because it is still work.
 * 3. {@link RoomTriggerDispatcher.activeTurnFor} — the provenance an agent's own
 *    direct post inherits. **This is the one whose behaviour moved furthest.** A
 *    post an agent makes during its own late window used to be read as a post
 *    with no turn behind it and stamped at the ceiling, which silently refused
 *    everything downstream of it; it now carries the real cascade, so a message
 *    it addresses is triggered and a turn runs that previously did not.
 *
 * 4. {@link RoomTriggerDispatcher.publishPresence} — the working indicator a
 *    person watching the room sees. It is why `entryId` is recorded here rather
 *    than derived later: by the time a turn ends, the entry it answered is no
 *    longer in hand, and `cascadeRoot` is not a substitute for it (room-presence
 *    spec §3.1).
 *
 * The session the turn runs on is deliberately NOT here. A claim used to carry
 * it, and nothing ever read it: the presence signal does not carry a session id
 * (room-presence spec §15), and every writer that needs one — the reply post,
 * the runtime binding — takes it from the turn's own result, which is the only
 * place it is known to be correct. A second copy taken at claim time could only
 * ever be the id the room GUESSED with, which is exactly the stale id that used
 * to cost an agent its memory of a room.
 */
export interface ActiveClaim {
  roomId: string;
  cascadeRoot: string;
  authorId: string;
  /**
   * The agent's directory — its identity and its working tree.
   *
   * Recorded because it is the grain of the SECOND ceiling
   * ({@link RoomTriggerDispatcher.busyWith}): the `(room, agent)` key bounds one
   * transcript, and this bounds one checkout, which is shared by every room the
   * agent is in. It is also what tells {@link RoomTriggerDispatcher.halt} which
   * runtime owns the turn it is stopping.
   */
  agentPath: string;
  /**
   * The entry whose trigger this claim answers. NOT interchangeable with
   * `cascadeRoot`: the two coincide only at depth 0, and every deeper hop
   * answers a reply rather than the message that began the exchange.
   */
  entryId: string;
  /**
   * The correlation id joining every line this turn writes, from the claim to
   * the reply that releases it. Recorded on the claim because the claim outlives
   * the frame that minted it: a late answer releases from
   * {@link RoomTriggerDispatcher.deliverLate}, and a halt releases from a path
   * with no dispatch scope at all.
   */
  dispatchId: string;
  depth: number;
  /**
   * This turn answers nothing the room said, so nothing it writes belongs to a
   * cascade — the welcome-back offer, and today nothing else
   * ({@link RoomTriggerDispatcher.askAside}).
   *
   * **It is read by exactly one thing: {@link deepestClaimOf}.** Provenance
   * follows the TURN, and an aside turn has none to pass on: it was not
   * triggered, its `cascadeRoot` is borrowed from the entry it is ABOUT purely
   * so presence has something to key on, and `depth` sits at the ceiling. A
   * direct post the agent makes mid-aside-turn therefore inherits nothing and is
   * stamped by `deriveCascade` under its OWN root at the ceiling — the same
   * stamp a status line gets, which triggers nobody and, because
   * `cascadeRoot === id`, writes no refusal notice either. Inheriting instead
   * gave it a FOREIGN root at the same ceiling depth, which triggers nobody and
   * sprays a `cascade_depth` notice at every selected room-mate (see the long
   * comment on that refusal in `room-trigger.ts`).
   *
   * Both ceilings still see this claim, and so does presence: an aside turn is
   * real work in a real checkout. Only the cascade it does not have is hidden.
   */
  aside: boolean;
  /**
   * The agent has already posted into this room, deliberately, from inside this
   * turn — `post_to_room` (room-participation spec §10.2).
   *
   * It exists so the room does not say the same thing twice. A turn that reaches
   * for the posting verb has already put its words in front of the reader; the
   * narration it then writes back to its own session ("I posted the deploy note")
   * is addressed to whoever is watching the SESSION, and posting that as well
   * would give the room two messages for one thought. So {@link
   * RoomTriggerDispatcher.deliver} skips the automatic post when this is set.
   *
   * **Per `(room, agent)`, which is the grain of the claim itself.** An agent that
   * posts into a DIFFERENT room mid-turn has said nothing here, and its answer to
   * this room still lands.
   */
  spokeViaTool: boolean;
  /** When the claim was taken — what `room_context.working` reports as `since`. */
  claimedAt: string;
  /**
   * The room stopped waiting; the turn did not stop. Set once the runner reports
   * the wait deadline passed, and the reason this claim outlives
   * {@link RoomTriggerDispatcher.runOne} — see the `finally` there.
   */
  pastDeadline: boolean;
}

/**
 * How a claim ended, for the log and nowhere else.
 *
 * Never rendered and never persisted: a person reads the room's own entries for
 * this, and the four values here would be jargon in front of them. What it is
 * for is the other half of an incident — reconstructing, from the log, which
 * turns ran and how each one finished, when the durable answer is exactly what
 * is missing.
 */
export type ClaimOutcome = 'answered' | 'quiet' | 'halted' | RoomTurnUnanswered;

/** One agent that survived the guard, with the depth its reply will carry. */
export interface TriggerTarget {
  authorId: string;
  agentPath: string;
  displayName: string;
  depth: number;
  /**
   * Its open engaged window, or `null` when it is not in one. Carried from the
   * per-entry evaluation rather than recomputed for the turn: the same clock,
   * the same answer.
   */
  engaged: EngagementWindow | null;
  /** This target's own dispatch id — one per `(entry, target)` pair, never per entry. */
  dispatchId: string;
  /** The `(room, agent)` session, bound at claim time so a race resolves to one. */
  sessionId: string;
  /**
   * This agent's read cursor as it stood the instant BEFORE the claim advanced
   * it — the bottom of the ambient window its turn will be shown
   * (room-participation spec §8.3).
   *
   * Carried on the target rather than read again inside the turn, because by
   * then it is gone: taking the claim moves the stored cursor to the entry being
   * answered, so that a turn which errors does not replay to the next turn what
   * it has already seen. This is the value that was there, captured at the one
   * moment it is still true.
   */
  lastReadSeq: number;
}

/**
 * Separator for a claim key. Named, rather than a literal in a template, because
 * it used to be an invisible NUL that a doc comment described as a space — and
 * the next reader wrote a lookup against the space.
 */
const CLAIM_KEY_SEPARATOR = '\u0000';

/**
 * The `(room, agent)` identity, for map keys only. Nothing parses it back apart.
 *
 * The grain of a live claim: a room binds one session per agent, so one turn is
 * all there can honestly be. The absence of a cascade is the design — every
 * message a person sends starts its own, so a cascade in this key would never
 * collide with anything.
 *
 * @param roomId - The room.
 * @param authorId - The agent working in it.
 * @returns The map key for that pair.
 */
export function agentKey(roomId: string, authorId: string): string {
  return [roomId, authorId].join(CLAIM_KEY_SEPARATOR);
}

/**
 * One live claim as the diagnostic surface reports it.
 *
 * A deliberate projection of {@link ActiveClaim}, not the record itself: the
 * claim carries `agentPath` and `depth`, and `agentPath` is a filesystem path.
 * A read surface that is safe to leave mounted carries what a span may carry —
 * ids, counts, durations, coarse enums — so the path does not cross the
 * boundary, and cannot start to just because someone adds a field to the claim.
 */
export interface ActiveClaimView {
  roomId: string;
  authorId: string;
  entryId: string;
  cascadeRoot: string;
  dispatchId: string;
  /** ISO 8601. */
  claimedAt: string;
  /** How long the claim has been held, at the moment of the read. */
  heldMs: number;
  /** The room stopped waiting, but the turn is still running. */
  pastDeadline: boolean;
}

// --- Reading the claim map --------------------------------------------------
//
// The map itself stays private to `RoomTriggerDispatcher`, which is the only
// thing allowed to WRITE it: presence is the claim map made visible, and a
// second writer would be a second source of the working indicator. These are
// the questions anybody asks of it, as pure functions over a read-only view —
// so the dispatcher keeps the writes and this module keeps the vocabulary.

/**
 * How a room's own claim outcome reads in the cross-origin dispatch buffer.
 *
 * A total `Record`, so adding a {@link ClaimOutcome} without deciding how it
 * groups is a type error here rather than a silent `undefined` in a debug
 * response. `busy` becomes `refused` because no turn ran; `quiet` stays its own
 * thing, because an agent choosing to say nothing is not a refusal and the two
 * looking alike is what made a busy agent indistinguishable from a broken one.
 */
export const DISPATCH_OUTCOMES: Record<ClaimOutcome, DispatchOutcome> = {
  answered: 'answered',
  quiet: 'quiet',
  halted: 'halted',
  busy: 'refused',
  failed: 'failed',
  // Refused before anything was claimed, so this row is unreachable today —
  // `ClaimOutcome` unions in every `RoomTurnUnanswered`, and a member whose
  // agent is gone never becomes a target. It is a `refused` because that is
  // what it would be: no turn ran, and none was going to.
  gone: 'refused',
  // Same shape as `gone`: refused before a claim was ever taken, because the
  // bind that would have preceded the claim failed first (DOR-1206).
  unavailable: 'refused',
};

/**
 * The cascade an author is currently answering inside, deepest first.
 *
 * The deepest in-flight turn wins when an agent is answering in more than one
 * room at once: the room a post lands in cannot say which turn produced it, so
 * the conservative choice is the one closest to the ceiling.
 *
 * **{@link ActiveClaim.aside} turns are skipped**, because they have no cascade
 * to pass on: nothing in the room triggered them. Skipping leaves a mid-turn
 * post un-provenanced, which `deriveCascade` stamps under its own root at the
 * ceiling — silent, and the same stamp the agent's own welcome-back line gets.
 * See that field for what inheriting instead did.
 *
 * @param claims - The live claim map.
 * @param authorId - The author writing a post.
 * @returns The cascade to inherit, or `undefined` when it has no turn running.
 */
export function deepestClaimOf(
  claims: ReadonlyMap<string, ActiveClaim>,
  authorId: string
): CascadeStamp | undefined {
  let active: CascadeStamp | undefined;
  for (const claim of claims.values()) {
    if (claim.authorId !== authorId || claim.aside) continue;
    if (!active || claim.depth > active.depth) {
      active = { root: claim.cascadeRoot, depth: claim.depth };
    }
  }
  return active;
}

/**
 * Who is working in one room, and since when — what `room_context.working` and
 * the presence fan-out are given.
 *
 * @param claims - The live claim map.
 * @param roomId - The room being asked about.
 * @returns One entry per agent holding a claim there.
 */
export function claimsWorkingIn(
  claims: ReadonlyMap<string, ActiveClaim>,
  roomId: string
): Array<{ authorId: string; since: string }> {
  const working: Array<{ authorId: string; since: string }> = [];
  for (const claim of claims.values()) {
    if (claim.roomId === roomId) working.push({ authorId: claim.authorId, since: claim.claimedAt });
  }
  return working;
}

/**
 * What the room can truthfully say an agent is doing, or `null` when it is free.
 *
 * Two ceilings, asked in this order because they have two different remedies.
 * The `(room, agent)` key bounds one TRANSCRIPT: a claim under it means the
 * answer being worked on will land in front of this reader, so waiting is the
 * whole remedy. The agent PATH bounds one CHECKOUT, which is shared by every
 * room the agent is in — the contention DOR-500 measured — and nothing about
 * the first question could see it.
 *
 * @param claims - The live claim map.
 * @param roomId - The room being triggered.
 * @param authorId - The agent a trigger would run.
 * @param agentPath - That agent's directory, which is what the second ceiling
 *   is really about.
 * @returns The busy context, or `null` when the agent is doing nothing.
 */
export function claimBusyWith(
  claims: ReadonlyMap<string, ActiveClaim>,
  roomId: string,
  authorId: string,
  agentPath: string
): BusyContext | null {
  if (claims.has(agentKey(roomId, authorId))) return 'working-here';
  for (const claim of claims.values()) {
    if (claim.agentPath === agentPath) return 'working-elsewhere';
  }
  return null;
}

/**
 * Every live claim, projected onto the shape the diagnostic surface may carry.
 *
 * @param claims - The live claim map.
 * @param now - Epoch ms to measure `heldMs` against.
 * @returns One row per live claim.
 */
export function describeClaims(
  claims: ReadonlyMap<string, ActiveClaim>,
  now = Date.now()
): ActiveClaimView[] {
  return [...claims.values()].map((claim) => ({
    roomId: claim.roomId,
    authorId: claim.authorId,
    entryId: claim.entryId,
    cascadeRoot: claim.cascadeRoot,
    dispatchId: claim.dispatchId,
    claimedAt: claim.claimedAt,
    heldMs: Math.max(0, now - Date.parse(claim.claimedAt)),
    pastDeadline: claim.pastDeadline,
  }));
}
