/**
 * Turning a committed post into agent replies (spec `rooms` §§5-6).
 *
 * This is the file R1 deliberately did not write. `addressing.ts` and
 * `cascade-guard.ts` shipped as pure rules with no production caller; this
 * module is that caller, and it owns the one thing neither of them can express
 * on its own — the loop. A post selects its targets, the guard vetoes some of
 * them, the survivors run a turn on their `room_sessions` binding, and whatever
 * they say is posted back into the room, which selects targets again.
 *
 * Three things about that loop are load-bearing:
 *
 * 1. **Provenance is threaded through every hop.** A reply carries the
 *    triggering entry's `cascadeRoot` and its own depth, so the guard reading
 *    the next hop sees the whole chain. A path that forgets to carry it is
 *    unguarded and looks fine in tests, because the guard's absence is only
 *    visible under a cascade (ADR 260726-170127).
 *
 * 2. **A target is claimed BEFORE its turn runs, and TWO ceilings decide
 *    whether it may be.** A room binds one session per agent, so a second turn
 *    there is a second writer on one transcript answering a room that asked
 *    once — and an agent is one working directory, so a turn started for it in
 *    ANOTHER room is a second process in that same checkout. {@link
 *    RoomTriggerDispatcher} holds an in-flight claim per `(room, agent)`,
 *    carrying the agent's path, and {@link RoomTriggerDispatcher.busyWith}
 *    asks both questions of it. Neither is scoped to an exchange, because the
 *    cascade rules bound an exchange and every message a person sends starts a
 *    new one. Refusing, not queueing: this domain has declined a scheduler
 *    twice (ADR 260726-170125), and the room says which of the two it is.
 *
 * 3. **Every way an agent can fail to answer is visible, and repeats are damped
 *    against agents rather than against people.** The guard refusing it, its
 *    session being busy, its session failing to bind, its turn failing: each
 *    writes a `notice` into the room — the bind case was the last holdout,
 *    closed by DOR-1206. A silently dropped trigger is indistinguishable from a
 *    broken agent, and in a shared room the person who notices is not the
 *    person who configured it. But a notice per refusal is its own failure —
 *    over-participation, not silence, is what people complain about — so
 *    repeats are damped, on keys that differ by what each rule is about:
 *
 *    - The GUARD's refusal is damped per cascade, because "this exchange went
 *      around enough times" is a fact about one exchange.
 *    - A BUSY agent is damped per `(room, agent, reason)` — but only for
 *      triggers nobody directed at it: an agent's reply re-triggering a
 *      colleague, and the ordinary chatter that reaches an `engaged` agent
 *      inside its window. A message that NAMED this agent (or any message in a
 *      DM, where naming is implicit) is never damped, because a direct question
 *      deserves a direct answer and the count is bounded by how many such
 *      messages the sender chose to write. A session that could not be BOUND
 *      damps the same way, for the narrower reason that its one reachable cause
 *      — contention on the `(room, agent)` session row — is usually gone by the
 *      next message.
 *    - A FAILED turn is never damped at all. Each error is a distinct event, and
 *      swallowing the second leaves the room's last word describing a fault that
 *      has already been superseded.
 *
 *    The one silence that stays silent is an agent that ran a turn and chose to
 *    say nothing, because that is conduct rather than a fault.
 *
 *    A turn that STOPPED is reported too, and it is the only report that does
 *    not describe an outcome: a turn parked on a tool approval, a question or an
 *    MCP prompt produces nothing until a person answers it in that agent's own
 *    session, and until DOR-784 nothing anywhere said so — three agents sat
 *    silent in a room for up to forty-one minutes apiece while their prompts
 *    quietly expired. The runner reports it through `onWaiting` while it is
 *    still true, and the memory for it is scoped to the TURN, so a second wait
 *    in a later turn is news again.
 *
 *    All of that memory — every damping key, and the writes it damps — lives in
 *    `notices/notice-log.ts`. It used to live here, fifty lines away from the
 *    writes, which is how one key came to serve two kinds of news.
 *
 * 4. **A slow turn is late, never lost, and never looks idle.** When a turn
 *    outruns the room's wait the room stops waiting, not the turn — the answer
 *    is posted when it lands, saying how long it took (room-participation spec,
 *    §5 edge case 6). The CLAIM outlives the wait too: it is released when the
 *    turn reaches a terminal, not when the room gives up waiting. Releasing it
 *    at the deadline made an agent that was still working read as idle for up
 *    to the difference between the two settings — 50 minutes on the shipped
 *    defaults — to the cascade guard and to every room-mate reading
 *    `room_context.working` (room-presence spec §3.1).
 *
 * 5. **The room says who is working, for exactly as long as it is true.** The
 *    claim map is also the working indicator a person sees, published on the
 *    room's ephemeral signal channel as it changes and re-stated every ten
 *    seconds while it lasts. There is no second source: no route, no tool and no
 *    model can turn an indicator on, and every release is a claim's release, so
 *    an indicator cannot outlive the work it describes. That is the mechanical
 *    honesty `meta/agent-etiquette.md` E16 asks for, and it is why the publishes
 *    live in {@link RoomTriggerDispatcher.holdClaim} and
 *    {@link RoomTriggerDispatcher.releaseClaim} rather than at each terminal.
 *
 * 6. **A turn answers a MOMENT, not a message** (RP8, room-participation spec
 *    §10.4). Between a post and a turn sits `room-collect.ts`: messages for one
 *    `(room, agent)` pair gather for `rooms.collectDebounceMs` and become ONE
 *    turn, and a message that lands while the agent is already working here is
 *    held rather than refused — the claim's release runs a turn for it, framed
 *    as having arrived while the agent was working. Three people talking at once
 *    get one considered answer instead of three rushed ones, and the running
 *    turn is never cancelled or re-prompted.
 *
 *    **The other ceiling holds too, and no longer refuses** (ADR 260818-234541,
 *    which amends 260726-170125 on exactly this point). An agent working in
 *    another room is working in another checkout, so no second turn starts —
 *    but the message is kept, the blocking claim's release re-arms every room
 *    waiting on that working directory, and the turn runs in the room that
 *    ASKED. Neither hold is a queue: what is stored is what the agent has not
 *    read yet, rather than a plan for a turn that is already scheduled. What a
 *    cross-room hold adds is a promise to a person, and it is made only on the
 *    room's ephemeral lane — which dies with the process that could keep it, so
 *    a restart cannot leave a durable line saying an answer is coming when none
 *    is.
 *
 * 7. **Stopping is a control action, and it is the one thing here that is not
 *    a reaction to a message.** {@link RoomTriggerDispatcher.halt} interrupts
 *    every in-flight turn in a room, releases every claim through the same seam
 *    every other terminal uses, and writes one notice. Nothing in this file — or
 *    any file — infers it from what somebody typed (room-participation spec
 *    §10.4).
 *
 * The turn itself is behind {@link RoomTurnRunner}, so this file has no
 * knowledge of sessions, runtimes or locks — `room-turn-runner.ts` holds that,
 * and a test supplies a runner that answers immediately.
 *
 * @module server/services/rooms/room-trigger
 */
import { randomUUID } from 'node:crypto';
import type {
  Room,
  RoomAttachment,
  RoomEntry,
  RoomHeldBehind,
  RoomPresencePayload,
  RoomPresenceState,
} from '@dorkos/shared/room-schemas';
import type { SessionActivity } from '@dorkos/shared/session-stream';
import { newDispatchId } from '@dorkos/shared/dispatch-id';
import { logError, logger } from '../../lib/logger.js';
import { runInDispatch } from '../../lib/dispatch-context.js';
import { recordDispatchEnd, recordDispatchStart } from '../observability/dispatch-buffers.js';
import { ACTIVITY_FANOUT_THROTTLE_MS } from '../session/index.js';
import {
  selectTriggerTargets,
  standDownFallbackSeat,
  type AddressingMember,
} from './addressing.js';
import {
  DISPATCH_OUTCOMES,
  agentKey,
  claimBusyWith,
  claimsWorkingIn,
  deepestClaimOf,
  describeClaims,
  describeHolds,
  type ActiveClaim,
  type ActiveClaimView,
  type ClaimBusy,
  type ClaimOutcome,
  type HeldRecord,
  type HoldEnd,
  type HeldView,
  type TriggerTarget,
} from './room-claims.js';
import type { BridgedRoomFraming } from '../relay/chat-bridge/room-context-framing.js';
import type { AuthorRegistry } from './author-registry.js';
import { isLiveAuthor } from './handles/author-handles.js';
import {
  evaluateCascade,
  type CascadeDecision,
  type CascadeRefusalReason,
} from './cascade-guard.js';
import { engagementFor, type EngagedWindow, type EngagementWindow } from './engagement.js';
import {
  RoomCollector,
  type CollectedTrigger,
  type CollectWindow,
  type RoomCollection,
} from './room-collect.js';
import type { ReactionStore } from './reactions/reaction-store.js';
import { buildRoomContext } from './room-context.js';
import {
  RoomNoticeLog,
  type CascadeStamp,
  type RoomNoticeWriter,
  type RoomTurnUnanswered,
} from './notices/notice-log.js';
import { buildCascadeNotice, withLateAnswerNote, type BusyContext } from './notices/notice-copy.js';
import type { RoomAgentLookup } from './room-errors.js';
import type { LateRoomReply, RoomTurnReply, RoomTurnRunner } from './room-turn-port.js';
import type { RoomStore } from './room-store.js';
import type { RoomLimitsResolver } from './limits/room-limits.js';
import type { RoomTurnBudget } from './limits/turn-budget.js';

// Re-exported rather than redefined. The turn port moved to its own module
// (`room-turn-port.ts`), and the room service plus every rooms test imports it
// from here — one definition, one import path, no churn at nine call sites.
export type { RoomTurnUnanswered, CascadeStamp };
export type {
  RoomTurnRequest,
  RoomTurnWaiting,
  RoomTurnReply,
  LateRoomReply,
  RoomTurnResult,
  RoomTurnRunner,
} from './room-turn-port.js';

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
 * One agent a message reached, as the guard left it — before anything asks
 * whether a turn can run for it.
 *
 * The line between this and {@link TriggerTarget} is the collect window (RP8):
 * everything here was decided about ONE MESSAGE, and everything a target
 * carries — a session, a dispatch id, a cursor, a budget reservation — belongs
 * to ONE TURN, which may answer several of these at once.
 */
interface TriggerCandidate {
  authorId: string;
  agentPath: string;
  displayName: string;
  /** The depth the guard allowed this trigger at. */
  depth: number;
  /** Its open engaged window when this message landed, or `null`. */
  engaged: EngagementWindow | null;
}

/** Everything {@link RoomTriggerDispatcher} is constructed from. */
export interface RoomTriggerDeps {
  store: RoomStore;
  /** Read-only here: the room context reports acknowledgments, never writes one. */
  reactions: ReactionStore;
  authors: AuthorRegistry;
  agents: RoomAgentLookup;
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
  runner: RoomTurnRunner;
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

/**
 * How often a live claim re-states itself on the room's stream.
 *
 * Signals never replay, so a client that opens a room in the middle of a turn
 * would otherwise see nothing until that turn ended — up to an hour of a room
 * that looks idle while an agent works. The loop makes presence self-healing:
 * within one interval of connecting, reconnecting, or recovering a stalled
 * stream, a client is repainted from live state alone.
 *
 * It is also half the crash guard. Claims are memory-only, so a server that dies
 * mid-turn simply stops re-stating them, and the client's own TTL (three of
 * these intervals) clears the indicator seconds later. Nothing has to be
 * persisted, and nothing can be stranded by a process that never came back.
 *
 * Deliberately a constant and not configuration: it changes how quickly a stale
 * indicator heals, never what the room does. Tuning it would be a knob with no
 * honest guidance (room-presence spec §10). If dogfooding shows it wants tuning,
 * that is evidence it was behaviour after all, and it graduates with the
 * `adding-config-fields` lifecycle.
 */
const PRESENCE_REPUBLISH_MS = 10_000;

/**
 * Whether two readings say the same thing about a turn.
 *
 * The same tool on the same target is not a change, so it is neither worth a
 * frame nor worth restarting anything on screen for.
 *
 * @param a - One reading, or `undefined` for none.
 * @param b - The other.
 */
function sameActivity(a: SessionActivity | undefined, b: SessionActivity | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.toolName === b.toolName && a.target === b.target;
}

/**
 * Runs addressing, the cascade guard, and the turns that survive both.
 *
 * Construction is deliberately cheap and side-effect free: an install with no
 * rooms in it pays for one object.
 */
export class RoomTriggerDispatcher {
  private readonly deps: RoomTriggerDeps;

  /**
   * Turns in flight, keyed `(room, agent)` — one apiece, which is the rule
   * {@link RoomTriggerDispatcher.busyIn} enforces rather than merely records.
   *
   * The VALUE carries every field a reader needs. Nothing parses the key back
   * apart — an earlier revision did, against a separator it guessed wrong, and
   * the resulting lookup silently returned "no active turn" for every caller
   * while every test still passed.
   */
  private readonly claimed = new Map<string, ActiveClaim>();

  /**
   * Rooms waiting on an agent that is mid-turn in a DIFFERENT room, keyed
   * `(room, agent)` — one apiece, which is the grain of the collection each one
   * stands for.
   *
   * **This class is the only writer, for the same reason it is the only writer of
   * {@link RoomTriggerDispatcher.claimed}: a held indicator is this map made
   * visible.** A second writer would be a second source of a promise the room is
   * making to a person, and the whole honesty argument for saying "it will pick
   * this up" rests on the promise existing exactly as long as the machinery that
   * can keep it.
   *
   * **Only the `elsewhere` ceiling records one.** A same-room hold needs none:
   * the agent already holds a claim here, so the room is showing it as working
   * and the peek already has a row for it. A second indicator under the same
   * author would draw one agent twice.
   *
   * Process memory, like the claim it waits behind. A restart forgets it, the
   * message stays behind the agent's read cursor and reaches it on the next turn
   * as ambient context, and nothing durable was ever written that a restart could
   * make untrue — see `.claude/rules/room-conduct.md` on why a room trigger is
   * never a durable queue row.
   */
  private readonly held = new Map<string, HeldRecord>();

  /**
   * The turns a halt stopped, by dispatch id — the answers this room throws
   * away (DOR-1232).
   *
   * **An interrupt is a request, not a guarantee, and this is what makes Stop
   * mean stop anyway.** {@link RoomTurnRunner.interrupt} resolving says only
   * that the interrupt was DELIVERED: the turn's own stream still closes the
   * ordinary way, and a model that had all but finished streams its last words
   * either side of the signal. Measured on 2026-08-15 against a live install —
   * the room wrote its one `halted` notice and then posted the stopped turn's
   * complete, well-formed answer two seconds later, so pressing Stop looked, to
   * the person who pressed it, like nothing had happened.
   *
   * Keyed by DISPATCH rather than by `(room, agent)`, and both halves matter:
   * the claim that would otherwise carry it is gone by the time the answer
   * lands — a halt releases every claim it drops — and the NEXT turn for the
   * same pair is a different dispatch that Stop said nothing about.
   *
   * Bounded by construction rather than by a sweep: every claim belongs to a
   * frame that forgets its mark at its terminal, and a turn handed to
   * {@link RoomTriggerDispatcher.deliverLate} is forgotten there instead,
   * because that delivery is still ahead of it.
   */
  private readonly haltedTurns = new Set<string>();

  /**
   * Where Stop is still standing: `(room, agent)` keys whose last turn here was
   * stopped and which have not been given a new one since (DOR-1313).
   *
   * **The dispatch mark above guards what the ROOM delivers; this guards what
   * the TURN says for itself.** An agent speaks into a room two ways — the
   * turn's narration, which `deliver` posts and the mark can therefore refuse,
   * and `post_to_room`, which the model calls by hand mid-turn and which reaches
   * {@link RoomService.postFromTool} as an ordinary write with no dispatch
   * anywhere near it. Measured on 2026-08-17: Stop pressed 0.7 s into a turn
   * that had not started streaming reached a process that was still spawning,
   * the room released the claim and forgot the dispatch at that turn's terminal,
   * and twenty-three seconds later the turn that never stopped posted a
   * seven-thousand-character answer through the tool — before its own window had
   * even closed, which is why nothing in `deliver` could have dropped it.
   *
   * Keyed by `(room, agent)` rather than by dispatch, and it has to be: the tool
   * call arrives on its own HTTP request, outside every dispatch scope, so the
   * pair is the only identity both sides share.
   *
   * **Cleared by the next CLAIM here — and NOT at the stopped turn's own
   * terminal, which is the tempting version and is exactly wrong.** In the
   * incident above the room's frame ended twenty-two seconds BEFORE the post: an
   * interrupt that closed the query settled `run()` while the CLI carried on, so
   * the room's terminal means "the room stopped listening", never "the process
   * stopped". Releasing on it reopens the bug in the one case it was built for.
   * The next claim is used instead because it is the room asking again, which
   * keeps this a stop rather than a mute, and the hand comes back AT the claim
   * rather than at the answer because speaking mid-turn is the whole point of
   * the tool. {@link RoomTriggerDispatcher.abandonHolds} drops it too, for the
   * pair that will never claim again — archived room, agent off the roster.
   *
   * **Two limits, and neither is hidden.** A stopped agent that the room never
   * triggers again cannot post into THAT room by hand, indefinitely — an
   * advertised affordance (`rooms.post` names cross-room posting) disabled for
   * one pair with no expiry. It is room-scoped, so the same agent still posts
   * into every other room it belongs to. And the window this cannot close: a
   * halt followed immediately by a new message clears the mark for the live
   * turn, and the old stopped turn — if it is still running — can post inside
   * it. Both are written down in `.claude/rules/room-conduct.md`; closing the
   * second would mean holding the mark against the live turn as well, which is
   * the mute this refuses to be.
   */
  private readonly stoppedHere = new Map<string, { roomId: string; authorId: string }>();

  /**
   * The republish loop, alive exactly while {@link RoomTriggerDispatcher.claimed}
   * is non-empty.
   *
   * An install with no room in it, and a room where nobody is working, runs no
   * timer at all — the loop is started by the first claim and cleared by the
   * last release, rather than ticking over an empty map forever.
   */
  private republishing: NodeJS.Timeout | null = null;

  /**
   * What this room has already said about itself, and what it says next.
   *
   * Every notice and every damping key lives behind it
   * ({@link RoomNoticeLog}). Held per DISPATCHER rather than per room, exactly
   * as the three sets it replaced were: the keys are room-scoped, so one object
   * for the process is one object, not a leak.
   */
  private readonly notices: RoomNoticeLog;

  /**
   * What each agent has been asked in each room and not yet answered (RP8).
   *
   * The one thing between a message and a turn. Everything else in this class
   * asks "may this run"; this one asks "is the room finished talking", which is
   * why it is a separate object rather than another map beside
   * {@link RoomTriggerDispatcher.claimed} — the two are read at different
   * moments and mean opposite things, and a collection is emphatically NOT a
   * claim: nothing is running for one.
   */
  private readonly collector: RoomCollector;

  /**
   * In-flight work, so {@link RoomTriggerDispatcher.idle} can wait it out.
   *
   * Counts collections as well as turns. A burst gathered but not yet answered
   * is work the room owes, and reporting it idle would let a test — or a
   * shutdown — measure a room that has not finished moving.
   */
  private inFlight = 0;
  private settled: Array<() => void> = [];

  constructor(deps: RoomTriggerDeps) {
    this.deps = deps;
    this.notices = new RoomNoticeLog({ writer: deps.writer, authors: deps.authors });
    this.collector = new RoomCollector({
      window: deps.collect,
      run: (batch) => this.runCollected(batch),
    });
  }

  /**
   * Trigger whoever this entry addresses. Returns immediately: posting is
   * trigger-only (ADR-0264), so the HTTP 202 must not wait on a model call.
   *
   * @param room - The room the entry landed in.
   * @param entry - The committed entry.
   * @param namedUnreachable - Members this message NAMED and could not reach,
   *   because their agent is gone. Resolved once at write time by
   *   `resolveAddressing` and handed over rather than re-derived: mentions
   *   resolve once, and a second reading of the text here would be a second
   *   answer to who a name addresses.
   */
  dispatch(room: Room, entry: RoomEntry, namedUnreachable: readonly string[] = []): void {
    // A notice is the room talking about itself. Letting it address anyone would
    // make "Ana stopped replying" a reason for Bo to start.
    if (entry.kind !== 'post') return;

    // Addressing and the guard answer PER MESSAGE and answer now, because both
    // are about this message: who it named, and how deep the exchange it belongs
    // to has gone. Only the TURN is gathered (RP8) — the message joins whatever
    // its targets have not answered yet, and one turn comes back for the lot.
    // ONE clock reading for the whole message, threaded to every agent it
    // reached. See {@link CollectInput.arrivedAt}: two readings a microsecond
    // apart can straddle a millisecond boundary, and a message that addressed
    // two agents would then be answered by them in two different sweeps — the
    // second triggered by the first's reply rather than by the message itself.
    const arrivedAt = Date.now();
    for (const candidate of this.selectCandidates(room, entry, namedUnreachable)) {
      this.collectOne(room, entry, candidate, arrivedAt);
    }
  }

  /**
   * Put one message into one agent's collection.
   *
   * **Nothing a person sends is refused for a scheduling reason any more, and
   * that is the whole change.** Both busy ceilings hold: an agent mid-turn HERE
   * is about to be free and its answer lands in front of this reader; an agent
   * mid-turn in ANOTHER room is in another checkout, so this room's message waits
   * for that turn to end and then runs here. The line that used to be written for
   * the second case asked the person to send the message again — work the machine
   * could do, over a message that was already committed to this room's log.
   *
   * **The two ceilings still part company on two things a reader can see.** A
   * `here` hold marks its messages `arrivedDuringPrevTurn`; an `elsewhere` one
   * must not, because the agent was not working here. And an `elsewhere` hold
   * records a held indicator, so the room can say what is happening while it is
   * still true — a `here` hold needs none, because the room is already showing
   * that agent as working.
   *
   * @param room - The room the message landed in.
   * @param entry - The message.
   * @param candidate - The agent it reached, as the guard left it.
   * @param arrivedAt - The message's one arrival reading, shared by every agent
   *   it reached.
   */
  private collectOne(
    room: Room,
    entry: RoomEntry,
    candidate: TriggerCandidate,
    arrivedAt: number
  ): void {
    const busyWith = this.busyWith(room.id, candidate.authorId, candidate.agentPath);
    const opened = this.collector.collect({
      room,
      authorId: candidate.authorId,
      agentPath: candidate.agentPath,
      displayName: candidate.displayName,
      entry,
      depth: candidate.depth,
      engaged: candidate.engaged,
      duringTurnHere: busyWith?.where === 'here',
      park: busyWith !== null,
      arrivedAt,
    });
    if (busyWith?.where === 'elsewhere') {
      this.noteHold(room.id, candidate.authorId, candidate.agentPath, entry.id, busyWith);
    }
    // One credit per COLLECTION, taken the moment one is opened and returned by
    // whatever settles it — the turn it produces, the refusal it earns, or the
    // halt that drops it. Taking one per message instead would make `idle()`
    // wait for turns that were always going to be folded into one.
    if (opened) this.inFlight += 1;
  }

  /**
   * Resolve once no triggered turn is in flight.
   *
   * Exists for tests and for a graceful shutdown: a cascade is asynchronous by
   * construction, so "did the room settle" is otherwise unanswerable without a
   * sleep, and a test that sleeps is a test that flakes.
   *
   * A turn the room has stopped WAITING for still counts as in flight, because
   * its answer is still coming: the room posts it late rather than dropping it.
   */
  idle(): Promise<void> {
    if (this.inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => this.settled.push(resolve));
  }

  /** Drop one in-flight dispatch, waking `idle()` waiters when the last lands. */
  private settleOne(): void {
    this.inFlight -= 1;
    if (this.inFlight !== 0) return;
    const waiters = this.settled;
    this.settled = [];
    for (const resolve of waiters) resolve();
  }

  /**
   * Select this entry's targets, run each past the guard, and write a notice for
   * every refusal.
   *
   * Evaluation happens for ALL targets before any of them is collected, so two
   * agents addressed by the same message do not cancel each other out — they
   * were both addressed by a message neither of them wrote.
   *
   * **Everything decided here is decided about THIS MESSAGE**, which is why it
   * stays synchronous inside `RoomService.post` rather than moving into the
   * collect window with the turn. Who a message addressed, whether the exchange
   * it belongs to has gone around enough times, and whether a name it typed
   * reached nobody are all facts about the message; answering them half a second
   * later would let a room's roster change under a refusal, and would delay
   * every notice a person is owed.
   */
  private selectCandidates(
    room: Room,
    entry: RoomEntry,
    namedUnreachable: readonly string[]
  ): TriggerCandidate[] {
    const members = this.deps.store.listMembers(room.id);
    const records = this.deps.authors.getMany(members.map((m) => m.authorId));
    // ONCE PER ENTRY, not once per turn. The engaged window is per member, but
    // its thread scope and its clock are shared by everyone this entry could
    // trigger — and the answer has to be the same for addressing and for the
    // context the turn is handed, or an agent gets told it is engaged by the
    // very message that decided it was not.
    const window = this.deps.engagedWindow();
    const now = new Date();
    const threadRootEntryId = entry.threadRootEntryId ?? null;
    const engaged = new Map<string, EngagementWindow>();
    const addressing: AddressingMember[] = [];
    // Who holds this room's FALLBACK SEAT — the member that answers a message a
    // person typed without addressing anybody (team-room-home spec D3.4), which
    // today is #team's default agent and `null` everywhere else. Read off the
    // room rather than inferred from anyone's `always` mode, because a person
    // may set that mode themselves and mean it (`rooms.fallback_seat_author_id`);
    // and read from the room this dispatch already holds, so it costs no query.
    const seatAuthorId = room.fallbackSeatAuthorId ?? null;
    for (const member of members) {
      const record = records.get(member.authorId);
      if (!record) continue;
      // Only an agent that did not write this entry can be inside a window, so
      // no other membership pays for the query.
      //
      // The seat is weighed even though its `always` mode ignores the flag: it
      // READS the window to decide whether to stand down for a post that
      // addressed somebody else, so it costs one bounded query (six rows at the
      // shipped defaults) for that one member, in that one room.
      const weighable = member.responseMode === 'engaged' || member.authorId === seatAuthorId;
      const open =
        record.kind === 'agent' && weighable && member.authorId !== entry.authorId
          ? engagementFor(this.deps, {
              roomId: room.id,
              threadRootEntryId,
              authorId: member.authorId,
              window,
              now,
            })
          : null;
      // The CONTEXT map takes `engaged` members only, and deliberately: an
      // agent's `roomContext.addressing` promises a window is `null` for every
      // other mode (`room-context.ts`), because reporting one would describe a
      // bound that mode does not apply. The fallback seat's window decides one
      // filter below and is never told to the agent.
      if (open && member.responseMode === 'engaged') engaged.set(member.authorId, open);
      addressing.push({
        authorId: member.authorId,
        kind: record.kind,
        responseMode: member.responseMode,
        isEngaged: open !== null,
      });
    }

    // Resolved once and read twice, because both rules below ask the same
    // question about the same post: only a PERSON's message implicitly addresses
    // anybody. An author row that has vanished reads as `system`, which is the
    // conservative side of both.
    const authorKind = records.get(entry.authorId)?.kind ?? 'system';

    // The second rule, a no-op in a room with no seat: a post that named another
    // agent is that agent's to answer, and a post an AGENT wrote is a
    // conversation already underway — the seat catches neither. See
    // `standDownFallbackSeat` for the two escapes.
    const selected = standDownFallbackSeat({
      entry,
      authorKind,
      seatAuthorId,
      members: addressing,
      selected: selectTriggerTargets({
        roomKind: room.kind,
        authorKind,
        entry,
        members: addressing,
      }),
    });
    if (selected.length === 0) {
      // **The commonest shape of the ghost case comes through here**, and it is
      // why this is not a bare `return`. A channel seeds agents at `engaged`, and
      // a ghost claims no names — so `@ana are you there?` addresses nobody,
      // selects nobody, and would leave the room silent in answer to the most
      // direct question in it. No selection ran, so nothing can overlap: the set
      // is exactly what the message named.
      //
      // A stand-down can empty the set too, and it writes NO notice — which is
      // deliberate, and the same call this file already makes for the depth
      // refusal against an agent's own un-provenanced post. A notice announces
      // that something you asked for did not happen; the seat standing down is
      // the opposite, an agent you did NOT address declining to spend a turn.
      // The shape that empties the set is a post naming only an agent somebody
      // silenced, and the room being quiet is precisely what silencing it asked
      // for. Announcing it would also spray: nothing damps a line that could
      // land on every message in a busy room.
      this.reportGone(room, entry, new Set(namedUnreachable), namedUnreachable);
      return [];
    }

    // **The whole of "limits off", for the guard half**, now asked of THIS
    // room. `turnLimitsEnabled` is read HERE rather than inside
    // `cascade-guard.ts`, which stays limit-agnostic and fully tested: a pure
    // function that sometimes decides not to decide is a worse thing to reason
    // about than a caller that decides not to ask. Unlimited means no
    // provenance query, no verdict, and no notice — nothing was refused, so
    // there is nothing to say. The stamped depth still advances, so an exchange
    // that ran unlimited is still readable as a chain afterwards, and turning
    // limits back on judges it normally.
    const limits = this.cascadeLimitsFor(room.id);
    const provenance = limits
      ? {
          root: entry.cascadeRoot,
          depth: entry.cascadeDepth,
          turnsByAuthor: this.deps.store.turnsByAuthorInCascade(room.id, entry.cascadeRoot),
        }
      : null;

    const allowed: TriggerCandidate[] = [];
    // Collected rather than reported inline, so a member that is BOTH a selected
    // target and a name this message typed gets one notice, not two.
    const gone = new Set<string>(namedUnreachable);
    for (const authorId of selected) {
      const record = records.get(authorId);
      const decision: CascadeDecision =
        limits && provenance
          ? evaluateCascade(authorId, provenance, limits)
          : { allowed: true, depth: entry.cascadeDepth + 1 };
      if (!decision.allowed) {
        // Only announce a limit something actually hit. A `depth` refusal
        // against an entry that is its OWN cascade root did not come from a
        // back-and-forth — it comes from the ceiling `deriveCascade` synthesizes
        // for an agent posting with no turn behind it. Announcing it said "Bo
        // stopped replying here — this back-and-forth hit its automatic-reply
        // limit" when Bo was never triggered, no exchange happened, and the
        // suggested remedy does nothing. Five ordinary posts by one agent
        // produced five such lines, one per room-mate, and the dedupe never
        // engaged because each post is its own root.
        //
        // THIS SILENCE IS DELIBERATE, and it survived a second look during
        // DOR-621 — which added notices to every other quiet path in this file.
        // It reads like a hole in "a refusal is visible" and it is not, for
        // three reasons worth having in front of you before you close it:
        //
        //   1. `deriveCascade` stamps such a post AT the ceiling
        //      (`cascade-guard.ts`), not at depth 0. So this refusal fires at
        //      EVERY `maxAgentDepth`, for every room-mate, on every post an
        //      agent makes outside a turn. Copy that offers to raise a limit is
        //      inert here: no limit was reached, and raising it changes nothing.
        //   2. The `(room, cascade, agent)` damping key CANNOT repeat here,
        //      because each such post is its own cascade root. Whatever notice
        //      you add is written once per post per room-mate, forever. Closing
        //      this needs a key that repeats — keyed on the room and the quiet
        //      agent, re-armed the way `noticedBudget` re-arms — not this one.
        //   3. A test pinned at `maxAgentDepth: 0` passes while the spraying
        //      case is broken, because 0 is the one value that makes the shape
        //      look sane. Any test here must use a realistic ceiling.
        //
        // The invariant is served differently: nothing was ever triggered, so
        // there is no agent that went quiet on you. `room-silence.test.ts` pins
        // BOTH sides of that narrowness — the silence here, and the two real
        // refusals that must still speak (a repeat stop, and a chain that
        // reaches the depth ceiling), so this cannot be widened into a spray or
        // narrowed into a general hush without something going red.
        //
        // On the two terms below: `fromRealChain` is the load-bearing one, and
        // the `repeat` term is a guard rather than a discriminator. Every
        // reachable repeat refusal ALSO has `fromRealChain` true, because a
        // cascade whose root is this entry contains only this entry (plus
        // system notices), so the target's count in it is zero. Kept because
        // that is a property of `deriveCascade` in another module, not of
        // anything here, and it costs one comparison to not depend on it.
        this.announceCascade(room, entry, authorId, record?.displayName, decision.reason);
        continue;
      }
      // `naturalKey` is the agentPath — the only handle the turn machinery needs
      // and the one thing that survives a mesh reconciler rebuild.
      if (!record || record.kind !== 'agent') continue;
      // A member whose directory no longer holds the agent it was added as
      // cannot take a turn, and until now nothing SAID so: the trigger went to
      // the runner, which failed somewhere inside on a path with no agent, and
      // the room reported "ran into a problem — open its session to see what
      // went wrong" about a session that does not exist. Refused here instead,
      // in its own words, because the remedy is to register the agent again
      // (ADR 260801-003051). The same test covers the subtler half: a DIFFERENT
      // agent registered in that directory is not this member either, and its
      // turns belong to its own author row.
      if (!isLiveAuthor(record, this.deps.agents)) {
        gone.add(authorId);
        continue;
      }
      allowed.push({
        authorId,
        // `naturalKey` is the agentPath — the only handle the turn machinery
        // needs and the one thing that survives a mesh reconciler rebuild.
        agentPath: record.naturalKey,
        displayName: record.displayName,
        depth: decision.depth,
        engaged: engaged.get(authorId) ?? null,
      });
    }

    this.reportGone(room, entry, gone, namedUnreachable);
    return allowed;
  }

  /**
   * Say that the guard stopped an agent — unless announcing it would describe an
   * exchange that never happened.
   *
   * The whole of that exception is in the comment block at the call site in
   * {@link RoomTriggerDispatcher.selectCandidates}: a `depth` refusal against an
   * entry that is its OWN cascade root comes from the ceiling `deriveCascade`
   * synthesizes for an agent posting with no turn behind it, so nothing was
   * triggered, no limit was reached, and the notice would spray one line per
   * room-mate per post with no damping key that can ever repeat.
   *
   * @param room - The room the message landed in.
   * @param entry - The message the refusal is about.
   * @param authorId - The agent that was stopped.
   * @param displayName - Its name, or `undefined` when its row has vanished.
   * @param reason - Which rule refused it.
   */
  private announceCascade(
    room: Room,
    entry: RoomEntry,
    authorId: string,
    displayName: string | undefined,
    reason: CascadeRefusalReason | undefined
  ): void {
    // On the two terms: `fromRealChain` is the load-bearing one, and the
    // `repeat` term is a guard rather than a discriminator. Every reachable
    // repeat refusal ALSO has `fromRealChain` true, because a cascade whose
    // root is this entry contains only this entry (plus system notices), so the
    // target's count in it is zero. Kept because that is a property of
    // `deriveCascade` in another module, not of anything here, and it costs one
    // comparison to not depend on it.
    const fromRealChain = entry.cascadeRoot !== entry.id;
    if (reason !== 'repeat' && !fromRealChain) return;
    this.notices.announce(
      room,
      entry,
      authorId,
      buildCascadeNotice(displayName ?? 'An agent', authorId),
      reason === 'repeat' ? 'cascade_repeat' : 'cascade_depth',
      // Explicitly none. This target was refused before it could be given an id
      // — and `selectCandidates` runs synchronously inside `RoomService.post`,
      // which for an AGENT'S reply is inside that agent's own dispatch scope.
      // Left to the ambient id, a refusal about Bo would be filed under Ana's
      // dispatch.
      null
    );
  }

  /**
   * The cascade guard's two numbers for one room, or `null` when this room's
   * limits are off.
   *
   * One reading of the ladder per call, which is the point: the three loose
   * config readers this replaced were not independent — a person toggling
   * `turnLimitsEnabled` between two of them would have assembled half a
   * verdict. Resolved fresh every time, so a change binds the very next
   * message.
   *
   * @param roomId - The room being judged.
   */
  private cascadeLimitsFor(
    roomId: string
  ): { maxAgentDepth: number; maxTurnsPerAgentPerCascade: number } | null {
    const limits = this.deps.limitsFor(roomId);
    if (!limits.turnLimitsEnabled) return null;
    return {
      maxAgentDepth: limits.maxAgentDepth,
      maxTurnsPerAgentPerCascade: limits.maxTurnsPerAgentPerCascade,
    };
  }

  /**
   * Everything one turn is told about what is left to spend — the room's hourly
   * headroom, the install's, and its remaining replies in this chain — with
   * `null` standing for every one of those that nothing is counting.
   *
   * `null` rather than a large number, because this is what an agent reads in
   * `room_context.budget` and decides how freely to answer against. With
   * nothing counting, any number here is invented: a big one implies a ceiling
   * that does not exist and a small one implies a squeeze that is not
   * happening. "No limit" is the only true thing to say.
   *
   * **The three are no longer `null` together, and that is the per-room
   * override showing through** (DOR-1429). A room with its own limits off on an
   * install that still counts reports `{ room: null, global: 4998,
   * repliesLeftInThisChain: null }` — the room's own two bounds are gone and
   * the install's wallet is not, which is exactly what `resolveRoomLimits`
   * decided. The two that ARE tied are the room's hourly headroom and its chain
   * headroom: both are `null` precisely when this room's `turnLimitsEnabled` is
   * false.
   *
   * **They are tied by both readings landing in one tick, not by a single
   * read.** This resolves the ladder twice — once here, once inside
   * {@link RoomTurnBudget.remaining} through `TurnBudgetLimits.perRoom` — and
   * nothing between them can move: the ladder's two rungs are a synchronous
   * `better-sqlite3` row read and a synchronous `conf` read, with no `await`
   * between the two calls, so no toggle can land in the gap. If either rung ever
   * becomes asynchronous, this is the pair that has to be resolved once and
   * threaded, because half a verdict here is a turn told it has no chain budget
   * while it still has a room budget.
   *
   * @param roomId - The room the turn is about to run in.
   * @param depth - The depth the turn being assembled carries, or `'ceiling'`
   *   for a turn that is nobody's reply and hands on no chain (an aside).
   */
  private headroomFor(
    roomId: string,
    depth: number | 'ceiling'
  ): {
    budget: { room: number | null; global: number | null };
    repliesLeftInThisChain: number | null;
  } {
    const limits = this.cascadeLimitsFor(roomId);
    return {
      budget: this.deps.budget.remaining(roomId),
      repliesLeftInThisChain:
        limits === null
          ? null
          : depth === 'ceiling'
            ? 0
            : Math.max(0, limits.maxAgentDepth - depth),
    };
  }

  /**
   * Run every collection whose window closed together: claim them all, then
   * start their turns.
   *
   * **Two passes, and the reason is the same one the two-pass bind has.**
   * `room_context.working` is read off the live claim map, so a turn assembled
   * before its colleague had claimed would tell an agent the room was idle when
   * a message it can see had just addressed somebody else too. Claiming
   * everything first makes that structural rather than a matter of which timer
   * fired first.
   *
   * @param batch - Every collection the collector just closed.
   */
  private runCollected(batch: RoomCollection[]): void {
    const started: Array<{ room: Room; entry: RoomEntry; target: TriggerTarget }> = [];
    for (const collection of batch) {
      const claimed = this.claimCollected(collection);
      if (claimed) started.push(claimed);
    }
    for (const { room, entry, target } of started) {
      void this.runOne(room, entry, target).finally(() => this.settleOne());
    }
  }

  /**
   * Pick the newest message in a batch that the guard still allows, announcing
   * every newer one it refuses on the way past.
   *
   * **The guard is asked PER MESSAGE, and asking it once for the batch was a
   * real defect.** Its repeat rule counts a durable query, so a message collected
   * while a turn was in flight could not be judged against that turn's own post;
   * re-asking when the batch runs is what still terminates a two-agent
   * ping-pong. But a batch is not one message, and a verdict taken from the
   * newest entry alone is a verdict about the wrong thing: a person's direct
   * question, parked while the agent worked, was DISCARDED because an agent's
   * reply happened to join the batch behind it and the guard vetoed on that.
   * The person's question — a fresh cascade root at depth 0, which every rule
   * here allows — never ran, and nothing said so.
   *
   * So each message carries its own verdict, newest first, and the first one
   * that survives is what the turn answers. Three consequences are load-bearing:
   *
   * - **An agent-authored message can never veto a human-authored one.** That is
   *   the whole point of `deriveCascade`'s human carve-out: a person's message
   *   mints its own root at depth 0, so it is judged on its own terms and keeps
   *   them. The bug above was exactly this carve-out being lost by aggregation.
   * - **A refused message is left UNREAD.** The cursor advances only to the
   *   trigger, so anything above it is still in the next turn's ambient window
   *   rather than silently consumed by a turn that never saw it.
   * - **The refusal is visible**, damped per `(room, cascade, agent)` like every
   *   other guard refusal — including the one deliberate silence
   *   {@link RoomTriggerDispatcher.announceCascade} keeps, so a batch cannot
   *   become a way to spray the line §5.1.1 removed.
   *
   * @param collection - The batch being judged.
   * @returns The chosen message, its verdict and its index, or `null` when every
   *   message was refused — in which case the notices are already written.
   */
  private chooseTrigger(
    collection: RoomCollection
  ): { held: CollectedTrigger; decision: CascadeDecision; index: number } | null {
    const { room, authorId, displayName } = collection;
    // Limits off in THIS room: nothing to re-ask. The newest message is the
    // trigger, and no notice is written because nothing was refused (see
    // {@link RoomTriggerDispatcher.selectCandidates} for the whole of it).
    const limits = this.cascadeLimitsFor(room.id);
    if (!limits) {
      const held = collection.entries.at(-1);
      if (!held) return null;
      return {
        held,
        decision: { allowed: true, depth: held.entry.cascadeDepth + 1 },
        index: collection.entries.length - 1,
      };
    }
    // One read per distinct cascade, not per message. A batch is usually one or
    // two exchanges, so this is a couple of indexed queries however long it is.
    const inCascade = new Map<string, ReadonlyMap<string, number>>();
    const turnsByAuthor = (root: string): ReadonlyMap<string, number> => {
      const known = inCascade.get(root);
      if (known) return known;
      const found = this.deps.store.turnsByAuthorInCascade(room.id, root);
      inCascade.set(root, found);
      return found;
    };
    for (let index = collection.entries.length - 1; index >= 0; index -= 1) {
      const held = collection.entries[index];
      const decision = evaluateCascade(
        authorId,
        {
          root: held.entry.cascadeRoot,
          depth: held.entry.cascadeDepth,
          turnsByAuthor: turnsByAuthor(held.entry.cascadeRoot),
        },
        limits
      );
      if (decision.allowed) return { held, decision, index };
      // Nothing here can double-announce: a message only reaches a collection
      // after the guard ALLOWED it, so this is the first refusal it can earn.
      this.announceCascade(room, held.entry, authorId, displayName, decision.reason);
    }
    return null;
  }

  /**
   * Turn one agent's collected messages into one claimed turn: afford it, bind
   * it, and claim it.
   *
   * Everything here is per TURN rather than per message, which is the half of
   * RP8 that shows up on a bill. **One budget reservation covers the whole
   * collected window** — three people talking at once cost one automatic turn,
   * not three — and **one claim advances the cursor past all of it**, because
   * the turn really is shown all of it: the last message is what it answers, and
   * everything behind it rides the ambient window (spec §8.3).
   *
   * The trigger is the NEWEST message the guard still allows, and the earlier
   * ones are context. Newest rather than oldest because the ambient window ends
   * at the triggering entry's `seq`, so triggering on the first of a burst would
   * put the rest above the ceiling and show the agent none of them. **Allowed
   * rather than simply last** — see {@link RoomTriggerDispatcher.chooseTrigger}.
   *
   * @param collection - What this agent has been asked and not yet answered.
   * @returns What to run, or `null` when nothing will — every such path has
   *   already settled this collection's accounting or parked it.
   */
  private claimCollected(
    collection: RoomCollection
  ): { room: Room; entry: RoomEntry; target: TriggerTarget } | null {
    const { room, authorId, agentPath, displayName } = collection;
    const newest = collection.entries.at(-1);
    if (!newest) {
      this.settleCollection(collection, 'refused');
      return null;
    }
    // Asked AGAIN, not merely re-read: a window that opened while the agent was
    // free can still close after something else claimed it — an aside turn, or
    // a burst in another room reaching the same checkout.
    const busyWith = this.busyWith(room.id, authorId, agentPath);
    if (busyWith !== null) {
      // Parked, not refused: this is the same steer `collectOne` makes, arrived
      // at from the other direction. The credit stays with the collection —
      // unless parking MERGED it into one already waiting, in which case two
      // pending turns have become one and the surplus is settled here.
      //
      // **The hold is re-stated AFTER the park, against whatever is in the way
      // now.** A batch re-armed by one claim's release frequently finds another
      // room's claim already taken by the time it gets here, and the indicator
      // has to point at that room rather than the one that just finished.
      const merged = this.collector.park(collection);
      if (busyWith.where === 'elsewhere') {
        // The batch's OLDEST message keys a new hold, which is the same choice
        // `collectOne` makes: an indicator is keyed `(room, author, entryId)`,
        // so it has to be an id that does not move while the person keeps
        // typing. An existing hold keeps its own — see `noteHold`.
        this.noteHold(
          room.id,
          authorId,
          agentPath,
          collection.entries[0]?.entry.id ?? newest.entry.id,
          busyWith
        );
      }
      if (merged) this.settleOne();
      return null;
    }

    // **Asked again at the last moment, like the ceilings above it.** A batch can
    // wait here for the best part of an hour, and a room's roster is not frozen
    // while it does: an agent removed from the room, or a room archived, must not
    // buy a turn that then POSTS into a room it is no longer in. `abandonHolds`
    // drops the wait at the moment either happens; this is the second gate, for
    // anything that changes the roster without going through the service.
    if (room.archived || this.deps.store.getMember(room.id, authorId) === null) {
      logger.info('[rooms] a waiting message never ran: the agent is no longer in the room', {
        roomId: room.id,
        authorId,
        archived: room.archived,
      });
      this.settleCollection(collection, 'left');
      return null;
    }

    const chosen = this.chooseTrigger(collection);
    if (!chosen) {
      // EVERY message in the batch was refused, so the batch is refused — and
      // the refusals are already on the log, written by `chooseTrigger` under
      // the same narrowness a single refusal has always had.
      this.settleCollection(collection, 'refused');
      return null;
    }
    const entry = chosen.held.entry;

    const target: TriggerTarget = {
      authorId,
      agentPath,
      displayName,
      // The FRESH verdict's depth, not the one the guard reached when this
      // message was collected. They agree today — depth is derived from the
      // entry rather than from the store — and taking it from the decision that
      // actually allowed this turn is what keeps them from drifting apart.
      depth: chosen.decision.depth,
      engaged: chosen.held.engaged,
      // ONE ID PER (turn, target), minted here rather than per entry. A message
      // addressed to three agents is three dispatches sharing one `entryId`: the
      // fan-out is recovered by the entry, and each agent's own chain — claim,
      // turn, reply, relay hop — is recovered by its dispatch. Minting one id
      // for the entry would put three interleaved turns on one filter and answer
      // no question at all.
      dispatchId: newDispatchId(),
      // Replaced with the real binding once the budget has been charged; a turn
      // that never becomes affordable never mints a session.
      sessionId: '',
      // Replaced with the real cursor at claim time, for the same reason.
      lastReadSeq: 0,
      // Only the messages this turn will actually be SHOWN. The window ends at
      // the trigger's `seq`, so a refused message above it is not in `pending`
      // and marking it would be a claim about a line nobody will read.
      arrivedDuringPrevTurn: new Set(
        collection.entries
          .slice(0, chosen.index)
          .filter((held) => held.arrivedDuringTurn)
          .map((held) => held.entry.id)
      ),
      // Everything gathered behind the trigger, whenever it arrived — the rest
      // of what this one turn is being asked (DOR-1231). Bounded the same way:
      // above the chosen index is refused and unread, so marking it would be a
      // claim about a line nobody will read.
      gathered: new Set(collection.entries.slice(0, chosen.index).map((held) => held.entry.id)),
    };

    // The cascade guard allowed these on the merits, one message at a time. The
    // budget is the second, blunter question — can this ROOM afford another
    // automatic turn at all — and it is asked without reference to who wrote the
    // entry, so a caller who reached depth 0 by claiming to be human still stops
    // here. ONCE for the collection, because a collection is one turn.
    //
    // **Limits off means no reservation at all**, not a reservation against a
    // huge number: an hour spent unlimited must not leave a room out of budget
    // the moment somebody turns limits back on, and a counter nothing reads is
    // a counter that lies. The budget owns that decision now, rather than a
    // branch here reading a flag the budget would then read again — one seam,
    // so an unlimited ROOM on a counting install is still charged against the
    // install's wallet and cannot be made unlimited by a caller that forgot the
    // second half of the rule (DOR-1429).
    const afford = this.deps.budget.tryReserve(room.id);
    if (!afford.allowed) {
      // This one CAN be correlated: the target survived the guard and was
      // given its id above, so the refusal belongs to a real dispatch that
      // never ran.
      this.notices.reportBudget(room, entry, afford.scope ?? 'room', target.dispatchId);
      this.settleCollection(collection, 'refused');
      return null;
    }
    // Spending again means the window moved, so re-arm the notice: the next
    // exhaustion is news, not a repeat. Only when something was actually
    // charged — with nothing counting there is no window to have rolled.
    if (afford.counted) this.notices.budgetRecovered(room.id);

    // Bind the session BEFORE claiming it. Reading the binding inside `runOne`
    // and writing it on completion left a window: two posts before the first
    // reply both saw `null`, both minted a UUID, and the second lost the
    // `onConflictDoNothing` race — leaving a real session with its own projector
    // and `session_metadata` row bound to nothing, whose reply was produced from
    // an empty context. `bindRoomSession` returns the WINNER, so claiming
    // resolves the race to one session per (room, agent).
    //
    // The id minted here is a PLACEHOLDER on the first turn: the runtime names
    // the session itself, mid-turn, and files the transcript under ITS name.
    // What moves the binding onto that name is the projector's rekey — a
    // listener registered by `room-session-convergence.ts` at boot, which fires
    // the instant the id is known. The comparison in `runOne` is the FALLBACK,
    // and it has to be: it reads a value `triggerTurn` resolves best-effort at
    // first-event-or-5s, and turn 1 routinely loses that race and hands back
    // this very placeholder (DOR-784).
    //
    // Wrapped, because it is the last thing here that can throw. It no longer
    // runs inside `RoomService.post` — the collect window put a macrotask
    // between the two — but the failure is the same one either way: a
    // `SQLITE_BUSY` on a `room_sessions` insert must cost this turn and nothing
    // else. Nothing to unwind, since no claim is held yet; the room's spend is
    // already charged and is NOT refunded, because `tryReserve` has no
    // counterpart and inventing one for a path that only fires under database
    // contention would be more machinery than the fault is worth.
    try {
      target.sessionId = this.deps.store.bindRoomSession(
        room.id,
        authorId,
        this.deps.store.getRoomSession(room.id, authorId) ?? randomUUID(),
        new Date().toISOString()
      );
    } catch (err) {
      // Visible, not silent (DOR-1206): a dropped trigger with no room entry is
      // indistinguishable from a broken agent, and in a shared room the person
      // who notices is not the person who configured it. `reportSilence` writes
      // and damps the durable notice; the STACK stays here rather than there,
      // and unlike `turn_failed` it has nowhere else to go — a bind that never
      // happened mints no session, so there is no agent stream for a person to
      // open and no `runOneInDispatch` catch to fall back on.
      logger.warn('[rooms] could not bind a room session, so this agent was not triggered', {
        roomId: room.id,
        authorId,
        entryId: entry.id,
        dispatchId: target.dispatchId,
        ...logError(err),
      });
      this.notices.reportSilence(room, entry, target, 'unavailable', target.dispatchId);
      this.settleCollection(collection, 'refused');
      return null;
    }

    // THE READ CURSOR ADVANCES HERE, AT THE CLAIM — not when the reply posts
    // (room-participation spec §8.3). The turn is about to be shown everything
    // between this cursor and this entry; a turn that then errors, times out or
    // chooses to say nothing has still SEEN those messages, and replaying them
    // on its next turn would show the agent the same conversation twice. It
    // covers the WHOLE collected window for the same reason, because the whole
    // window is what the turn is shown.
    //
    // Read then written in one synchronous pass, before anything awaits, so no
    // other writer can land an entry between the two — and the value that was
    // there rides the target to `buildRoomContext`, which is the only thing that
    // still needs it.
    target.lastReadSeq = this.deps.store.getMember(room.id, authorId)?.lastReadSeq ?? 0;
    // Monotonic in the store, so a target answering an entry BELOW its cursor —
    // a late turn on an old message — cannot walk it backwards.
    this.deps.store.setReadCursor(room.id, authorId, entry.seq);
    this.holdClaim({
      roomId: room.id,
      cascadeRoot: entry.cascadeRoot,
      authorId,
      agentPath,
      entryId: entry.id,
      dispatchId: target.dispatchId,
      depth: target.depth,
      // A real trigger, so a post this agent makes mid-turn inherits this
      // exchange and the guard sees the whole chain.
      aside: false,
      spokeViaTool: false,
      claimedAt: new Date().toISOString(),
      pastDeadline: false,
      // Zero rather than `Date.now()`: the turn's FIRST tool call should reach
      // the room immediately, and a floor set at claim time would hold it back
      // for up to one throttle window.
      activityPublishedAt: 0,
    });
    return { room, entry, target };
  }

  /**
   * Say, once per message per member, that a member's agent is gone.
   *
   * **Two ways to arrive here, one notice.** A member can be SELECTED as a
   * target and turn out to be a ghost (an `always` member, or one a live
   * room-mate's cascade reached), and a member can be NAMED by a person whose
   * `@ana` reached nobody because releasing that name is exactly what the ghost
   * mechanism does. The two overlap on the commonest shape of all — somebody
   * typing at an `always` ghost — so they are unioned before anything is
   * written rather than reported by two call sites that each look right alone.
   *
   * **Being named is a direct question, and direct questions are never damped.**
   * A ghost owns no name, so ordinary chatter cannot match one and there is no
   * spray path: a person gets back exactly as many lines as they wrote messages
   * naming it. A ghost reached by SELECTION alone is damped like a busy agent,
   * because that is a state and the most persistent one there is.
   *
   * @param room - The room the message landed in.
   * @param entry - The message.
   * @param gone - Every member whose agent is gone, from both routes.
   * @param namedUnreachable - The subset this message actually typed a name for.
   */
  private reportGone(
    room: Room,
    entry: RoomEntry,
    gone: ReadonlySet<string>,
    namedUnreachable: readonly string[]
  ): void {
    if (gone.size === 0) return;
    const named = new Set(namedUnreachable);
    const records = this.deps.authors.getMany([...gone]);
    for (const authorId of gone) {
      const displayName = records.get(authorId)?.displayName ?? 'An agent';
      this.notices.reportSilence(
        room,
        entry,
        { authorId, displayName },
        'gone',
        // Nothing was ever claimed for this member, so it has no dispatch of its
        // own — and the ambient one belongs to whoever's reply triggered this.
        // Same rule as the cascade and busy refusals above.
        null,
        { namedDirectly: named.has(authorId) }
      );
    }
  }

  /**
   * The cascade `authorId` is currently answering inside, if any.
   *
   * This is what stops an agent resetting the guard on itself. A reply the
   * dispatcher writes carries provenance because the dispatcher supplies it —
   * but an agent can also write to a room DIRECTLY, mid-turn, through
   * `POST /api/rooms/:id/entries`, and that call supplies none. Left alone,
   * every such post minted a fresh cascade at depth 0, re-triggering everyone;
   * two `always` agents that each post an update looped forever, one model call
   * per hop, with the guard never firing (every entry sat at depth 0 under its
   * own root).
   *
   * So provenance follows the TURN, not the call. Spec §6 only ever granted a
   * fresh cascade to a **human** post; treating "no trigger argument" as "no
   * cascade" quietly extended that to agents, and this is where that is undone.
   * An agent posting with no turn in flight still starts fresh, which is correct
   * and bounded — to loop it would have to be re-triggered, and by then it is
   * inside a turn and lands here.
   *
   * The deepest in-flight turn wins when an agent is answering in more than one
   * room at once: the room a post lands in cannot say which turn produced it, so
   * the conservative choice is the one closest to the ceiling.
   *
   * "In flight" now includes a turn the room stopped waiting for, which closes a
   * window where this returned `undefined` for an agent that was demonstrably
   * mid-turn — so a post it made during its own late window was read as a post
   * with nothing behind it. Provenance follows the turn; the turn had not ended.
   *
   * @param authorId - The author writing a post.
   * @returns The cascade to inherit, or `undefined` when this author has no turn running.
   */
  activeTurnFor(authorId: string): CascadeStamp | undefined {
    return deepestClaimOf(this.claimed, authorId);
  }

  /**
   * Which TURN is writing into this room right now, for the entry about to be
   * stamped — the repeat rule's unit (DOR-1434).
   *
   * **Keyed on `(room, agent)`, which is `activeTurnFor`'s deliberate opposite.**
   * That one answers "what cascade does this post inherit", and a cascade can
   * only be guessed at when an agent is answering in several rooms at once, so
   * it takes the deepest claim. This asks a question the claim map can answer
   * exactly: the claim on the room the entry lands in IS the turn writing there,
   * and there is never more than one. No heuristic, one map lookup.
   *
   * **So it answers for the TRIGGERING room only, and that is the accepted
   * trade.** An agent mid-turn in room A that posts a note into room B holds no
   * claim in B, so the note stamps null and costs one message against its author
   * there. Read that as correct rather than as a gap: nothing in B asked for that
   * turn, and B's own allowance is the one the note spends. Within A — where the
   * turn was triggered and where its answer lands — every entry it writes
   * collapses to one.
   *
   * **Aside turns count here, and do not count there.** An aside has no cascade
   * to hand on ({@link ActiveClaim.aside}), which is why `deepestClaimOf` skips
   * it — but it is unambiguously a turn, so its `post_to_room` writes carry its
   * id like any other turn's. Note the limit: this covers what the aside TURN
   * writes while its claim is held, not what the welcome-back greeter writes
   * around it. The greeter's status line goes in before `askAside` is called and
   * its offer goes in after the claim is released, so both are un-stamped — each
   * being its own cascade root, that costs nothing.
   *
   * @param roomId - The room the entry is being written into.
   * @param authorId - The author writing it.
   * @returns The dispatch id to stamp, or `undefined` when no turn is running here.
   */
  dispatchFor(roomId: string, authorId: string): string | undefined {
    return this.claimed.get(agentKey(roomId, authorId))?.dispatchId;
  }

  /**
   * Record that an agent spoke into this room deliberately, from inside its own
   * turn — `post_to_room` (room-participation spec §10.2).
   *
   * The whole effect is on the automatic post at the end of that turn: see
   * {@link ActiveClaim.spokeViaTool}. A post made with no claim held here is an
   * ordinary un-provenanced agent post and this does nothing, which is right —
   * there is no turn narration coming to suppress.
   *
   * @param roomId - The room the post landed in.
   * @param authorId - The agent that wrote it.
   */
  noteDeliberatePost(roomId: string, authorId: string): void {
    const claim = this.claimed.get(agentKey(roomId, authorId));
    if (claim) claim.spokeViaTool = true;
  }

  /**
   * Take the "this agent has already spoken here" mark, if one is standing.
   *
   * **Consume-once, and the clear is defence in depth rather than a behaviour.**
   * Be exact about that, because the tempting version of this comment overstates
   * it: today one claim serves exactly ONE delivery — `runOneInDispatch` either
   * delivers in frame or hands the turn to `deliverLate`, never both — so nothing
   * observable depends on the mark being cleared, and removing the clear leaves
   * every test green. It was measured.
   *
   * The clear is here for what changes underneath it. A claim already outlives
   * its own turn (a late answer holds it while the collector parks the next
   * message behind it, RP8), and the day something delivers twice under one claim
   * a standing mark would swallow an answer nobody had spoken for — silently, in
   * somebody else's room. Binding the mark to one delivery makes that impossible
   * structurally, instead of by an argument about claim lifetimes that the next
   * change to this file could quietly invalidate.
   *
   * What IS observable, and what the tests pin, is the mark's scope: it is per
   * `(room, agent)`, so a post into another room suppresses nothing here, and a
   * fresh claim starts unmarked, so the next turn's answer always lands.
   *
   * @param roomId - The room the answer is being delivered into.
   * @param authorId - The agent delivering it.
   * @returns `true` when this delivery has already been made by hand.
   */
  private takeSpokeViaTool(roomId: string, authorId: string): boolean {
    const claim = this.claimed.get(agentKey(roomId, authorId));
    if (claim?.spokeViaTool !== true) return false;
    claim.spokeViaTool = false;
    return true;
  }

  /**
   * Run one agent's turn and post whatever it said back into the room, inside
   * that dispatch's correlation scope.
   *
   * The scope wraps the whole turn rather than any part of it: the claim, the
   * runtime call, the reply post, the notices and the release all belong to one
   * dispatch, and every line any of them writes should say so without being
   * edited to. A late answer is covered too, and for free: `deliverLate`
   * registers its continuations from inside this scope, so an answer that lands
   * an hour later still writes lines carrying the id of the message it answers.
   *
   * @param room - The room the entry landed in.
   * @param entry - The entry being answered.
   * @param target - The agent answering it, carrying its own dispatch id.
   */
  private runOne(room: Room, entry: RoomEntry, target: TriggerTarget): Promise<void> {
    return runInDispatch({ dispatchId: target.dispatchId, origin: 'room', entryId: entry.id }, () =>
      this.runOneInDispatch(room, entry, target)
    );
  }

  /** The body of {@link RoomTriggerDispatcher.runOne}, already inside its scope. */
  private async runOneInDispatch(
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
      // Built before the request so the context and the projection plan it
      // implies are one value, resolved once.
      const turnContext = buildRoomContext(this.deps, {
        room,
        agentAuthorId: target.authorId,
        // The tree the turn below runs in, so a file the context names is named
        // by a path that opens from where the agent actually stands (DOR-1266).
        // The same value reaches the runner as `agentPath` a few lines down.
        agentPath: target.agentPath,
        entry,
        working: this.workingIn(room.id),
        // The cursor as it stood before the claim moved it. The stored row has
        // already advanced past this entry, so reading it here would describe
        // an empty window every time (room-participation spec §8.3).
        lastReadSeq: target.lastReadSeq,
        // Both halves of what is left to spend, resolved together so they can
        // never disagree about whether anything is counting.
        ...this.headroomFor(room.id, target.depth),
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
      const result = await this.deps.runner.run({
        room,
        authorId: target.authorId,
        agentPath: target.agentPath,
        sessionId: target.sessionId,
        entry,
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
          this.notices.reportWaiting(
            room,
            entry,
            { authorId: target.authorId, displayName: target.displayName },
            waiting
          ),
        // What the turn is doing, for the room's live lane (DOR-1351). Keyed on
        // the claim rather than the frame, so a reading that arrives after this
        // scope is gone reaches nothing rather than a stale object.
        onActivity: (activity) => this.noteActivity(agentKey(room.id, target.authorId), activity),
      });

      // A REFUSAL IS NOT A READING. The claim moved this agent's cursor to the
      // triggering entry on the assumption that the turn would be SHOWN what sits
      // behind it — but `busy` is the runner declining before any model ran, so
      // nothing was shown and nothing was read. Left forward, the whole backlog
      // is permanently invisible, and the notice this outcome writes ("send it
      // again when Ana is free") invites a message that would land ABOVE the
      // advanced cursor and arrive with no context at all.
      if (result.unanswered === 'busy') this.rewindClaimCursor(room, entry, target);

      // The turn ran on a session; that session is the one this agent must
      // resume here next time. It is not always the one the room asked with —
      // Claude Code assigns its own id on the first turn and files the
      // transcript under it — so the binding follows the runner's answer rather
      // than the id minted before the turn. Written before anything is
      // delivered: a post that throws must not cost the room its memory.
      if (result.sessionId !== target.sessionId) {
        this.deps.store.rebindRoomSession(room.id, target.authorId, result.sessionId);
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
      if (this.wasHalted(target.dispatchId)) {
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
        this.deliverLate({
          room,
          entry,
          target,
          sessionId: result.sessionId,
          late: result.late,
        });
        // Marked only AFTER the release above is armed, and the order is the
        // whole safety of it: the `finally` below reads this flag to decide
        // whether the turn is still running, so a claim marked before
        // `deliverLate` had attached its handlers would be held by a promise
        // chain that never existed and released by nothing.
        const claim = this.claimed.get(key);
        if (claim) {
          claim.pastDeadline = true;
          // The deadline's only announcement. It is deliberately not a notice:
          // a durable line about every slow turn is a second message about every
          // slow turn, and the late answer already says how long it took
          // (room-presence spec §18). Published once here; every republish from
          // now on carries `working_late` because it reads the same flag.
          this.publishPresence(claim, 'working_late');
        }
      } else {
        outcome = this.deliver({ room, entry, target, reply: result, sessionId: result.sessionId });
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
      this.rewindClaimCursor(room, entry, target);
      // The failure detail belongs on the agent's own session stream, where the
      // turn machinery already surfaces it — a room log is no place for a stack
      // trace. But the FACT belongs here: a turn that threw and said nothing is
      // indistinguishable from an agent that ignored you (DOR-621).
      logger.warn('[rooms] triggered turn failed', {
        roomId: room.id,
        authorId: target.authorId,
        error: err instanceof Error ? err.message : String(err),
      });
      // A turn that threw because somebody stopped it did what it was told. The
      // `halted` notice is already on the log and is the whole story; an
      // apology under it would be the room reporting the person's own control
      // action back to them as a fault.
      if (this.wasHalted(target.dispatchId)) outcome = 'halted';
      else this.notices.reportSilence(room, entry, target, 'failed', target.dispatchId);
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
      if (this.claimed.get(key)?.pastDeadline !== true) {
        this.releaseOwnClaim(key, target.dispatchId, outcome);
      }
      // **Unconditional, and safe even for a turn `deliverLate` still owes an
      // answer.** A dispatch can only be MARKED while its claim is held, and a
      // late turn's claim outlives this frame — so at this line a turn that
      // went late is provably unmarked and this deletes nothing, while the halt
      // that marks it later is followed by `deliverLate`'s own cleanup. A turn
      // marked before it went late never reaches here at all: the halted branch
      // above declines to arm the late delivery.
      this.forgetHalt(target.dispatchId);
    }
  }

  /**
   * Put one turn's outcome into the room: the answer, or why there is none.
   *
   * Only ever called with a SETTLED turn — never with the `{ text: null, late }`
   * a runner returns at the wait deadline, which carries no outcome at all and
   * whose recovery-clearing branch would then fire for an agent that has not
   * answered anything (see {@link RoomTriggerDispatcher.runOne}).
   *
   * @param opts.reply - What the turn produced, from the runner.
   * @param opts.sessionId - The session it ran on, carried onto the post.
   * @param opts.late - Set on a late answer, so the post can say which message
   *   it is answering and how long it took.
   * @returns What happened, for the claim release to report.
   */
  private deliver(opts: {
    room: Room;
    entry: RoomEntry;
    target: TriggerTarget;
    reply: RoomTurnReply;
    sessionId: string;
    late?: { waitedMs: number };
  }): ClaimOutcome {
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
    if (this.wasHalted(target.dispatchId)) {
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
    if (reply.unanswered) {
      this.notices.reportSilence(room, entry, target, reply.unanswered, target.dispatchId);
      return reply.unanswered;
    }

    // The turn ran and nothing refused it, so whatever was blocking this agent
    // here is over. Recovery IS the re-arm: the next time it cannot answer, the
    // room says so again — for every reason, because an answer landing is
    // evidence against all of them at once.
    this.notices.recovered(room.id, target.authorId);

    const said = reply.text?.trim();
    // An agent with nothing to say is exercising judgment, not failing. Only a
    // named `unanswered` above earns a notice.
    //
    // This is the ONE release with nothing durable beside it, and it is a choice
    // rather than an oversight (room-presence spec §4.3): the person saw an
    // indicator appear and vanish with no line to show for it. The alternatives
    // are both worse — a "had nothing to say" entry on every ambient turn is the
    // over-participation this whole file damps, and suppressing the indicator for
    // turns that MIGHT end silent would mean knowing the future. `room-presence-
    // claims.test.ts` pins it as chosen behaviour so it cannot be closed by
    // accident.
    if (!said) return 'quiet';
    // **The agent already spoke here, on purpose.** `post_to_room` put its words
    // in front of the reader mid-turn; what is left in `said` is the narration it
    // wrote back to its own session, which belongs to whoever is watching THAT.
    // Posting it as well gives the room two messages for one thought — the
    // "I posted the deploy note" that follows the deploy note. The obligation to
    // be visible is discharged either way, which is what makes this a suppression
    // rather than a silence: there is a durable entry beside this release.
    // Taken rather than read, so it covers this delivery and no other — see
    // {@link RoomTriggerDispatcher.takeSpokeViaTool}.
    if (this.takeSpokeViaTool(room.id, target.authorId)) return 'answered';
    if (opts.late !== undefined) {
      logger.info('[rooms] a late answer landed and was posted', {
        roomId: room.id,
        authorId: target.authorId,
        entryId: entry.id,
        waitedMs: opts.late.waitedMs,
      });
    }
    const text =
      opts.late === undefined
        ? said
        : withLateAnswerNote(said, { waitedMs: opts.late.waitedMs, question: entry.body.text });
    // **A late answer is posted like any other, and it addresses people like any
    // other.** It was briefly written with the dispatch suppressed, on the theory
    // that a reply to an already-dispatched question must not open a second hop.
    // That over-corrected: the spam it was aimed at came from the QUOTE in the
    // prefix re-resolving the original question's handles, which
    // `withLateAnswerNote` now neutralizes at the source. What suppression also
    // dropped was the agent's own words — a genuine "@bo can you take this?"
    // reached nobody, silently, which is the one thing this file is not allowed
    // to do. The cascade guard bounds what follows, the way it bounds every
    // other hop.
    this.deps.writer.post(room.id, {
      authorId: target.authorId,
      text,
      sessionId: opts.sessionId,
      // The dispatch is passed rather than looked up, as defence in depth. The
      // worry is a late answer, whose claim has been held for minutes: if this
      // `(room, agent)` key could be handed to another turn while it waited,
      // reading the key here would stamp this answer with somebody else's turn.
      // Traced, and today it cannot — a halt marks the turn and `releaseOwnClaim`
      // refuses a release from a dispatch that is not the holder, so nothing
      // re-keys under a live claim. Passing the id keeps the stamp right if that
      // guard ever moves, and costs one field to do it.
      trigger: { root: entry.cascadeRoot, depth: target.depth, dispatchId: target.dispatchId },
      // Answer where you were asked. `threadRootEntryId` is already a validated
      // top-level entry — every reply carries the root, never another reply —
      // so re-resolving it in `post` cannot refuse this write.
      replyTo: entry.threadRootEntryId ?? undefined,
      // **Unconditionally, in-frame answers included.** A room posts in arrival
      // order, so an answer is not always next to its question — and holding a
      // message behind another room's turn makes that common rather than rare.
      // The client decides whether to DRAW the pointer (it does not, when the
      // answered entry is the one immediately above); the server just records
      // which message this is about, because it is the only thing that knows.
      answersEntryId: entry.id,
    });
    return 'answered';
  }

  /**
   * Post an answer the room stopped waiting for, once it lands — and release
   * the claim that has been saying, all along, that the agent is still on it.
   *
   * The turn was never cancelled, so this is the answer to a real question that
   * a real person asked — it goes in, saying how long it took. The claim on
   * `(room, agent)` is still held when this runs (see
   * {@link RoomTriggerDispatcher.runOne}'s `finally`), which is what makes the
   * late window honest rather than a hole; the cascade stamp is passed
   * explicitly regardless, so the guard sees the hop either way.
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
  private deliverLate(opts: {
    room: Room;
    entry: RoomEntry;
    target: TriggerTarget;
    sessionId: string;
    late: Promise<LateRoomReply>;
  }): void {
    const key = agentKey(opts.room.id, opts.target.authorId);
    this.inFlight += 1;
    let outcome: ClaimOutcome = 'quiet';
    void opts.late
      .then((reply) => {
        outcome = this.deliver({
          room: opts.room,
          entry: opts.entry,
          target: opts.target,
          reply,
          sessionId: opts.sessionId,
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
        this.notices.reportSilence(
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
        this.releaseOwnClaim(key, opts.target.dispatchId, outcome);
        // The last delivery this turn had, so the halt mark ends here.
        this.forgetHalt(opts.target.dispatchId);
        this.settleOne();
      });
  }

  /**
   * Ask one agent something the room never posted, and hand back what it said —
   * the welcome-back offer's only way in (DOR-1046, spec `team-room-home` D5.2).
   *
   * **Everything that bounds a triggered turn bounds this one**, which is the
   * whole reason it lives here rather than beside the greeter: the `(room,
   * agent)` session binding, both busy ceilings (one transcript per room, one
   * working tree per agent), the room's automatic-turn budget, and the claim
   * that makes the work visible. A second path that reached the runner without
   * them would be an agent running two turns in one checkout, which is the
   * contention DOR-500 measured.
   *
   * **Every refusal is SILENT, and that is a departure worth stating.** A
   * refusal is normally visible (`.claude/rules/room-conduct.md`) because a
   * dropped trigger is indistinguishable from a broken agent, and the person who
   * notices is the one who asked. Nobody asked for this. An offer is an extra a
   * person switched on, so a busy agent, an exhausted budget, a failed turn and
   * an agent with nothing to offer all produce nothing at all — the same
   * reasoning that lets the fallback seat stand down without announcing it. What
   * a person is owed is the status line, and that has already been posted by the
   * time this runs. The exception is written down in full where the rule lives.
   *
   * **A wait is the one thing it does say out loud**, because a wait is not an
   * outcome: this method holds a claim, so the room is showing the agent
   * working, and a turn parked on a tool approval would leave that indicator
   * standing with nothing to explain it. The ordinary `awaiting_approval` notice
   * covers it, damped per turn like every other.
   *
   * **A slow offer is late, never lost.** The room's wait is a bound on the WAIT
   * and never on the turn, so an answer that outruns it is waited out — to
   * `rooms.lateReplyCeilingMinutes`, which is what bounds "late" — and handed
   * back then. Dropping it would contradict the busy notice's own promise that
   * the answer lands here, and would release the working indicator into nothing.
   *
   * **The answer is not posted here.** It is handed back so the greeter can post
   * it the way it posts a status line — un-provenanced, which is what makes
   * `deriveCascade` stamp it AT the ceiling and the fallback seat stand down for
   * it. Posting it from inside this method would give it THIS turn's cascade
   * root instead, and a stamp at the ceiling under a root that is not its own
   * entry is the exact shape that sprays a `cascade_depth` notice at every
   * room-mate. The residual cost is one line wide and is documented with the
   * rule: the claim releases a tick before the greeter's post, so a post the
   * room then refuses leaves a release with nothing durable beside it.
   *
   * @param input.room - The room the offer would be made in.
   * @param input.entry - The entry it is ABOUT — the status line this agent just
   *   posted. It frames the turn's context and names the working indicator.
   * @param input.authorId - The agent being asked.
   * @param input.prompt - The question, as the model will see it.
   * @returns What the agent said, or `null` for every kind of silence.
   */
  async askAside(input: {
    room: Room;
    entry: RoomEntry;
    authorId: string;
    prompt: string;
  }): Promise<string | null> {
    const { room, entry, authorId } = input;
    const record = this.deps.authors.getMany([authorId]).get(authorId);
    // Only an agent takes a turn, and only a live one: a directory that no
    // longer holds this agent has nothing to offer and no session to offer it
    // on (ADR 260801-003051).
    if (!record || record.kind !== 'agent') return null;
    if (!isLiveAuthor(record, this.deps.agents)) return null;
    // It posted its status line a moment ago, so this is all but guaranteed —
    // and it costs one indexed read to not spend a model turn on the case where
    // it left the room in between.
    if (!this.deps.store.getMember(room.id, authorId)) return null;
    const agentPath = record.naturalKey;

    const busyWith = this.busyWith(room.id, authorId, agentPath);
    if (busyWith !== null) {
      logger.debug('[rooms] skipped a welcome-back offer: the agent is already working', {
        roomId: room.id,
        authorId,
        // The ceiling only — never the blocking claim, which carries an
        // `agentPath`, and a filesystem path does not belong in a log context.
        busyWith: busyWith.where,
      });
      return null;
    }
    // Charged through the same seam `claimCollected` uses, which is what keeps
    // an offer from being the one path that spends without counting: with every
    // cap off the budget allows it and charges nothing, and there is then no
    // window to re-arm.
    const afford = this.deps.budget.tryReserve(room.id);
    if (!afford.allowed) {
      logger.debug('[rooms] skipped a welcome-back offer: the room is out of automatic turns', {
        roomId: room.id,
        authorId,
      });
      return null;
    }
    // **The re-arm, exactly as `claimCollected` does it, and it is not optional
    // here.** Spending again means the hourly window moved, so the next
    // exhaustion is news rather than a repeat. Without this line an offer
    // silently consumes the freshly-rolled window and leaves the memory of the
    // LAST refusal standing — so the next person to be refused is refused with
    // no notice at all. An invisible refusal of a message somebody addressed is
    // the shape `.claude/rules/room-conduct.md` forbids, and an offer nobody
    // asked for must not be the thing that causes it.
    if (afford.counted) this.notices.budgetRecovered(room.id);

    let sessionId: string;
    try {
      // The room's own session for this agent, exactly as a trigger binds it —
      // an offer is part of the same conversation, not a thread of its own.
      sessionId = this.deps.store.bindRoomSession(
        room.id,
        authorId,
        this.deps.store.getRoomSession(room.id, authorId) ?? randomUUID(),
        new Date().toISOString()
      );
    } catch (err) {
      logger.warn('[rooms] could not bind a session for a welcome-back offer', {
        roomId: room.id,
        authorId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    const dispatchId = newDispatchId();
    const key = agentKey(room.id, authorId);
    this.holdClaim({
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
      depth: this.deps.limitsFor(room.id).maxAgentDepth,
      // Nothing in the room asked for this turn, so it has no cascade to hand
      // to a post the agent makes while it runs. See {@link ActiveClaim.aside}.
      aside: true,
      spokeViaTool: false,
      claimedAt: new Date().toISOString(),
      pastDeadline: false,
      // Zero rather than `Date.now()`: the turn's FIRST tool call should reach
      // the room immediately, and a floor set at claim time would hold it back
      // for up to one throttle window.
      activityPublishedAt: 0,
    });
    return runInDispatch({ dispatchId, origin: 'room', entryId: entry.id }, () =>
      this.runAsideInDispatch({
        room,
        entry,
        authorId,
        agentPath,
        sessionId,
        key,
        dispatchId,
        prompt: input.prompt,
      })
    );
  }

  /** The body of {@link RoomTriggerDispatcher.askAside}, already inside its scope. */
  private async runAsideInDispatch(input: {
    room: Room;
    entry: RoomEntry;
    authorId: string;
    agentPath: string;
    sessionId: string;
    key: string;
    dispatchId: string;
    prompt: string;
  }): Promise<string | null> {
    const { room, entry, authorId, key } = input;
    const displayName =
      this.deps.authors.getMany([authorId]).get(authorId)?.displayName ?? 'An agent';
    let outcome: ClaimOutcome = 'quiet';
    recordDispatchStart({
      dispatchId: input.dispatchId,
      origin: 'room',
      roomId: room.id,
      sessionId: input.sessionId,
    });
    try {
      const turnContext = buildRoomContext(this.deps, {
        room,
        agentAuthorId: authorId,
        agentPath: input.agentPath,
        entry,
        working: this.workingIn(room.id),
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
        ...this.headroomFor(room.id, 'ceiling'),
        engaged: null,
        // The same word the claim above uses. Nothing asked for this turn, so
        // the block names no "message you are answering": `entry` here is the
        // greeter's own status post, and pointing the agent at it would point it
        // at a line written about itself (DOR-1263).
        aside: true,
      });
      const result = await this.deps.runner.run({
        room,
        authorId,
        agentPath: input.agentPath,
        sessionId: input.sessionId,
        entry,
        prompt: input.prompt,
        roomContext: turnContext.context,
        attachmentProjection: turnContext.projection,
        onWaiting: (waiting) =>
          this.notices.reportWaiting(room, entry, { authorId, displayName }, waiting),
        // An aside turn holds a real claim in a real checkout, so it reports
        // what it is doing like any other turn.
        onActivity: (activity) => this.noteActivity(key, activity),
      });
      if (result.sessionId !== input.sessionId) {
        this.deps.store.rebindRoomSession(room.id, authorId, result.sessionId);
      }
      // **An offer somebody stopped is not made**, and this is asked BEFORE the
      // late wait for the same reason `runOne` asks before arming `deliverLate`:
      // an offer nobody will hear must not hold a claim, and an agent reading as
      // working, for the up-to-an-hour the ceiling allows. The aside path is
      // silent about every other refusal already, and this one has a durable
      // line of its own — the room's `halted` notice, written when Stop was
      // pressed.
      if (this.wasHalted(input.dispatchId)) {
        outcome = 'halted';
        // Resolve-or-reject is the runner's contract; the room has simply
        // stopped listening. Same treatment as `runOne`'s halted branch.
        result.late?.catch(() => undefined);
        return null;
      }
      // **A slow turn is late, never lost** (`.claude/rules/room-conduct.md`).
      // The room's wait bounds the WAIT; the turn keeps running, and
      // `rooms.lateReplyCeilingMinutes` is what bounds how late "late" can be —
      // so the answer is waited out here and posted when it lands, rather than
      // dropped on the floor while the busy notice elsewhere promises the
      // opposite. The claim is held throughout, because the agent really is
      // still working in its own checkout, and released by the `finally` below
      // once this has an answer to hand back.
      const settled = result.late === undefined ? result : await this.awaitLate(result.late, key);
      // Asked AGAIN, over the other window. The check above cannot see a Stop
      // pressed DURING the wait, which is the longest window this method has —
      // and the triggered path answers that same window from inside `deliver`,
      // which an aside does not use because its answer goes back to the greeter
      // rather than into the room.
      if (this.wasHalted(input.dispatchId)) {
        outcome = 'halted';
        return null;
      }
      if (settled.unanswered) {
        outcome = settled.unanswered;
        return null;
      }
      const said = settled.text?.trim();
      if (!said) return null;
      // The same suppression the triggered path applies, for the same reason: an
      // aside turn that reached for `post_to_room` has already put its words in
      // front of the reader, and handing `said` back would have the greeter post
      // the narration of that post a tick later. The claim is still held here —
      // the `finally` below is what releases it — so the mark is still readable,
      // and taking it keeps it bound to this one delivery.
      if (this.takeSpokeViaTool(room.id, authorId)) {
        outcome = 'answered';
        return null;
      }
      outcome = 'answered';
      return said;
    } catch (err) {
      outcome = 'failed';
      logger.warn('[rooms] a welcome-back offer turn failed', {
        roomId: room.id,
        authorId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      // Always, and last. An aside turn releases into the offer the greeter
      // posts a tick later, or into the named exception every turn has — an
      // agent that ran and chose to say nothing. The one hole left is a greeter
      // post that THROWS after this release; it is logged there
      // (`welcome-back/greeter.ts`) and written down as an exception in
      // `.claude/rules/room-conduct.md`, because a rule with an undocumented
      // exception is a rule somebody re-derives from scratch.
      //
      // Guarded by dispatch like both triggered releases: an aside waits out its
      // own late answer, so a Stop and a fresh message can hand this key to a
      // real turn while it is still waiting.
      this.releaseOwnClaim(key, input.dispatchId, outcome);
      // An aside waits out its own late answer inline, so this frame is always
      // the turn's last one and the halt mark always ends here.
      this.forgetHalt(input.dispatchId);
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
  private async awaitLate(late: Promise<LateRoomReply>, key: string): Promise<RoomTurnReply> {
    const claim = this.claimed.get(key);
    if (claim) {
      claim.pastDeadline = true;
      this.publishPresence(claim, 'working_late');
    }
    try {
      return await late;
    } catch (err) {
      logger.warn('[rooms] a late welcome-back offer never landed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { text: null, unanswered: 'failed' };
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
  private rewindClaimCursor(room: Room, entry: RoomEntry, target: TriggerTarget): void {
    this.deps.store.rewindReadCursor(room.id, target.authorId, {
      from: entry.seq,
      to: target.lastReadSeq,
    });
  }

  /**
   * Whether Stop reached this turn — so its answer belongs nowhere.
   *
   * A READ, never a take: the two paths that ask are the in-frame delivery and
   * the late one, and only one of them ever runs for a given turn, but which one
   * is not known until the turn settles. The mark is dropped by
   * {@link RoomTriggerDispatcher.forgetHalt} at the turn's real terminal
   * instead.
   *
   * @param dispatchId - The turn being delivered.
   * @returns Whether a halt stopped it.
   */
  private wasHalted(dispatchId: string): boolean {
    return this.haltedTurns.has(dispatchId);
  }

  /**
   * Forget that a turn was halted, once nothing can deliver it any more.
   *
   * Called from every frame that owns a turn's last delivery — never from
   * `deliver` itself, which cannot tell whether a late delivery is still to
   * come. Forgetting a mark nobody set is a no-op, which is the ordinary case:
   * almost no turn is ever halted.
   *
   * @param dispatchId - The turn that has finished, however it finished.
   */
  private forgetHalt(dispatchId: string): void {
    this.haltedTurns.delete(dispatchId);
  }

  /**
   * Say, in the log, that a Stop found no turn to stop (DOR-1425).
   *
   * Both halt scopes report through this one method so the sentence and its
   * fields cannot drift. It is a LOG line and not a room notice on purpose: the
   * `halted` line is already written, the claim is dropped either way, and a
   * second line saying the machinery could not reach a process is plumbing
   * aimed at whoever reads logs rather than at whoever pressed Stop.
   *
   * @param roomId - The room the stop was pressed in.
   * @param claim - The turn it was aimed at.
   * @param sessionId - The session the interrupt was sent to.
   */
  private reportUnreachedStop(roomId: string, claim: ActiveClaim, sessionId: string): void {
    logger.warn('[rooms] a stop found no turn to stop — it may still be starting', {
      roomId,
      authorId: claim.authorId,
      dispatchId: claim.dispatchId,
      sessionId,
    });
  }

  /**
   * Whether Stop is still standing over this agent in this room — so a post it
   * makes for itself belongs nowhere either (DOR-1313).
   *
   * The counterpart to {@link RoomTriggerDispatcher.wasHalted}, asked by
   * `post_to_room` rather than by a delivery: the mark that path could use is
   * keyed by dispatch, and a tool call arrives on its own request with no
   * dispatch in sight. See {@link RoomTriggerDispatcher.stoppedHere} for why the
   * two exist side by side and what clears this one.
   *
   * @param roomId - The room being posted into.
   * @param authorId - The agent posting.
   * @returns Whether that agent's last turn here was stopped and it has not been
   *   given another one since.
   */
  stoppedIn(roomId: string, authorId: string): boolean {
    return this.stoppedHere.has(agentKey(roomId, authorId));
  }

  /**
   * Take a claim, and tell the room the agent is on it.
   *
   * The publish is not a courtesy beside the write — it is the write's whole
   * point. `presence is the claim map, made visible` (room-presence spec), so
   * every path that takes a claim goes through here and there is nowhere else a
   * `working` can come from.
   *
   * The `set` cannot silently evict a live claim, which is why nothing here has
   * to release one: {@link RoomTriggerDispatcher.claimTargets} refuses any agent
   * {@link RoomTriggerDispatcher.busyIn} already reports as working here, so
   * nothing reaches this line under a key that is taken.
   *
   * @param claim - The claim being taken, already fully resolved.
   */
  private holdClaim(claim: ActiveClaim): void {
    // `dispatchId` is passed explicitly on both claim lines, and that is not
    // belt-and-braces: a claim is TAKEN synchronously inside `RoomService.post`,
    // before `runOne` enters the dispatch scope, and RELEASED from `halt()` on
    // a path with no scope at all. The reporter's ambient read cannot see either.
    logger.info('[rooms] an agent took a room turn', {
      roomId: claim.roomId,
      authorId: claim.authorId,
      entryId: claim.entryId,
      dispatchId: claim.dispatchId,
      cascadeRoot: claim.cascadeRoot,
    });
    // Something is happening here again, so a halt is news again — for the room
    // and for this agent, which are two different statements damped separately.
    this.notices.workStarted(claim.roomId, claim.authorId);
    const before = this.workingCount(claim.roomId);
    const key = agentKey(claim.roomId, claim.authorId);
    // The room is asking this agent again, so whatever Stop was standing over it
    // HERE comes down — including its hand on `post_to_room`. Stop ends a turn;
    // it never changes a setting (`.claude/rules/room-conduct.md`).
    this.stoppedHere.delete(key);
    // **Before the `working` publish, so the held line RESOLVES into the working
    // one rather than sitting beside it.** A person watching this room asked a
    // question, was told it was waiting, and is now being told it is running:
    // that is one indicator changing its mind, not two indicators about one
    // message. Published in this order, the `done` for the hold lands first and
    // the client's store never holds both.
    this.releaseHold(key, 'started');
    this.claimed.set(key, claim);
    this.publishPresence(claim, 'working');
    this.publishWorkingCount(claim.roomId, before);
    if (this.republishing === null) {
      this.republishing = setInterval(() => this.republishPresence(), PRESENCE_REPUBLISH_MS);
      // A heartbeat is not a reason for the process to stay alive: an unref'd
      // interval lets a CLI that has finished exit while a room still holds a
      // claim, instead of hanging for ten seconds at a time on a timer whose
      // only job is to repaint a screen nobody is watching. Optional-called like
      // its sibling in `room-turn-runner.ts`, which does not assume a Node timer.
      this.republishing.unref?.();
    }
  }

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
  private releaseOwnClaim(key: string, dispatchId: string, outcome: ClaimOutcome): void {
    const held = this.claimed.get(key);
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
    this.releaseClaim(key, outcome);
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
  private releaseClaim(key: string, outcome: ClaimOutcome): void {
    const claim = this.claimed.get(key);
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
    this.notices.turnEnded(claim.roomId, claim.authorId);
    const before = this.workingCount(claim.roomId);
    this.claimed.delete(key);
    // Before the `done`, in the same block that stops the republish timer: an
    // armed trailing publish for a claim nobody holds is a `working` frame
    // landing AFTER the `done` that retired it, which is a lane that never
    // clears. `halt` releases through this seam and inherits it.
    this.disarmActivityFlush(claim);
    // And the `done` itself carries no reading. A turn that has ended is not
    // doing anything, which is what `RoomSignalEvent.activity` promises — and a
    // halt reaches here without the runner ever having cleared.
    claim.activity = undefined;
    this.publishPresence(claim, 'done');
    this.publishWorkingCount(claim.roomId, before);
    if (this.republishing !== null && this.claimed.size === 0) {
      clearInterval(this.republishing);
      this.republishing = null;
    }
    // **The steer's other half, and it belongs exactly here** (RP8). Whatever
    // this agent was asked while it was working has been held rather than
    // refused, and this is the moment it can be answered. Hung off the one place
    // every claim is released — the ordinary terminal, a late answer settling,
    // and a halt all reach it — so there is no path that can forget to look. A
    // halt has already dropped the room's collections by the time it gets here,
    // which is why stopping a room does not answer the messages it was stopped
    // over.
    this.collector.resume(claim.roomId, claim.authorId);
    // **And the cross-room half of it** (spec `room-hold-when-busy`). One agent
    // is one working directory, so the rooms this agent was asked something in
    // while it worked here have been waiting rather than being refused, and this
    // is the moment they can run. Hung off the same one seam for the same reason:
    // the ordinary terminal, a late answer settling, a failure and a halt all
    // reach it, so a held message runs however the blocking turn ended.
    this.resumeElsewhere(claim.agentPath);
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
  private noteActivity(key: string, activity: SessionActivity | null): void {
    const claim = this.claimed.get(key);
    // Released, halted, or never taken. A turn that outlives its claim says
    // nothing: there is no indicator left for this to be about.
    if (claim === undefined) return;

    if (activity === null) {
      if (claim.activity === undefined) return;
      claim.activity = undefined;
      this.disarmActivityFlush(claim);
      this.publishActivityNow(claim);
      return;
    }

    if (sameActivity(claim.activity, activity)) return;

    claim.activity = activity;
    const waited = Date.now() - claim.activityPublishedAt;
    if (waited >= ACTIVITY_FANOUT_THROTTLE_MS) {
      this.disarmActivityFlush(claim);
      this.publishActivityNow(claim);
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
      this.publishActivityNow(claim);
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
  private publishActivityNow(claim: ActiveClaim): void {
    this.publishPresence(claim, claim.pastDeadline ? 'working_late' : 'working');
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
  private disarmActivityFlush(claim: ActiveClaim): void {
    if (claim.activityFlush === undefined) return;
    clearTimeout(claim.activityFlush);
    claim.activityFlush = undefined;
  }

  /**
   * Record that this room's message is waiting behind a turn somewhere else, and
   * put that on the room's stream.
   *
   * **Idempotent, and the two fields it keeps are why.** An existing hold keeps
   * its `since` — the lane counts up from when the person's message actually
   * started waiting, not from the last time something re-checked — and its
   * `entryId`, because the indicator is keyed on that and a moving id would open
   * a second indicator every time the person typed again. Only `behindRoomId`
   * is re-pointed, because the room in the way genuinely changes as claims come
   * and go.
   *
   * @param roomId - The room whose message is waiting.
   * @param authorId - The agent it is waiting for.
   * @param agentPath - That agent's directory — the ceiling being waited on.
   * @param entryId - The message to key a NEW hold on. Ignored when one exists.
   * @param busy - What is in the way, from the live claim map.
   */
  private noteHold(
    roomId: string,
    authorId: string,
    agentPath: string,
    entryId: string,
    busy: ClaimBusy
  ): void {
    const key = agentKey(roomId, authorId);
    const open = this.held.get(key);
    const record: HeldRecord =
      open === undefined
        ? {
            roomId,
            authorId,
            agentPath,
            entryId,
            since: new Date().toISOString(),
            behindRoomId: busy.blocking.roomId,
          }
        : { ...open, behindRoomId: busy.blocking.roomId };
    this.held.set(key, record);
    this.publishHold(record, 'held');
    // A NEW wait changes what every other waiting room can say: `othersWaiting`
    // is the only thing that decides whether "Answer here first" is offered, and
    // it has just become true for all of them. Restated now rather than left to
    // the ten-second republish, because a control that appears seconds after the
    // fact reads as the room having thought about it.
    if (open === undefined) this.restateSiblingHolds(record);
  }

  /**
   * Re-state every OTHER room waiting on the same agent.
   *
   * `heldBehind.othersWaiting` is a fact about the set of waits rather than about
   * any one of them, so it goes stale in every other room the moment this one
   * starts or stops waiting. The republish tick would fix it within ten seconds;
   * a person watching would see "Answer here first" appear, or linger after it
   * had stopped meaning anything, for that whole window.
   *
   * @param record - The hold that just opened or closed. Its own room is skipped
   *   — it has either just been published or just been cleared.
   */
  private restateSiblingHolds(record: HeldRecord): void {
    for (const other of this.held.values()) {
      if (other.agentPath !== record.agentPath || other.roomId === record.roomId) continue;
      this.publishHold(other, 'held');
    }
  }

  /**
   * Drop a hold and publish `done` for it.
   *
   * **Called from every path that ends a collection without taking a claim**, so
   * "no hold is ever left standing" is structural rather than remembered — the
   * same shape {@link RoomTriggerDispatcher.releaseClaim} gives claims. Releasing
   * a key that holds nothing is a no-op, because most collections never had one.
   *
   * **It writes no notice, whatever the reason**, and each reason has a durable
   * sibling written by the path that caused it: `started` is the turn itself,
   * `halted` is the room-wide `halted` line, `refused` is the guard's or the
   * budget's own notice, and `expired` is the one `agent_busy` line
   * {@link RoomTriggerDispatcher.expireHolds} writes — there, because only there
   * is the dropped collection in hand to write it about.
   *
   * @param key - The `(room, agent)` key whose hold is ending.
   * @param reason - How it ended, for the log. Never rendered.
   */
  private releaseHold(key: string, reason: HoldEnd): void {
    const record = this.held.get(key);
    if (record === undefined) return;
    this.held.delete(key);
    logger.info('[rooms] a message that was waiting on a busy agent stopped waiting', {
      roomId: record.roomId,
      authorId: record.authorId,
      entryId: record.entryId,
      behindRoomId: record.behindRoomId,
      heldMs: Math.max(0, Date.now() - Date.parse(record.since)),
      reason,
    });
    this.publishHold(record, 'done');
    // And the other side of it: one wait fewer can take "Answer here first" away
    // from every room that is still waiting, which it should, because there may
    // now be nothing to be answered ahead of.
    this.restateSiblingHolds(record);
  }

  /**
   * Re-arm every held collection for one agent, and re-point the ones that are
   * still blocked.
   *
   * Two halves, and the second is what keeps the lane honest. Re-arming is the
   * cross-room `resume`. Re-pointing is for the collections that will find
   * ANOTHER claim in the way when they reach `claimCollected` a macrotask later:
   * their indicator has to name the room that is in the way now, not the one
   * that just finished. A hold with nothing left in its way is left alone — the
   * turn it is waiting for is about to start, and `holdClaim` resolves it then.
   *
   * @param agentPath - The working directory whose claim just released.
   */
  private resumeElsewhere(agentPath: string): void {
    this.collector.resumeAgent(agentPath);
    for (const record of this.held.values()) {
      if (record.agentPath !== agentPath) continue;
      const busy = this.busyWith(record.roomId, record.authorId, record.agentPath);
      if (busy === null) continue;
      record.behindRoomId = busy.blocking.roomId;
      this.publishHold(record, 'held');
    }
  }

  /**
   * Give up on the holds that have waited longer than the room's late ceiling,
   * and say so once each.
   *
   * **The bound exists to stop a chain, not to hurry anybody.** A blocks B and B
   * blocks C is a wait with no natural end, and a lane that says "it will pick
   * this up" for an hour has stopped being a promise and become furniture.
   * `rooms.lateReplyCeilingMinutes` is reused rather than a new setting invented:
   * it already means "when the room stops listening", which is this same fact at
   * a different grain.
   *
   * The notice is written HERE rather than in `releaseHold`, because only here is
   * the dropped collection in hand — a notice has to be about a message somebody
   * actually sent, and the newest one in the batch is the one they are waiting on.
   */
  private expireHolds(): void {
    const ceiling = this.deps.holdCeilingMs();
    const now = Date.now();
    for (const [key, record] of [...this.held]) {
      if (now - Date.parse(record.since) < ceiling) continue;
      // A list, because one key can hold both a cap-closed batch and the fresh
      // collection behind it — see {@link RoomCollector.dropOne}. The NEWEST of
      // them is what the notice is about, and every one of them owes a credit.
      const dropped = this.collector.dropOne(record.roomId, record.authorId);
      this.releaseHold(key, 'expired');
      const last = dropped.at(-1);
      // One credit back per collection, exactly as a halt returns them.
      for (const _each of dropped) this.settleOne();
      if (last === undefined) continue;
      const newest = last.entries.at(-1);
      const room = this.deps.store.getRoom(record.roomId);
      if (newest === undefined || room === null) continue;
      this.notices.reportSilence(
        room,
        newest.entry,
        { authorId: last.authorId, displayName: last.displayName },
        'busy',
        // No dispatch of its own: no turn was ever started for this batch.
        null,
        { busyWith: 'held-too-long' }
      );
    }
  }

  /**
   * Put one room's waiting message at the front of that agent's queue.
   *
   * The whole body of `POST /api/rooms/:id/holds/:authorId/promote`. It reorders
   * and never preempts: the blocking turn is untouched, and a promoted hold still
   * waits for the agent to be free.
   *
   * @param roomId - The room asking to be answered first.
   * @param authorId - The agent it is waiting on.
   * @returns `false` when there was no hold to promote — a stale button rather
   *   than an error.
   */
  promoteHold(roomId: string, authorId: string): boolean {
    if (!this.held.has(agentKey(roomId, authorId))) return false;
    return this.collector.promote(roomId, authorId);
  }

  /**
   * Give up on what a room owes an agent that is no longer there to answer it.
   *
   * **The wait used to outlive the roster, and this change is what made that
   * matter.** A parked collection was bounded by one collect debounce — half a
   * second — so an agent removed mid-park was a race nobody could lose. A
   * cross-room hold lasts up to `rooms.lateReplyCeilingMinutes`, which is
   * fifty minutes on the shipped defaults: plenty of time to take the agent out
   * of the room, or to put the room away, while the lane goes on promising an
   * answer that can no longer come.
   *
   * **No notice, and that is the deliberate half.** The act that reached here is
   * operator-only and already visible — the agent is off the roster, or the room
   * is archived — so this is not a room going quiet for no reason, which is the
   * shape `.claude/rules/room-conduct.md` forbids. A busy line would also be
   * false: the agent was not busy, it is gone. The held indicator's `done` is
   * what withdraws the promise, published by `releaseHold` on the way through.
   *
   * @param roomId - The room whose waits are over.
   * @param authorId - One agent, or omitted for every agent in the room —
   *   which is what archiving means.
   */
  abandonHolds(roomId: string, authorId?: string): void {
    const dropped =
      authorId === undefined
        ? this.collector.drop(roomId)
        : this.collector.dropOne(roomId, authorId);
    for (const collection of dropped) {
      logger.info('[rooms] a waiting message was given up on: the agent is no longer in the room', {
        roomId,
        authorId: collection.authorId,
        waiting: collection.entries.length,
      });
      this.settleCollection(collection, 'left');
    }
    // A hold with no collection behind it should not exist — but if one ever
    // did, the indicator is the promise, so it goes either way.
    for (const [key, record] of [...this.held]) {
      if (record.roomId !== roomId) continue;
      if (authorId !== undefined && record.authorId !== authorId) continue;
      this.releaseHold(key, 'left');
    }
    // And the Stop mark goes too. It is otherwise cleared only by the next claim
    // there ({@link RoomTriggerDispatcher.stoppedHere}), and a room that has been
    // archived — or an agent taken off its roster — will never claim again, so
    // without this the key would outlive everything it is about. Nothing is
    // weakened by dropping it: the pair has no room to speak into any more, and
    // an agent added back is being asked to take part again.
    for (const [key, stopped] of [...this.stoppedHere]) {
      if (stopped.roomId !== roomId) continue;
      if (authorId !== undefined && stopped.authorId !== authorId) continue;
      this.stoppedHere.delete(key);
    }
  }

  /**
   * Every message waiting on a busy agent right now, for the diagnostic read
   * surface.
   *
   * {@link RoomTriggerDispatcher.listClaims}'s sibling, and it answers what that
   * one cannot: a room showing no claim and no answer is otherwise
   * indistinguishable from a room whose message went nowhere.
   *
   * @returns One row per live hold.
   */
  listHolds(): HeldView[] {
    return describeHolds(this.held);
  }

  /**
   * Put one hold's state on its room's ephemeral stream.
   *
   * `since` is the hold's own start on every publish, for the reason
   * {@link RoomTriggerDispatcher.publishPresence} carries the claim's: an event
   * that said "now" would reset the wait every ten seconds, and a client that
   * connected mid-wait could never learn how long it has been.
   *
   * @param record - The hold this is about.
   * @param state - `'held'` while it waits, `'done'` once it stops.
   */
  private publishHold(record: HeldRecord, state: 'held' | 'done'): void {
    this.deps.publishPresence(record.roomId, record.authorId, {
      state,
      entryId: record.entryId,
      since: record.since,
      // Only on the `held` frame. A `done` clears an indicator by its key and
      // says nothing else; carrying a room id on it would be a last disclosure
      // for no reader's benefit.
      ...(state === 'held' ? { heldBehind: this.heldBehind(record) } : {}),
    });
  }

  /**
   * What one hold is waiting behind, as the wire carries it.
   *
   * An id and a boolean, and no more: the reader may not be a member of the room
   * in the way, so the name is resolved on the client against the rooms it can
   * already see. `othersWaiting` is a boolean rather than a count because it
   * exists only to decide whether "Answer here first" would change anything —
   * a count would let a reader enumerate rooms it cannot see.
   *
   * @param record - The hold being described.
   */
  private heldBehind(record: HeldRecord): RoomHeldBehind {
    let othersWaiting = false;
    for (const other of this.held.values()) {
      if (other.agentPath !== record.agentPath || other.roomId === record.roomId) continue;
      othersWaiting = true;
      break;
    }
    return { roomId: record.behindRoomId, othersWaiting };
  }

  /**
   * End one collection's accounting AND its hold, in one call.
   *
   * **The seam that makes "no hold is ever forgotten" structural.**
   * `claimCollected` gives up in four places and each one used to call
   * `settleOne` alone; a fifth added later would have had to remember the hold.
   * The same shape {@link RoomTriggerDispatcher.releaseClaim} uses for claims:
   * one function, every terminal.
   *
   * @param collection - The batch that will not become a turn.
   * @param reason - How it ended, for the log.
   */
  private settleCollection(collection: RoomCollection, reason: HoldEnd): void {
    this.releaseHold(agentKey(collection.room.id, collection.authorId), reason);
    this.settleOne();
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
  private republishPresence(): void {
    // Before the re-state, so nothing that has outlived the room's patience is
    // announced one more time on its way out.
    this.expireHolds();
    const rooms = new Set<string>();
    for (const claim of this.claimed.values()) {
      this.publishPresence(claim, claim.pastDeadline ? 'working_late' : 'working');
      rooms.add(claim.roomId);
    }
    for (const record of this.held.values()) this.publishHold(record, 'held');
    // One repaint per ROOM, not per claim: the sidebar draws a count, so two
    // claims in one room are one dot and one event. The global stream has no
    // replay, so this tick is the only way a reader who opened the cockpit
    // mid-turn — or reconnected — learns that a room they do not have open is
    // busy. Nothing is compared against a previous count here: the tick's job
    // is to re-state, and a tick that suppressed an unchanged count would never
    // reach the reader who missed the transition.
    for (const roomId of rooms) {
      this.deps.publishWorkingCount(roomId, this.workingCount(roomId));
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
  private publishWorkingCount(roomId: string, before: number): void {
    const after = this.workingCount(roomId);
    if (after !== before) this.deps.publishWorkingCount(roomId, after);
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
  private publishPresence(claim: ActiveClaim, state: RoomPresenceState): void {
    // Every frame carries the current reading, so every frame is one the room
    // has now SEEN — including a republish or a `working_late` that lands
    // between a trailing flush being armed and firing. Recording it here rather
    // than only on the activity path is what stops that flush repeating a
    // reading already on screen. It can never suppress a needed frame: this only
    // ever equals what actually went out.
    claim.activityPublished = claim.activity;
    this.deps.publishPresence(claim.roomId, claim.authorId, {
      state,
      entryId: claim.entryId,
      since: claim.claimedAt,
      // Every publish is self-contained, exactly as `since` already is: the
      // claim frame, the `working_late` frame, each ten-second republish and
      // the `done` all carry whatever is current. A client that connects
      // mid-turn therefore sees the verb on its first frame, with no separate
      // activity event to miss.
      ...(claim.activity ? { activity: claim.activity } : {}),
    });
  }

  /**
   * Who is mid-turn in one room right now, whatever cascade they are answering.
   *
   * Presence, and only presence. An agent that can see a colleague is already on
   * something can choose not to duplicate it — but nothing here waits, orders or
   * defers, and adding any of that would be the arbitration this domain has
   * declined twice (ADR 260726-170125).
   *
   * Includes turns the room has stopped WAITING for, because they are still
   * running. Those used to be missing, so the longest turns — the ones a
   * colleague most wants to know about before starting the same work — were the
   * only ones nobody was told about.
   *
   * **One entry per agent, and no de-duplication needed to get there.** The
   * map's grain IS `(room, agent)` and {@link RoomTriggerDispatcher.busyIn}
   * refuses a second claim, so an agent cannot appear twice. It could, before
   * DOR-752 was fixed, and the roster block an agent reads rendered "Working
   * right now: Ana, Ana" — a symptom of the real fault, which was that Ana was
   * running two turns. The collapse that hid it is gone with the cause.
   *
   * @param roomId - The room being described.
   */
  /**
   * Every claim held right now, for the diagnostic read surface.
   *
   * "Which agent is holding a claim, and since when?" was the first question the
   * 2026-07-31 incident asked and could not answer: the claim map is in this
   * object's memory, and nothing outside the process could see it. Ids, an ISO
   * timestamp and a duration — no room text, no prompt, no path.
   *
   * @returns One row per live claim, newest hold last.
   */
  listClaims(): ActiveClaimView[] {
    return describeClaims(this.claimed);
  }

  private workingIn(roomId: string): Array<{ authorId: string; since: string }> {
    return claimsWorkingIn(this.claimed, roomId);
  }

  /**
   * How many agents are working in one room right now.
   *
   * The narrow read the room list and the `room_presence` fan-out are given, in
   * place of the claim map itself: a count cannot be mistaken for a roster, and
   * no caller outside this class can start reasoning about cascades, sessions or
   * entry ids it has no business knowing.
   *
   * Agents and claims are the same number here, structurally rather than by
   * arithmetic: the map is keyed `(room, agent)`, so "one agent, two claims" is
   * not a state this class can hold. Nothing counts distinct authors, because
   * there is nothing to distinguish.
   *
   * @param roomId - The room being asked about.
   * @returns The number of agents holding a claim there. `0` when idle.
   */
  workingCount(roomId: string): number {
    return this.workingIn(roomId).length;
  }

  /**
   * Whether this agent already has a turn running, and where — `null` when it is
   * free to take one.
   *
   * **Two ceilings, one lookup, because there are two different things a second
   * turn would collide with.**
   *
   * The first is this room's SESSION. A room binds one session per
   * `(room, agent)`, so a second turn there is a second writer on one
   * transcript answering a room that asked once. Deliberately blind to the
   * cascade, which is the whole point: this used to be a cascade-scoped union
   * fed into the guard's repeat rule, and that shape could only ever see a
   * re-trigger arriving inside the SAME exchange — so the common case, the next
   * message a person sends, sailed past it under a fresh root (DOR-752).
   *
   * The second is the agent's WORKING DIRECTORY, which is shared by every room
   * it is a member of. An agent is one checkout; two turns in it are two
   * processes editing the same files, and neither knows about the other
   * (room-participation spec, constraint 8). The `(room, agent)` key cannot see
   * this at all, so an agent in three rooms ran three turns in one tree — the
   * contention DOR-500 measured. The claim map spans every room this process
   * serves, so the answer is a scan of it rather than a guess.
   *
   * Both include turns the room has stopped WAITING for, because those are
   * still running — and on the shipped defaults that window is up to fifty
   * minutes, so it is where nearly every collision lives.
   *
   * **Both ceilings hold the message; the answer is a record rather than a
   * boolean because they differ in what a reader is shown.** A `here` hold marks
   * its messages as having arrived mid-turn and needs no indicator of its own —
   * the room is already showing the agent working. An `elsewhere` hold marks
   * nothing and publishes a `held` indicator pointing at the claim in the way,
   * which is why the claim itself comes back with the answer. See
   * {@link RoomTriggerDispatcher.collectOne}.
   *
   * @param roomId - The room being triggered.
   * @param authorId - The agent a trigger would run.
   * @param agentPath - That agent's directory, which is what the second ceiling
   *   is really about.
   * @returns What the room can truthfully say it is doing and the claim in the
   *   way, or `null` when it is doing nothing.
   */
  private busyWith(roomId: string, authorId: string, agentPath: string): ClaimBusy | null {
    return claimBusyWith(this.claimed, roomId, authorId, agentPath);
  }

  /**
   * Stop everything running in one room: interrupt every in-flight turn, drop
   * every claim, and say so once.
   *
   * RP8's halt verb (room-participation spec §10.4). Three things about it are
   * load-bearing and none of them is the interrupt:
   *
   * 1. **It is a control action and can never be inferred.** Nothing in this
   *    file, or any file, pattern-matches a message for "stop". In the Hermes
   *    loop incident of 26 May 2026 an operator typed "you are in a loop, stop"
   *    and the bot treated it as one more conversational turn; inferring the
   *    verb from text would be that same failure wearing the opposite clothes,
   *    because the model would then be the thing deciding whether to obey.
   * 2. **The notice is written BEFORE the claims are dropped.** Releasing a
   *    claim publishes `done`, and an indicator that vanishes ahead of the entry
   *    explaining it is a room going quiet for no visible reason — the exact
   *    shape `.claude/rules/room-conduct.md` forbids.
   * 3. **Claims are dropped through {@link RoomTriggerDispatcher.releaseClaim},
   *    never deleted from the map.** That is the only place `done` is published
   *    and the only place the republish timer is cleared, so a halt that reached
   *    into the map itself would leave a room permanently showing work that had
   *    stopped.
   *
   * The turns themselves are not awaited. Each one's own stream still closes and
   * its `runOne` still runs its `finally`, which finds this key either empty or
   * held by a LATER turn and releases neither
   * ({@link RoomTriggerDispatcher.releaseOwnClaim}) — so a halt returns as soon
   * as every interrupt is delivered. "Releasing an already-released claim is a
   * no-op" is what that used to rest on, and it was only ever true while nobody
   * re-claimed the key: a halt plus one more message put a live turn's claim
   * under a stopped turn's `finally`, which then dropped it.
   *
   * @param room - The room to stop.
   * @returns How many in-flight turns were interrupted. `0` is a real answer: it
   *   says the room was already idle.
   */
  async halt(room: Room): Promise<number> {
    const claims = [...this.claimed.values()].filter((claim) => claim.roomId === room.id);
    // **Marked before anything else, and before the first `await`.** A turn
    // whose stream closes while this method is still delivering interrupts must
    // find the mark already there, or it posts the answer Stop was pressed to
    // prevent — the two-second race measured on 2026-08-15. Nothing after this
    // line can be reached by a turn that started AFTER the halt, because a new
    // turn is a new dispatch id (see {@link RoomTriggerDispatcher.haltedTurns}).
    for (const claim of claims) {
      this.haltedTurns.add(claim.dispatchId);
      // And the same statement at the pair, for the half of a turn's voice the
      // dispatch mark cannot reach: `post_to_room`
      // ({@link RoomTriggerDispatcher.stoppedHere}). Marked here rather than in
      // the release loop below for the same reason the dispatch mark is — before
      // the first `await`, so a turn that is quicker than the interrupt cannot
      // slip a post through the gap.
      this.stoppedHere.set(agentKey(room.id, claim.authorId), {
        roomId: room.id,
        authorId: claim.authorId,
      });
    }
    logger.info('[rooms] a room was halted', { roomId: room.id, stopped: claims.length });
    // **The durable write comes first, and the whole invariant is in that
    // order.** Releasing a claim publishes `done`, so a halt that stopped the
    // turns before saying so would drop every working indicator in the room a
    // beat ahead of the line explaining why — a room going quiet for no visible
    // reason, which is the exact shape `.claude/rules/room-conduct.md` forbids.
    //
    // The room's own voice speaks whether or not anything was running: pressing
    // Stop in an idle room is a question, and silence is not an answer to it.
    // Damped per room and re-armed by the next claim, so pressing it twice is
    // one line and not two. Best-effort like every other notice — a room
    // archived between the button and this line must not leave the turns
    // running — which is what routing it through the log rather than the writer
    // buys.
    this.notices.reportHalted(room, claims.length);
    // **Before the claims, and that ordering is the whole of it.** Releasing a
    // claim is what resumes a held collection, so dropping the buffers second
    // would start, one macrotask later, exactly the turns the person pressed
    // Stop to prevent — and a gathering window that nobody stopped would answer
    // a halted room half a second after it went quiet. Nothing is lost that the
    // room log does not still hold: a collection is a marker of what has not
    // been read, and the next message a person sends collects afresh.
    for (const dropped of this.collector.drop(room.id)) {
      logger.info('[rooms] a halt dropped messages that were waiting for a turn', {
        roomId: room.id,
        authorId: dropped.authorId,
        waiting: dropped.entries.length,
      });
      // Its held indicator goes with it, and the `halted` line written a few
      // lines above is its durable sibling. Stopping THIS room drops what it was
      // waiting for; stopping the room that was in the way is the opposite case
      // and runs the wait, because the person stopped one conversation and not
      // the other.
      this.settleCollection(dropped, 'halted');
    }
    for (const claim of claims) {
      try {
        // The session lookup is INSIDE the try, and it is a database read: a
        // `SQLITE_BUSY` escaping here would abandon the loop with every
        // remaining claim marked and none of them released, so a room would show
        // agents working for the life of the process and refuse each of them
        // every message after.
        const sessionId = this.deps.store.getRoomSession(room.id, claim.authorId);
        if (sessionId !== null && sessionId !== undefined) {
          const stopped = await this.deps.runner.interrupt({
            sessionId,
            agentPath: claim.agentPath,
          });
          // **The one place the room can say it could not reach an agent**
          // (DOR-1425). The answer was thrown away here, so a stop that landed
          // on nothing — a turn still booting, most often — logged exactly like
          // one that stopped a turn. The claim goes either way; what changes is
          // that an operator reading the log can tell the two apart.
          if (!stopped) this.reportUnreachedStop(room.id, claim, sessionId);
        }
      } catch (err) {
        // One agent that will not stop must not leave the others running, and
        // its claim is dropped either way: a claim held for a turn nobody can
        // interrupt is an indicator with nothing behind it.
        logger.warn('[rooms] could not interrupt a turn while halting a room', {
          roomId: room.id,
          authorId: claim.authorId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.releaseClaim(agentKey(room.id, claim.authorId), 'halted');
    }
    return claims.length;
  }

  /**
   * Stop one agent in one room: interrupt its turn, drop what it has not read
   * yet here, and say so once. Everybody else in the room keeps working.
   *
   * **It is {@link RoomTriggerDispatcher.halt} scoped to one key, and it is held
   * to the same three constraints — not to the same statement order.** All three
   * are about what must be true BEFORE the claim is released; the two bodies
   * order the middle pair differently, and deliberately, because this one has to
   * know what it dropped before it can say what it found (`interrupted`,
   * `unstarted`, `idle`) while `halt` speaks for the whole room and can say it
   * first.
   *
   * 1. **The dispatch is marked before the first `await`** — the one ordering
   *    that is load-bearing here and is pinned by a test. An interrupt is a
   *    request and not a guarantee, so the turn's own stream still closes the
   *    ordinary way and a model that had all but finished streams its last words
   *    either side of the signal — the two-second race measured on 2026-08-15
   *    (DOR-1232).
   * 2. **The notice is written before the claim is released.** Releasing
   *    publishes `done`, and an indicator that vanishes ahead of the entry
   *    explaining it is a room going quiet for no visible reason.
   * 3. **The collection is dropped before the claim is released.** Be exact
   *    about this one, because the tempting version of the comment overstates
   *    it: releasing a claim resumes a held collection by arming a
   *    `setTimeout(0)`, and nothing in THIS method awaits after the release — so
   *    a drop moved below it would still delete the collection before any sweep
   *    could run, and every test here stays green. It was measured. The order is
   *    defence in depth for what changes underneath it: `halt` already awaits an
   *    interrupt per claim between its own release calls, which is where the
   *    same mistake really does answer the messages the person pressed Stop
   *    over, and the day anything is awaited below the release here this method
   *    inherits that. `room-per-agent-stop.test.ts` pins the drop as happening
   *    while the claim is still held, so a future `await` cannot silently
   *    reorder it.
   *
   * Nothing here reads any other key. The other agents' claims and collections
   * are never enumerated, which is what makes "the others keep working" a
   * property of this code rather than of a test.
   *
   * **A HELD agent can be stopped too**, and it is the same act at a smaller
   * scope: nothing is running here to interrupt, so what the person stops is
   * this conversation waiting. The dropped collection goes through
   * {@link RoomTriggerDispatcher.settleCollection}, so its held indicator is
   * released rather than standing until the next republish tick, and the room
   * writes the `unstarted` line. The turn in the room that was in the way is
   * NOT touched — that is the refusal `specs/room-hold-when-busy` was right to
   * make, and `Open where it's working` is still the one-click path to it.
   *
   * What it deliberately does NOT do is mute. Messages that arrive after this
   * collect and are answered normally: Stop ends a turn, it does not change a
   * setting. And it does not forget the halt mark — that is cleared at the
   * stopped turn's own terminal, exactly as `halt`'s is.
   *
   * @param room - The room the agent is working in.
   * @param authorId - The agent to stop.
   * @param byAuthorId - The person stopping it, for the room's own line.
   * @returns How many in-flight turns THIS call stopped: `1`, or `0` when the
   *   agent was not running one here — or when a press that has not finished
   *   delivering its interrupt yet had already stopped this same turn, which is
   *   one turn and is counted once.
   */
  async haltAgent(room: Room, authorId: string, byAuthorId: string): Promise<number> {
    const key = agentKey(room.id, authorId);
    const claim = this.claimed.get(key);
    // Read BEFORE the mark, or it would always be true. A press that is still
    // awaiting its interrupt leaves the claim in place, so a second press lands
    // on the same dispatch — one turn, stopped once, and counted once. The mark
    // cannot be stale: it is dropped at the turn's own terminal, and the next
    // turn for this pair is a different dispatch.
    const alreadyStopping = claim !== undefined && this.wasHalted(claim.dispatchId);
    // **Marked first, before anything that can yield.** See point 1 above: a
    // turn whose stream closes while this method is still delivering the
    // interrupt must find the mark already there, or it posts the answer Stop
    // was pressed to prevent.
    if (claim !== undefined) {
      this.haltedTurns.add(claim.dispatchId);
      // The other half of this turn's voice, at the pair rather than at the
      // dispatch, and scoped to this key like everything else here — stopping
      // Ana never takes Bo's hand off the tool
      // ({@link RoomTriggerDispatcher.stoppedHere}).
      this.stoppedHere.set(key, { roomId: room.id, authorId });
    }
    logger.info('[rooms] an agent was stopped in a room', {
      roomId: room.id,
      authorId,
      // What THIS press did, which is what a person reading two lines for one
      // turn needs to tell them apart.
      stopped: claim !== undefined && !alreadyStopping,
      alreadyStopping,
    });

    // Dropped before the notice only to KNOW what to say; nothing here can
    // yield, so the durable-write-before-release ordering is untouched. Scoped
    // to this agent, so what anybody else is waiting to answer is left alone.
    const waiting = this.collector.dropOne(room.id, authorId);
    for (const dropped of waiting) {
      logger.info('[rooms] a stop dropped messages that were waiting for a turn', {
        roomId: room.id,
        authorId,
        waiting: dropped.entries.length,
      });
      // Through the seam, so the held indicator goes with the collection rather
      // than standing until the next republish tick with nothing durable under
      // it. Stopping a HELD agent is the case this covers: nothing is running
      // here to interrupt, and what the person stopped is this conversation
      // waiting. The `halted` line written just below is its durable sibling —
      // and the turn in the OTHER room is untouched, which is the whole
      // difference between this and stopping the room that is in the way.
      this.settleCollection(dropped, 'halted');
    }

    this.notices.reportAgentHalted(room, {
      byAuthorId,
      subjectAuthorId: authorId,
      outcome: claim !== undefined ? 'interrupted' : waiting.length > 0 ? 'unstarted' : 'idle',
    });

    if (claim === undefined) return 0;
    // The earlier press owns the interrupt and the release; a second one here
    // would interrupt a turn that is already being stopped and then release a
    // key the first press is about to release itself.
    if (alreadyStopping) return 0;

    try {
      // **The session lookup is inside the try, and that is the whole reason
      // there is one line of nesting here.** It is a database read, and a
      // `SQLITE_BUSY` escaping at this point would leave a marked, un-released
      // claim: the room would show that agent working for the life of the
      // process, and the `(room, agent)` ceiling would refuse it every message
      // after. Whatever went wrong, the claim goes.
      const sessionId = this.deps.store.getRoomSession(room.id, authorId);
      if (sessionId !== null && sessionId !== undefined) {
        const stopped = await this.deps.runner.interrupt({
          sessionId,
          agentPath: claim.agentPath,
        });
        // Same answer, same reading, at the narrower scope (DOR-1425).
        if (!stopped) this.reportUnreachedStop(room.id, claim, sessionId);
      }
    } catch (err) {
      // An agent that will not stop still loses its claim: a claim held for a
      // turn nobody can interrupt is an indicator with nothing behind it.
      logger.warn('[rooms] could not interrupt a turn while stopping an agent', {
        roomId: room.id,
        authorId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // By KEY, not by dispatch: this is stopping whoever holds the claim rather
    // than finishing a turn of its own, which is the one case room-conduct
    // reserves `releaseClaim` for.
    this.releaseClaim(key, 'halted');
    return 1;
  }
}
