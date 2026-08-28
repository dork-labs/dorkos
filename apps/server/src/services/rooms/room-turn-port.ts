/**
 * The contract between a room and whatever actually runs a turn.
 *
 * One port, two sides: `RoomTriggerDispatcher` asks, and `room-turn-runner.ts`
 * answers — and a test substitutes a script for the second without the first
 * noticing. Split out of `room-trigger.ts` because a port that lives inside its
 * caller reads as that caller's private business, and this one is neither: the
 * runner implements it, the room service passes it through, and every rooms
 * test in the suite stands one up.
 *
 * The vocabulary of an OUTCOME is deliberately here rather than in the
 * dispatcher: `late`, `unanswered` and "chose to stay quiet" are the things a
 * turn can do, and what the room SAYS about each is a separate decision that
 * belongs to `notices/notice-log.ts`.
 *
 * @module server/services/rooms/room-turn-port
 */
import type { RoomContextData } from '@dorkos/shared/additional-context';
import type { Room, RoomEntry } from '@dorkos/shared/room-schemas';
import type { SessionActivity } from '@dorkos/shared/session-stream';
import type { ProjectableAttachment } from './room-context.js';
import type { RoomTurnUnanswered } from './notices/notice-log.js';
import type { WaitingKind } from './notices/notice-copy.js';

/** One agent turn, as the room asks for it. */
export interface RoomTurnRequest {
  /** The room the answer will be posted into. */
  room: Room;
  /** The agent author being triggered. */
  authorId: string;
  /** The agent's directory — its identity and its working directory. */
  agentPath: string;
  /** The session bound to this `(room, agent)`, or `null` on its first answer. */
  sessionId: string | null;
  /** The entry that triggered this turn. */
  entry: RoomEntry;
  /**
   * The words the turn is triggered with — what reaches the model as the visible
   * user message, byte for byte.
   *
   * For an ordinary trigger this is `entry.body.text`, and stating it explicitly
   * rather than letting the runner reach for the entry is what lets ONE other
   * caller exist: the welcome-back offer (`RoomTriggerDispatcher.askAside`,
   * DOR-1046) asks an agent a question the room never posted, about an entry it
   * already did. The entry stays the thing the turn is ABOUT — it frames the
   * context and names the presence indicator — while this is the thing asked.
   *
   * It is still the whole message and nothing else: where the turn is happening
   * rides `roomContext` (ADR-0273), never this string.
   */
  prompt: string;
  /**
   * Where the turn is happening: the room, the roster, what the agent missed and
   * what is left to spend. Rides the runtime-neutral `additionalContext` bag
   * rather than the message (ADR-0273), so `entry.body.text` reaches the model
   * as exactly the words a person typed.
   */
  roomContext: RoomContextData;
  /**
   * The files {@link RoomTurnRequest.roomContext} refers to, and the runner's
   * obligation: every one of these must be on disk under `agentPath` before the
   * turn starts, or the context is describing files the agent cannot open.
   *
   * Carried on the request rather than looked up by the runner because the set
   * is decided by the context window `buildRoomContext` resolved — recomputing
   * it would make the two agree by convention instead of by construction
   * (ADR 260807-233816).
   */
  attachmentProjection: readonly ProjectableAttachment[];
  /**
   * Say that this turn has STOPPED and is waiting for a person — a tool
   * approval, a question, an MCP prompt.
   *
   * The one part of a turn a room has to hear about before the turn ends,
   * because the whole point of hearing it is that the turn will not end until
   * somebody acts. Everything else the runner reports is an outcome; this is a
   * state, reported while it is still true.
   *
   * Called once per prompt. The dispatcher damps repeats, so a runner never has
   * to remember whether it has already said this.
   *
   * @param waiting - What the turn stopped for.
   */
  onWaiting(waiting: RoomTurnWaiting): void;
  /**
   * Say what this turn is doing right now — the tool it just started, or `null`
   * when it is no longer doing anything nameable.
   *
   * The sibling of {@link RoomTurnRequest.onWaiting}, and reported for the same
   * reason: it is a STATE while it is still true, not an outcome. Everything
   * else the runner reports is settled by the time the room hears it.
   *
   * Called on every tool call inside this turn, and once with `null` at the
   * turn's end, however it ends. The dispatcher decides how often any of that
   * reaches the wire — a runner never has to remember what it last said.
   *
   * @param activity - The tool the turn just started, or `null` to clear.
   */
  onActivity(activity: SessionActivity | null): void;
}

/** One reason a turn has stopped and can make no progress without a person. */
export interface RoomTurnWaiting {
  /** What sort of answer the turn is parked on; picks the room's words. */
  kind: WaitingKind;
  /**
   * The tool an approval is about, when the prompt names one. **For the log
   * only** — see `buildWaitingNotice` on why it is not in the room's copy.
   */
  toolName?: string;
}

/** What a turn produced, however long it took to produce it. */
export interface RoomTurnReply {
  /** What the agent said, or `null` when it said nothing worth posting. */
  text: string | null;
  /** Set when the room got no answer for a reason a member should see. */
  unanswered?: RoomTurnUnanswered;
}

/** An answer that arrived after the room stopped waiting for it. */
export interface LateRoomReply extends RoomTurnReply {
  /** How long the answer took, from the trigger to the turn closing. */
  waitedMs: number;
}

/** What one agent turn produced. */
export interface RoomTurnResult extends RoomTurnReply {
  /**
   * The session the turn ran on. Bound to `(room, agent)` first-write-wins, so
   * an agent keeps one thread of context per room.
   */
  sessionId: string;
  /**
   * Set when the turn outran the room's wait and is still running. Resolves
   * when it finally closes, and its answer is posted then — late, and saying
   * so. Cancelling instead was considered and rejected: silence is the worse
   * failure (room-participation spec, constraint 6).
   *
   * **Settling this promise is what releases the turn's claim**, and nothing
   * else does: `runOne` hands the claim over the moment this field is present.
   * A runner that returns a promise it never settles leaves that agent reading
   * as working for the life of the process. `collectReply`'s ceiling
   * (`room-turn-runner.ts`) is what bounds it in production, so a new runner
   * owes the room the same guarantee — resolve or reject, always, eventually.
   */
  late?: Promise<LateRoomReply>;
}

/** The seam between a room and the turn machinery. */
export interface RoomTurnRunner {
  /**
   * Run one turn and resolve with what the agent said.
   *
   * @param request - The room, the agent, its session binding, and the trigger.
   */
  run(request: RoomTurnRequest): Promise<RoomTurnResult>;
  /**
   * Stop a turn that is already running, without waiting for what it would have
   * said.
   *
   * The transport half of RP8's halt verb (room-participation spec §10.4): a
   * control action, reaching the runtime rather than the model. Resolving says
   * only that the interrupt was delivered — the turn's own stream still closes
   * the ordinary way, and the room has already stopped listening by then.
   *
   * Never rejects for "there was nothing to interrupt": a halt races the turn it
   * is halting, and a turn that finished a moment earlier is a successful halt,
   * not a failure.
   *
   * **The answer is whether the stop LANDED ON ANYTHING** — the runtime's own
   * `interruptQuery` boolean, carried out rather than dropped here (DOR-1425).
   * `false` means the runtime had no turn to aim it at: either the turn was
   * already over, or it had not yet reached the point where it can be stopped.
   * The claim is dropped and the room says the same thing either way, because a
   * claim held for a turn nobody could interrupt is an indicator with nothing
   * behind it; what the answer buys is a log an operator can read, and the one
   * place the room could ever say "we could not reach the agent".
   *
   * Deliberately still a boolean and not the five-value receipt of
   * `specs/runtime-interrupt-receipts` §5.2: that spec replaces this return type
   * along with every other stop-shaped verb's, and widening one caller ahead of
   * it would be a second vocabulary to migrate.
   *
   * @param request.sessionId - The session the turn is running on.
   * @param request.agentPath - The agent's directory, which selects its runtime.
   * @returns Whether the runtime had a turn to stop.
   */
  interrupt(request: { sessionId: string; agentPath: string }): Promise<boolean>;
}
