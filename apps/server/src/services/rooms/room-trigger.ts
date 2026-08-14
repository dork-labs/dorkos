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
 *    The busy REFUSAL survives for the other ceiling, and only for it: an agent
 *    working in another room is working in another checkout, and nothing this
 *    room does will finish that turn. Refusing there is still refusing rather
 *    than queueing (ADR 260726-170125); holding here is not a queue either,
 *    because what is stored is what the agent has not read yet rather than a
 *    plan for a turn that is already scheduled.
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
  RoomPresencePayload,
  RoomPresenceState,
} from '@dorkos/shared/room-schemas';
import { newDispatchId } from '@dorkos/shared/dispatch-id';
import { logError, logger } from '../../lib/logger.js';
import { runInDispatch } from '../../lib/dispatch-context.js';
import { recordDispatchEnd, recordDispatchStart } from '../observability/dispatch-buffers.js';
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
  type ActiveClaim,
  type ActiveClaimView,
  type ClaimBusy,
  type ClaimOutcome,
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
import type { ReactionStore } from './reaction-store.js';
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
import type { RoomTurnBudget } from './turn-budget.js';

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
  /** The live `rooms.maxAgentDepth`, read per dispatch so a change takes effect. */
  maxAgentDepth(): number;
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
   * Put one message into one agent's collection, or refuse it outright.
   *
   * **The two busy ceilings part company here, and that is the whole of RP8's
   * steering.** An agent working in ANOTHER room is working in another checkout;
   * nothing this room does will finish that turn, so the refusal stands and says
   * so. An agent working in THIS room is about to be free, and its answer lands
   * in front of this reader — so the message is held rather than refused, and
   * the claim's release runs a turn for it. The old busy line for that case
   * ("it didn't pick this one up") described the truth before this existed and
   * would now be a lie: the agent picks it up, one turn later.
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
    if (busyWith === 'working-elsewhere') {
      this.notices.reportSilence(
        room,
        entry,
        { authorId: candidate.authorId, displayName: candidate.displayName },
        'busy',
        // Refused before it became a target, so it has no dispatch of its own
        // — and the ambient one belongs to whoever's reply triggered this.
        null,
        { busyWith }
      );
      return;
    }
    const opened = this.collector.collect({
      room,
      authorId: candidate.authorId,
      agentPath: candidate.agentPath,
      displayName: candidate.displayName,
      entry,
      depth: candidate.depth,
      engaged: candidate.engaged,
      duringTurn: busyWith === 'working-here',
      arrivedAt,
    });
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

    const provenance = {
      root: entry.cascadeRoot,
      depth: entry.cascadeDepth,
      authorsInCascade: this.deps.store.authorsInCascade(room.id, entry.cascadeRoot),
    };
    const maxAgentDepth = this.deps.maxAgentDepth();

    const allowed: TriggerCandidate[] = [];
    // Collected rather than reported inline, so a member that is BOTH a selected
    // target and a name this message typed gets one notice, not two.
    const gone = new Set<string>(namedUnreachable);
    for (const authorId of selected) {
      const record = records.get(authorId);
      const decision = evaluateCascade(authorId, provenance, { maxAgentDepth });
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
        // refusals that must still speak (an ancestry stop, and a chain that
        // reaches the depth ceiling), so this cannot be widened into a spray or
        // narrowed into a general hush without something going red.
        //
        // On the two terms below: `fromRealChain` is the load-bearing one, and
        // the `ancestry` term is a guard rather than a discriminator. Every
        // reachable ancestry refusal ALSO has `fromRealChain` true, because a
        // cascade whose root is this entry contains only this entry (plus
        // system notices), so the target cannot already be in it. Kept because
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
    // `ancestry` term is a guard rather than a discriminator. Every reachable
    // ancestry refusal ALSO has `fromRealChain` true, because a cascade whose
    // root is this entry contains only this entry (plus system notices), so the
    // target cannot already be in it. Kept because that is a property of
    // `deriveCascade` in another module, not of anything here, and it costs one
    // comparison to not depend on it.
    const fromRealChain = entry.cascadeRoot !== entry.id;
    if (reason !== 'ancestry' && !fromRealChain) return;
    this.notices.announce(
      room,
      entry,
      authorId,
      buildCascadeNotice(displayName ?? 'An agent', authorId),
      reason === 'ancestry' ? 'cascade_ancestry' : 'cascade_depth',
      // Explicitly none. This target was refused before it could be given an id
      // — and `selectCandidates` runs synchronously inside `RoomService.post`,
      // which for an AGENT'S reply is inside that agent's own dispatch scope.
      // Left to the ambient id, a refusal about Bo would be filed under Ana's
      // dispatch.
      null
    );
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
   * real defect.** Its ancestry rule is a durable query, so a message collected
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
    const maxAgentDepth = this.deps.maxAgentDepth();
    // One read per distinct cascade, not per message. A batch is usually one or
    // two exchanges, so this is a couple of indexed queries however long it is.
    const inCascade = new Map<string, readonly string[]>();
    const authorsInCascade = (root: string): readonly string[] => {
      const known = inCascade.get(root);
      if (known) return known;
      const found = this.deps.store.authorsInCascade(room.id, root);
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
          authorsInCascade: authorsInCascade(held.entry.cascadeRoot),
        },
        { maxAgentDepth }
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
      this.settleOne();
      return null;
    }
    // Asked AGAIN, not merely re-read: a window that opened while the agent was
    // free can still close after something else claimed it — an aside turn, or
    // a burst in another room reaching the same checkout.
    const busyWith = this.busyWith(room.id, authorId, agentPath);
    if (busyWith === 'working-here') {
      // Parked, not refused: this is the same steer `collectOne` makes, arrived
      // at from the other direction. The credit stays with the collection —
      // unless parking MERGED it into one already waiting, in which case two
      // pending turns have become one and the surplus is settled here.
      if (this.collector.park(collection)) this.settleOne();
      return null;
    }
    if (busyWith === 'working-elsewhere') {
      this.notices.reportSilence(room, newest.entry, { authorId, displayName }, 'busy', null, {
        busyWith,
      });
      this.settleOne();
      return null;
    }

    const chosen = this.chooseTrigger(collection);
    if (!chosen) {
      // EVERY message in the batch was refused, so the batch is refused — and
      // the refusals are already on the log, written by `chooseTrigger` under
      // the same narrowness a single refusal has always had.
      this.settleOne();
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
    };

    // The cascade guard allowed these on the merits, one message at a time. The
    // budget is the second, blunter question — can this ROOM afford another
    // automatic turn at all — and it is asked without reference to who wrote the
    // entry, so a caller who reached depth 0 by claiming to be human still stops
    // here. ONCE for the collection, because a collection is one turn.
    const afford = this.deps.budget.tryReserve(room.id);
    if (!afford.allowed) {
      // This one CAN be correlated: the target survived the guard and was given
      // its id above, so the refusal belongs to a real dispatch that never ran.
      this.notices.reportBudget(room, entry, afford.scope ?? 'room', target.dispatchId);
      this.settleOne();
      return null;
    }
    // Spending again means the window moved, so re-arm the notice: the next
    // exhaustion is news, not a repeat.
    this.notices.budgetRecovered(room.id);

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
      this.settleOne();
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
      claimedAt: new Date().toISOString(),
      pastDeadline: false,
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
        entry,
        working: this.workingIn(room.id),
        // The cursor as it stood before the claim moved it. The stored row has
        // already advanced past this entry, so reading it here would describe
        // an empty window every time (room-participation spec §8.3).
        lastReadSeq: target.lastReadSeq,
        budget: this.deps.budget.remaining(room.id),
        repliesLeftInThisChain: Math.max(0, this.deps.maxAgentDepth() - target.depth),
        engaged: target.engaged,
        // Which of the messages in that window landed while this agent was
        // already working (RP8). Without it a steered turn reads as a person
        // repeating themselves, when what actually happened is that they carried
        // on talking while the agent was busy.
        arrivedDuringPrevTurn: target.arrivedDuringPrevTurn,
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
      if (result.late) {
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
      this.notices.reportSilence(room, entry, target, 'failed', target.dispatchId);
    } finally {
      // `runner.run()` resolving is the end of the WAIT, which is only the end
      // of the TURN when the turn beat the deadline. A late turn is still
      // running and must still read as working — to the guard, to a room-mate
      // reading `room_context.working`, and to the person watching.
      // {@link RoomTriggerDispatcher.deliverLate} releases it when the answer
      // finally settles, whichever way it settles.
      if (this.claimed.get(key)?.pastDeadline !== true) this.releaseClaim(key, outcome);
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
      trigger: { root: entry.cascadeRoot, depth: target.depth },
      // Answer where you were asked. `threadRootEntryId` is already a validated
      // top-level entry — every reply carries the root, never another reply —
      // so re-resolving it in `post` cannot refuse this write.
      replyTo: entry.threadRootEntryId ?? undefined,
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
        this.releaseClaim(key, outcome);
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
        busyWith,
      });
      return null;
    }
    if (!this.deps.budget.tryReserve(room.id).allowed) {
      logger.debug('[rooms] skipped a welcome-back offer: the room is out of automatic turns', {
        roomId: room.id,
        authorId,
      });
      return null;
    }
    // **The re-arm, exactly as `claimTargets` does it, and it is not optional
    // here.** Spending again means the hourly window moved, so the next
    // exhaustion is news rather than a repeat. Without this line an offer
    // silently consumes the freshly-rolled window and leaves the memory of the
    // LAST refusal standing — so the next person to be refused is refused with
    // no notice at all. An invisible refusal of a message somebody addressed is
    // the shape `.claude/rules/room-conduct.md` forbids, and an offer nobody
    // asked for must not be the thing that causes it.
    this.notices.budgetRecovered(room.id);

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
      depth: this.deps.maxAgentDepth(),
      // Nothing in the room asked for this turn, so it has no cascade to hand
      // to a post the agent makes while it runs. See {@link ActiveClaim.aside}.
      aside: true,
      claimedAt: new Date().toISOString(),
      pastDeadline: false,
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
        entry,
        working: this.workingIn(room.id),
        // NO AMBIENT WINDOW, and no cursor moved. A trigger replays what the
        // agent missed because it is answering the room; this is a narrow
        // question about the agent's own work, and replaying the conversation
        // into it would both invite an answer to somebody else's message and
        // silently consume the window the next real trigger owes it
        // (room-participation spec §8.3).
        lastReadSeq: entry.seq,
        budget: this.deps.budget.remaining(room.id),
        // None. An offer is one line and the end of it; the ceiling stamp above
        // says the same thing to the guard.
        repliesLeftInThisChain: 0,
        engaged: null,
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
      });
      if (result.sessionId !== input.sessionId) {
        this.deps.store.rebindRoomSession(room.id, authorId, result.sessionId);
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
      if (settled.unanswered) {
        outcome = settled.unanswered;
        return null;
      }
      const said = settled.text?.trim();
      if (!said) return null;
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
      this.releaseClaim(key, outcome);
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
    // Something is happening here again, so a halt is news again.
    this.notices.workStarted(claim.roomId);
    const before = this.workingCount(claim.roomId);
    this.claimed.set(agentKey(claim.roomId, claim.authorId), claim);
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
   * Releasing a key that is not held is a no-op rather than a throw, because
   * {@link RoomTriggerDispatcher.runOne}'s `finally` reaches here on a path where
   * the claim may already be gone. The map is the only record that an indicator
   * is outstanding, so a `done` for a claim nobody holds would be an event about
   * nothing.
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
  }

  /**
   * Re-state every live claim, on the interval.
   *
   * One event per claim, carrying the indicator's full identity —
   * `(room, author, entryId)` — because that is what the client keys its store
   * on (room-presence spec §3.2, §5.1). An agent holds at most one claim per
   * room, so this is also one event per working agent per room.
   */
  private republishPresence(): void {
    const rooms = new Set<string>();
    for (const claim of this.claimed.values()) {
      this.publishPresence(claim, claim.pastDeadline ? 'working_late' : 'working');
      rooms.add(claim.roomId);
    }
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
    this.deps.publishPresence(claim.roomId, claim.authorId, {
      state,
      entryId: claim.entryId,
      since: claim.claimedAt,
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
   * fed into the guard's ancestry rule, and that shape could only ever see a
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
   * **The two ceilings now have two different OUTCOMES, which is why the answer
   * is an enum rather than a boolean** (RP8). The first one holds the message
   * for the agent's next turn; the second refuses it and says so. See
   * {@link RoomTriggerDispatcher.collectOne}.
   *
   * @param roomId - The room being triggered.
   * @param authorId - The agent a trigger would run.
   * @param agentPath - That agent's directory, which is what the second ceiling
   *   is really about.
   * @returns What the room can truthfully say it is doing, or `null` when it is
   *   doing nothing.
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
   * its `runOne` still runs its `finally` — releasing an already-released claim
   * is a no-op — so a halt returns as soon as every interrupt is delivered.
   *
   * @param room - The room to stop.
   * @returns How many in-flight turns were interrupted. `0` is a real answer: it
   *   says the room was already idle.
   */
  async halt(room: Room): Promise<number> {
    const claims = [...this.claimed.values()].filter((claim) => claim.roomId === room.id);
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
      this.settleOne();
    }
    for (const claim of claims) {
      const sessionId = this.deps.store.getRoomSession(room.id, claim.authorId);
      if (sessionId !== null && sessionId !== undefined) {
        try {
          await this.deps.runner.interrupt({ sessionId, agentPath: claim.agentPath });
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
      }
      this.releaseClaim(agentKey(room.id, claim.authorId), 'halted');
    }
    return claims.length;
  }
}
