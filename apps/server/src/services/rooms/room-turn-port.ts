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
import type { RoomContextData, RoomReplyMode } from '@dorkos/shared/additional-context';
import type { Room, RoomEntry } from '@dorkos/shared/room-schemas';
import type { SessionActivity } from '@dorkos/shared/session-stream';
import type { InterruptReceipt } from '@dorkos/shared/types';
import type { ProjectableAttachment } from './room-context.js';
import type { RoomTurnUnanswered } from './notices/notice-log.js';
import type { WaitingKind } from './notices/notice-copy.js';

// Re-exported rather than redefined: the vocabulary is runtime-neutral (both the
// room and every runtime adapter's prompt need it), so it is declared once in
// `@dorkos/shared` and reaches the rooms domain from here like the rest of the
// turn contract. **The flag is never read as "suppress the text"** — see
// `resolveReplyMode` in `room-turn-runner.ts`, the only thing holding both the
// flag and the runtime's own answer.
export type { RoomReplyMode };

/** One agent turn, as the room asks for it. */
export interface RoomTurnRequest {
  /** The room the answer will be posted into. */
  room: Room;
  /** The agent author being triggered. */
  authorId: string;
  /**
   * The agent's directory — its IDENTITY, and nothing about where files go.
   *
   * It selects the runtime, keys the claim map and both busy ceilings, and names
   * the worktree the turn may run in. It stopped being the working directory in
   * DOR-1597; {@link RoomTurnRequest.cwd} is that now, and the two are the same
   * string for every room without files of its own.
   */
  agentPath: string;
  /**
   * The directory this turn actually runs in (spec `project-rooms` §3.5).
   *
   * Resolved ONCE per turn, by the dispatcher, BEFORE the room context is built
   * — because the context names attachment paths relative to it and the runner
   * puts the files there, so a cwd decided later would describe files the model
   * cannot open. The dispatcher's `resolveCwd`, feeding the session-cwd
   * resolver's rung 2, is what decides it.
   *
   * For a room with no files of its own this is {@link RoomTurnRequest.agentPath}
   * exactly. For a project room it is that agent's standing working copy of the
   * room's repo. Nothing downstream may substitute one for the other.
   */
  cwd: string;
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
   * obligation: every one of these must be on disk under {@link RoomTurnRequest.cwd}
   * before the turn starts, or the context is describing files the agent cannot
   * open.
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
  /**
   * Say how this turn's words will reach the room, as soon as it is known (spec
   * `tool-only-room-replies` §D2).
   *
   * Reported rather than asked for, and for the reason `onActivity` is: the
   * ROOM cannot answer it. Resolving the mode needs the runtime's own claim
   * about whether the session carries the posting tool, which is knowledge the
   * dispatcher deliberately does not hold.
   *
   * Called exactly once, before the turn starts, so a `post_to_room` made from
   * inside it can read the mode off the live claim — that is what conditions the
   * DM refusal (§D3). It is carried on the reply as well
   * ({@link RoomTurnReply.replyMode}); this is the same fact reaching the other
   * consumer at the other end of the turn.
   *
   * @param mode - How this turn's words reach the room.
   */
  onReplyMode(mode: RoomReplyMode): void;
  /**
   * Say which session this turn is actually running on, once the runtime has
   * named it.
   *
   * The room binds a `(room, agent)` session BEFORE the claim, but on a first
   * turn the id it binds is a PLACEHOLDER — the runtime names the session
   * itself, mid-turn. So a mid-turn tool post that read the binding would stamp
   * an id nothing ever writes to again (spec `tool-only-room-replies` §D8).
   *
   * Called once, as soon as the turn's canonical id is known and before the
   * answer is collected, so almost every tool call inside the turn sees the real
   * one. A runner that never calls it leaves the claim without a session id, and
   * a tool post then carries none rather than carrying a wrong one.
   *
   * @param sessionId - The canonical session this turn is running on.
   */
  onSessionBound(sessionId: string): void;
  /**
   * Force this turn's reply mode instead of letting the runner resolve one
   * (spec `tool-only-room-replies` §D12).
   *
   * **One caller, and it is a decision rather than an escape hatch**: the
   * welcome-back offer (`RoomTriggerDispatcher.askAside`). That turn's text IS
   * still the room's message under the flip — the greeter posts it itself,
   * outside `deliver` — so a resolved `'tool-only'` would tell the agent
   * "nothing you write back this turn is posted" and then post exactly what it
   * wrote. Being told the opposite of what happens is the drift this whole
   * feature is most exposed to, and here it is reachable in one line.
   *
   * Why the greeter keeps text-as-reply at all is §D12: a welcome-back offer is
   * the ROOM asking a closed question on the person's behalf rather than the
   * agent choosing to speak, four of `askAside`'s outcomes are already silent by
   * design, and routing it through a tool would give it a fifth way to produce
   * nothing while the person is owed exactly one line.
   *
   * Absent — every ordinary trigger — means the runner resolves it, which is the
   * only path that reads the flag at all.
   */
  replyMode?: RoomReplyMode;
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
  /**
   * How this turn's words reach the room — resolved by the runner, which is the
   * only thing that knows both the flag and the runtime's own answer about tool
   * capability (spec `tool-only-room-replies` §D2).
   *
   * Carried here rather than re-derived in `deliver` for two reasons. A LATE
   * answer is delivered minutes after its turn started, and re-reading the flag
   * then would apply a setting the turn never ran under. And the derivation
   * needs the runtime, which the dispatcher deliberately does not hold.
   *
   * **Absent means `'text'`**, so every path that produces a reply without one —
   * a busy refusal, a `FakeAgentRuntime`, a scenario harness that predates the
   * field — behaves exactly as it does today. That is the fail-open direction,
   * and it is chosen: silence is the worse failure
   * (`.claude/rules/room-conduct.md`, constraint 6).
   */
  replyMode?: RoomReplyMode;
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
   * **The answer is the runtime's own {@link InterruptReceipt}**, carried out
   * rather than dropped here (DOR-1425, spec `runtime-interrupt-receipts` §5.2).
   * `not-running` means the runtime had no turn to aim it at: either the turn
   * was already over, or it had not yet reached the point where it can be
   * stopped. `unconfirmed` and `failed` mean the opposite — a turn IS there and
   * nothing DorkOS can see ended it — which the boolean this replaced folded
   * together with the first case.
   *
   * The claim is dropped whatever the receipt says, because a claim held for a
   * turn nobody could interrupt is an indicator with nothing behind it. What the
   * receipt buys is a log an operator can read, and the one place the room could
   * ever say "we could not reach the agent".
   *
   * @param request.sessionId - The session the turn is running on.
   * @param request.agentPath - The agent's directory, which selects its runtime.
   * @returns The receipt naming which of the five endings the stop reached.
   */
  interrupt(request: { sessionId: string; agentPath: string }): Promise<InterruptReceipt>;
}
