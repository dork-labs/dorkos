/**
 * What the room trigger dispatcher is built from, what it writes through, and
 * what one dispatch reports back.
 *
 * @module server/services/rooms/service/room-trigger-deps
 */
import type {
  AuthorRef,
  RoomAttachment,
  RoomEntry,
  RoomPresencePayload,
  SkippedTrigger,
} from '@dorkos/shared/room-schemas';
import type { RoomContextCanvas } from '@dorkos/shared/additional-context';
import type { BridgedRoomFraming } from '../../relay/chat-bridge/room-context-framing.js';
import type { AuthorRegistry } from '../author-registry.js';
import type { EngagedWindow } from '../engagement.js';
import type { RoomLimitsResolver } from '../limits/room-limits.js';
import type { RoomTurnBudget } from '../limits/turn-budget.js';
import type { CascadeStamp, RoomNoticeWriter } from '../notices/notice-log.js';
import type { ReactionStore } from '../reactions/reaction-store.js';
import type { RoomWorktreeManager } from '../repo/room-worktree-manager.js';
import type { ResponseGateMode } from '../response-gate/routing-rules.js';
import type { CollectWindow } from '../room-collect.js';
import type { RoomAgentLookup } from '../room-errors.js';
import type { RoomStore } from '../room-store.js';
import type { RoomTurnRunner } from '../room-turn-port.js';

/**
 * How a post gets written back into the room.
 *
 * `replyTo` is what keeps an answer where the question was asked: an agent
 * triggered by a thread reply answers in that thread, not at the channel's top
 * level (ADR 260728-022013). Under the child-room shape the answer landed in the
 * thread for free, because the thread was the room.
 */
export interface RoomTriggerWriter extends RoomNoticeWriter {
  post(
    roomId: string,
    input: {
      authorId: string;
      text: string;
      sessionId?: string;
      trigger: CascadeStamp;
      replyTo?: string;
      /**
       * The entry this post answers.
       *
       * `replyTo` says which THREAD to land in; this says which MESSAGE was
       * answered, and the two are different questions — a channel post has no
       * thread and still answers something. Set on every agent-authored post,
       * because a reader cannot tell from the outside which answers waited.
       */
      answersEntryId?: string;
    }
  ): RoomEntry;
}

/**
 * What one post asked of a room, as far as the write itself can say.
 *
 * **Everything here is decided synchronously**, inside `RoomService.post` and so
 * inside the HTTP request that wrote the entry — which is exactly why it can ride
 * the 202. Selection, the cascade guard and the liveness check all answer facts
 * about THIS MESSAGE (see {@link RoomTriggerDispatcher.selectCandidates}); the
 * turn budget does not, and is deliberately absent — it is charged when the
 * collect window closes, long after this has been sent, and a refusal it has not
 * made yet is not one to report.
 *
 * **`triggered` is what the room ASKED FOR, not what it guarantees**, and the
 * distinction is not academic. A collected batch is judged again when its window
 * closes, in two separate places, so an agent named here can still end up not
 * answering:
 *
 * - {@link RoomTriggerDispatcher.chooseTrigger} re-asks the cascade guard per
 *   message — asking it once at accept-time was a real defect — and
 *   `claimCollected` then asks the turn budget and the roster. A ceiling reached
 *   by a reply that landed while the batch waited, an exhausted budget, a member
 *   that left: each of those reaches the reader as the room's own durable notice.
 * - {@link RoomTriggerDispatcher.gateBatch} can route an AMBIENT burst to silence
 *   (DOR-1203). That one writes no notice on purpose — a line every time an agent
 *   tactfully says nothing is the over-participation the gate exists to prevent —
 *   and it cannot touch an addressed message: one `mention` or `dm` anywhere in a
 *   burst passes the whole burst through.
 *
 * So this field is the accept-time answer; the room's log is the settled one for
 * everything that announces itself, and deliberate silence is the one outcome
 * neither says out loud.
 *
 * `skipped` is narrower and firmer: nearly every entry in it also carries a
 * notice written on the same pass, and the one exception is the refusal the room
 * deliberately stays quiet about — see
 * {@link RoomTriggerDispatcher.announceCascade}.
 */
export interface RoomDispatchSummary {
  /** The agents a turn is now owed from, in the order the roster listed them. */
  triggered: AuthorRef[];
  /** The agents this message reached that will not answer it, and why. */
  skipped: SkippedTrigger[];
}

/** Everything {@link RoomTriggerDispatcher} is constructed from. */
export interface RoomTriggerDeps {
  store: RoomStore;
  /** Read-only here: the room context reports acknowledgments, never writes one. */
  reactions: ReactionStore;
  authors: AuthorRegistry;
  agents: RoomAgentLookup;
  /** Whether an author is the install's owner — see `RoomContextDeps.isOwnerAuthor`. */
  isOwnerAuthor(authorId: string): boolean;
  /**
   * Put the room's 👀 receipt on a person's message for an agent that was picked
   * to answer it, or take it off (DOR-2823). Written by the room on the agent's
   * behalf: it costs the agent no reaction and is never the agent's answer.
   * Optional so a harness without reactions runs unchanged.
   */
  markReceipt?(roomId: string, entryId: string, authorId: string, on: boolean): void;
  /**
   * The usage limit a chat's account hit during its last turn, if any: when it
   * resets (ISO 8601) or `null` when unknown (DOR-2823). Lets a failed turn
   * say "out of usage until 4:10 PM" instead of "ran into a problem".
   * Optional so a harness without the limit store runs unchanged.
   */
  usageLimitFor?(sessionId: string): { resetsAt: string | null } | null;
  /** The operator's profile name — see `RoomContextDeps.operatorName`. */
  operatorName?(): string | null;
  /**
   * What a room's turn is told about the chat it projects, or `null` when
   * unbridged. Read only by `buildRoomContext` — the dispatcher itself never
   * branches on it, because a bridged room's turns are decided by exactly the
   * machinery every other room's are (chats-as-channels §11.1).
   */
  bridgedFraming(roomId: string): BridgedRoomFraming | null;
  /**
   * The stored forum-topic name for a batch of entries. Read only by
   * `buildRoomContext`, for the same reason as {@link RoomTriggerDeps.bridgedFraming}.
   */
  topicNamesFor(entryIds: readonly string[]): Map<string, string>;
  /**
   * The attachments on a batch of entries. Read only by `buildRoomContext`, for
   * the same reason as {@link RoomTriggerDeps.bridgedFraming}.
   */
  attachmentsFor(roomId: string, entryIds: readonly string[]): Map<string, RoomAttachment[]>;
  /**
   * What is on this room's shared canvas, as LABELS. Read only by
   * `buildRoomContext`, for the same reason as {@link RoomTriggerDeps.bridgedFraming}.
   */
  canvasFor(roomId: string, threadRootEntryId?: string): RoomContextCanvas | null;
  runner: RoomTurnRunner;
  /**
   * The install's room-worktree manager, for granting a turn in a project room
   * its agent's copy of the room's files (spec `agent-home-desk` §5.1).
   * Optional: an install with no repo machinery grants nothing, and every turn
   * runs in the agent's own directory either way.
   */
  worktrees?: () => RoomWorktreeManager | null;
  writer: RoomTriggerWriter;
  /**
   * The per-room ceiling on automatic turns, counted whoever the caller claims
   * to be. The cascade guard reads caller-asserted identity and is therefore
   * only as strong as the posture; this is not.
   */
  budget: RoomTurnBudget;
  /**
   * What bounds automatic replies in ONE room: the room's own overrides where
   * it has them, Settings otherwise (`resolveRoomLimits`, DOR-1429).
   *
   * One seam rather than the three loose config readers it replaced, because
   * the three were never independent — `turnLimitsEnabled` decides whether the
   * other two are consulted at all, and a caller that read them one at a time
   * could assemble half a verdict while somebody toggled a setting between two
   * of the reads.
   *
   * Resolved per dispatch, so a change in Settings or on the room binds the
   * very next message rather than the next server start. The hourly ceilings
   * are NOT read here: {@link RoomTriggerDeps.budget} owns those, through the
   * same ladder.
   */
  limitsFor: RoomLimitsResolver;
  /**
   * The live engaged-window ceilings, read per dispatch for the same reason:
   * shortening the window in Settings has to bind the very next message.
   */
  engagedWindow(): EngagedWindow;
  /**
   * The live collect ceilings, read per burst for the same reason: shortening
   * the gathering window in Settings has to bind the very next message.
   */
  collect(): CollectWindow;
  /**
   * Whether an overhearing agent may be excused from a message that was plainly
   * somebody else's — `rooms.responseGate`.
   *
   * Read per sweep, like every other setting on this path, so switching it off
   * binds the very next burst rather than the next server start. `'off'` makes
   * {@link RoomTriggerDispatcher.gateBatch} return its input untouched, which is
   * bit-for-bit the behaviour that shipped before DOR-1203.
   */
  responseGate(): ResponseGateMode;
  /**
   * How long a message may wait on an agent busy in another room before this
   * room gives up on it, in milliseconds — `rooms.lateReplyCeilingMinutes`.
   *
   * The same ceiling the turn runner uses for a late answer, read here for the
   * same reason it is read there: the two are the same judgement about when a
   * room stops waiting, at two different grains. Read per tick so a change in
   * Settings binds the very next sweep.
   */
  holdCeilingMs(): number;
  /**
   * How many turns one agent may run in its own directory at once —
   * `rooms.maxConcurrentTurnsPerAgent`, the count behind the second claim
   * ceiling (see `claimBusyWith`).
   *
   * Read at every claim decision rather than captured, so raising it in
   * Settings lets the very next message start, and lowering it holds the very
   * next one — without stopping any turn already running.
   */
  maxConcurrentTurnsPerAgent(): number;
  /**
   * Put one agent's working state on the room's stream — live only, never
   * logged.
   *
   * Deliberately NARROWER than the `RoomService.publishSignal` it is wired to at
   * construction, which keeps a `signal` parameter because it mirrors the
   * community port. Here the signal is always `progress` (room-presence spec §1:
   * reuse the relay's vocabulary, never mint a name; `typing` is not used because
   * agents do not type, they work), so passing it would be a parameter with one
   * correct value and several wrong ones. The rule is a type instead of a
   * comment, and the payload is required rather than optional because a presence
   * publish that omits it is an indicator no client can key, age, or clear.
   */
  publishPresence(roomId: string, authorId: string, presence: RoomPresencePayload): void;
  /**
   * Say how many agents are working in a room, to everyone — not just to the
   * readers who have that room open.
   *
   * The sibling of `publishPresence`, on the other stream and at the other
   * grain. Presence rides the room's own channel and names an agent, an entry
   * and a start, because the room view draws a sentence about them. This rides
   * the GLOBAL fan-out and carries a bare count, because the sidebar draws a dot
   * on a row for a room the reader is not in — and a count is the most a row can
   * say without leaking who is talking to whom into a list that spans every
   * room. Both are ephemeral; neither is ever logged.
   */
  publishWorkingCount(roomId: string, working: number): void;
}
