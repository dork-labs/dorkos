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
import type { EngagementWindow } from './engagement.js';
import type { RoomTurnUnanswered } from './room-notice-log.js';

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
