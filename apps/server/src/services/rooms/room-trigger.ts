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
import { outsideAuditScope } from '../audit/audit-context.js';
import { ROOM_LIVE_BEAT_MS } from '@dorkos/shared/room-schemas';
import type {
  AuthorKind,
  ReseatOptions,
  Room,
  RoomEntry,
  RoomHeldBehind,
  RoomPresenceState,
  RoomWorkingClaim,
  SkippedTrigger,
} from '@dorkos/shared/room-schemas';
import type { SessionActivity } from '@dorkos/shared/session-stream';
import type { InterruptReceipt } from '@dorkos/shared/types';
import { logger } from '../../lib/logger.js';
import { runInDispatch } from '../../lib/dispatch-context.js';
import { type RoutedEntry, type RoutingVerdict } from './response-gate/routing-rules.js';
import {
  agentKey,
  claimBusyWith,
  claimedAgentPaths,
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
import { type CascadeDecision, type CascadeRefusalReason } from './cascade-guard.js';
import { RoomCollector, type CollectedTrigger, type RoomCollection } from './room-collect.js';
import { nameForAgents } from './room-context.js';
import { resolveRoomTurnPlace, type RoomTurnPlace } from './repo/room-turn-place.js';
import { RoomNoticeLog, type CascadeStamp, type RoomTurnUnanswered } from './notices/notice-log.js';
import { TurnReceipts } from './receipts/turn-receipts.js';
import type { RoomDispatchSummary, RoomTriggerDeps } from './service/room-trigger-deps.js';
import { type LateRoomReply, type RoomTurnReply } from './room-turn-port.js';
import { nothingDispatched, type TriggerCandidate } from './room-trigger/candidates.js';
import * as candidates from './room-trigger/candidates.js';
import * as batchRouting from './room-trigger/batch-routing.js';
import * as claimCollected from './room-trigger/claim-collected.js';
import * as runTurn from './room-trigger/run-turn.js';
import * as delivery from './room-trigger/deliver.js';
import * as aside from './room-trigger/aside.js';
import * as claims from './room-trigger/claims.js';
import * as holds from './room-trigger/holds.js';
import * as halting from './room-trigger/halt.js';
import * as reseating from './room-trigger/reseat.js';

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
 *
 * **Not a literal any more.** Follow mode beats on the same lane and had its own
 * copy of 10 000; two numbers that must agree and are written down twice are one
 * edit away from disagreeing, and the symptom is an indicator that goes out a
 * third of the time. {@link ROOM_LIVE_BEAT_MS} is the one place it lives.
 */
const PRESENCE_REPUBLISH_MS = ROOM_LIVE_BEAT_MS;

/**
 * Runs addressing, the cascade guard, and the turns that survive both.
 *
 * Construction is deliberately cheap and side-effect free: an install with no
 * rooms in it pays for one object.
 *
 * **Most of its bodies live in `room-trigger/`**, one module per concern, each
 * function taking this dispatcher as `self`; the method here delegates to it.
 * That is why the state and helpers those modules reach carry no `private`:
 * they are internal to this file and its sibling folder, not API, and nothing
 * outside `room-trigger/` should call a member that is not documented here.
 */
export class RoomTriggerDispatcher {
  readonly deps: RoomTriggerDeps;

  /**
   * Turns in flight, keyed `(room, agent)` — one apiece, which is the rule
   * {@link RoomTriggerDispatcher.busyIn} enforces rather than merely records.
   *
   * The VALUE carries every field a reader needs. Nothing parses the key back
   * apart — an earlier revision did, against a separator it guessed wrong, and
   * the resulting lookup silently returned "no active turn" for every caller
   * while every test still passed.
   */
  readonly claimed = new Map<string, ActiveClaim>();

  /** Who is waiting for the next claim to be released (room hand-offs, DOR-3397). */
  readonly releaseWaiters = new Set<() => void>();

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
  readonly held = new Map<string, HeldRecord>();

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
  readonly haltedTurns = new Set<string>();

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
  readonly stoppedHere = new Map<string, { roomId: string; authorId: string }>();

  /**
   * The republish loop, alive exactly while {@link RoomTriggerDispatcher.claimed}
   * is non-empty.
   *
   * An install with no room in it, and a room where nobody is working, runs no
   * timer at all — the loop is started by the first claim and cleared by the
   * last release, rather than ticking over an empty map forever.
   */
  republishing: NodeJS.Timeout | null = null;
  /** The 👀 receipts standing and the busy launches waiting (DOR-2823). */
  readonly receipts: TurnReceipts;

  /**
   * What this room has already said about itself, and what it says next.
   *
   * Every notice and every damping key lives behind it
   * ({@link RoomNoticeLog}). Held per DISPATCHER rather than per room, exactly
   * as the three sets it replaced were: the keys are room-scoped, so one object
   * for the process is one object, not a leak.
   */
  readonly notices: RoomNoticeLog;

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
  readonly collector: RoomCollector;

  /**
   * In-flight work, so {@link RoomTriggerDispatcher.idle} can wait it out.
   *
   * Counts collections as well as turns. A burst gathered but not yet answered
   * is work the room owes, and reporting it idle would let a test — or a
   * shutdown — measure a room that has not finished moving.
   */
  inFlight = 0;
  private settled: Array<() => void> = [];

  constructor(deps: RoomTriggerDeps) {
    this.deps = deps;
    this.notices = new RoomNoticeLog({
      writer: deps.writer,
      authors: deps.authors,
      nameForAgents: (authorId) => nameForAgents(deps, authorId, { sentenceStart: true }),
    });
    this.collector = new RoomCollector({
      window: deps.collect,
      run: (batch) => this.runCollected(batch),
    });
    this.receipts = new TurnReceipts({
      ...(deps.markReceipt ? { markReceipt: deps.markReceipt.bind(deps) } : {}),
      lastReadSeq: (roomId, authorId) =>
        deps.store.listMembers(roomId).find((m) => m.authorId === authorId)?.lastReadSeq ?? -1,
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
  dispatch(
    room: Room,
    entry: RoomEntry,
    namedUnreachable: readonly string[] = []
  ): RoomDispatchSummary {
    // A notice is the room talking about itself. Letting it address anyone would
    // make "Ana stopped replying" a reason for Bo to start.
    if (entry.kind !== 'post') return nothingDispatched();

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
    const selection = this.selectCandidates(room, entry, namedUnreachable);
    for (const candidate of selection.candidates) {
      this.collectOne(room, entry, candidate, arrivedAt);
    }
    // **A person sees at once that somebody has their message** (DOR-2823): the
    // 👀 receipt, from each agent the room picked, taken off when its turn ends.
    if (this.deps.authors.getById(entry.authorId)?.kind === 'human') {
      for (const candidate of selection.candidates)
        this.receipts.mark(room.id, entry, candidate.authorId);
    }
    return {
      triggered: selection.candidates.map((candidate) => candidate.author),
      skipped: selection.skipped,
    };
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
  collectOne(room: Room, entry: RoomEntry, candidate: TriggerCandidate, arrivedAt: number): void {
    // Older waits first. A raised `rooms.maxConcurrentTurnsPerAgent` frees a
    // slot with no turn ending, and until the next republish beat nothing has
    // re-armed the messages already waiting for this agent — so a message sent
    // now would take the slot ahead of one that has waited minutes. Re-arming
    // them here, before this message is decided, puts them in the sweep first:
    // armed from THIS message's `arrivedAt`, they are due no later than it, so
    // they share its sweep and the sweep takes the oldest.
    this.resumeFreedHolds(candidate.agentPath, arrivedAt);
    const busyWith = this.busyWith(room.id, candidate.authorId, candidate.agentPath);
    const opened = this.collector.collect({
      room,
      authorId: candidate.authorId,
      agentPath: candidate.agentPath,
      displayName: candidate.displayName,
      entry,
      depth: candidate.depth,
      engaged: candidate.engaged,
      reason: candidate.reason,
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
  settleOne(): void {
    this.inFlight -= 1;
    if (this.inFlight !== 0) return;
    const waiters = this.settled;
    this.settled = [];
    for (const resolve of waiters) resolve();
  }

  private selectCandidates(
    room: Room,
    entry: RoomEntry,
    namedUnreachable: readonly string[]
  ): { candidates: TriggerCandidate[]; skipped: SkippedTrigger[] } {
    return candidates.selectCandidates(this, room, entry, namedUnreachable);
  }

  announceCascade(
    room: Room,
    entry: RoomEntry,
    authorId: string,
    displayName: string | undefined,
    reason: CascadeRefusalReason
  ): void {
    return candidates.announceCascade(this, room, entry, authorId, displayName, reason);
  }

  cascadeLimitsFor(
    roomId: string
  ): { maxAgentDepth: number; maxTurnsPerAgentPerCascade: number } | null {
    return candidates.cascadeLimitsFor(this, roomId);
  }

  headroomFor(
    roomId: string,
    depth: number | 'ceiling'
  ): {
    budget: { room: number | null; global: number | null };
    repliesLeftInThisChain: number | null;
  } {
    return candidates.headroomFor(this, roomId, depth);
  }

  private runCollected(batch: RoomCollection[]): void {
    return batchRouting.runCollected(this, batch);
  }

  gateBatch(batch: RoomCollection[]): RoomCollection[] {
    return batchRouting.gateBatch(this, batch);
  }

  routeCollection(
    collection: RoomCollection,
    agentsIn: Map<string, ReadonlySet<string>>
  ): NonNullable<RoutingVerdict> | null {
    return batchRouting.routeCollection(this, collection, agentsIn);
  }

  routedEntry(
    roomId: string,
    agentAuthorId: string,
    entry: RoomEntry,
    authorKind: AuthorKind | undefined
  ): RoutedEntry {
    return batchRouting.routedEntry(this, roomId, agentAuthorId, entry, authorKind);
  }

  chooseTrigger(
    collection: RoomCollection
  ): { held: CollectedTrigger; decision: CascadeDecision; index: number } | null {
    return batchRouting.chooseTrigger(this, collection);
  }

  claimCollected(
    collection: RoomCollection
  ): { room: Room; entry: RoomEntry; target: TriggerTarget } | null {
    return claimCollected.claimCollected(this, collection);
  }

  reportGone(
    room: Room,
    entry: RoomEntry,
    gone: ReadonlySet<string>,
    namedUnreachable: readonly string[]
  ): void {
    return claimCollected.reportGone(this, room, entry, gone, namedUnreachable);
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
    if (!claim) return;
    claim.spokeViaTool = true;
  }

  /**
   * Everything `post_to_room` needs to know about the turn it is being called
   * from inside, or `undefined` when this agent holds no claim in this room.
   *
   * One read for two questions about the SAME live claim, so they cannot
   * disagree with each other: which message the turn is answering, and which
   * session it is running on. Asking them one at a time would be two map lookups
   * that a release between them could split.
   *
   * `undefined` is not "a turn with nothing in it" — it means no turn is running
   * here, which is a real and supported state: an agent may post by hand with
   * nothing in flight at all. Every bound that keys on a turn is skipped there,
   * deliberately, because there is no turn for them to bound.
   *
   * @param roomId - The room being posted into.
   * @param authorId - The agent posting.
   * @returns The live turn's facts, or `undefined` when there is no live turn.
   */
  activeTurnHere(
    roomId: string,
    authorId: string
  ): { entryId: string; sessionId: string | undefined } | undefined {
    const claim = this.claimed.get(agentKey(roomId, authorId));
    if (claim === undefined) return undefined;
    return { entryId: claim.entryId, sessionId: claim.sessionId };
  }

  /**
   * Record which session a live turn is actually running on, once the runtime
   * has named it (spec `tool-only-room-replies` §D8).
   *
   * @param roomId - The room the turn is running in.
   * @param authorId - The agent taking it.
   * @param sessionId - The canonical session id.
   */
  noteSessionBound(roomId: string, authorId: string, sessionId: string): void {
    const claim = this.claimed.get(agentKey(roomId, authorId));
    if (claim) claim.sessionId = sessionId;
  }

  /**
   * Record that an agent put a reaction on a message in this room, from inside
   * its own turn (spec `tool-only-room-replies` §D10).
   *
   * The whole effect is on what the end of that turn counts as: a reaction-only
   * turn is `'answered'` and earns no `agent_declined` line, because the room
   * shows something. See {@link ActiveClaim.reactedViaTool}.
   *
   * Called only after the reaction has actually landed — a refusal must not buy
   * silence — and only ever for an agent, because a claim belongs to one.
   *
   * @param roomId - The room the reaction landed in.
   * @param authorId - The agent that put it there.
   */
  noteDeliberateReaction(roomId: string, authorId: string): void {
    const claim = this.claimed.get(agentKey(roomId, authorId));
    if (!claim) return;
    claim.reactedViaTool = true;
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
  takeSpokeViaTool(roomId: string, authorId: string): boolean {
    const claim = this.claimed.get(agentKey(roomId, authorId));
    if (claim?.spokeViaTool !== true) return false;
    claim.spokeViaTool = false;
    return true;
  }

  /**
   * Take the "this agent has already reacted here" mark, if one is standing.
   *
   * {@link RoomTriggerDispatcher.takeSpokeViaTool}'s sibling, taken rather than
   * read for exactly the same reason: a claim outlives its own turn under RP8's
   * park-and-resume, and a standing mark would let one turn's reaction discharge
   * the NEXT turn's obligation to answer.
   *
   * Read only in the tool-only path, where a reaction is a first-class outcome.
   * In text mode a turn that reacts and says nothing still produces no entry and
   * still reads as `'quiet'`, exactly as it does today.
   *
   * @param roomId - The room the answer is being delivered into.
   * @param authorId - The agent delivering it.
   * @returns `true` when this turn put a reaction in front of the room.
   */
  takeReactedViaTool(roomId: string, authorId: string): boolean {
    const claim = this.claimed.get(agentKey(roomId, authorId));
    if (claim?.reactedViaTool !== true) return false;
    claim.reactedViaTool = false;
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
  runOne(room: Room, entry: RoomEntry, target: TriggerTarget): Promise<void> {
    return runInDispatch({ dispatchId: target.dispatchId, origin: 'room', entryId: entry.id }, () =>
      this.runOneInDispatch(room, entry, target)
    );
  }

  private runOneInDispatch(room: Room, entry: RoomEntry, target: TriggerTarget): Promise<void> {
    return runTurn.runOneInDispatch(this, room, entry, target);
  }

  deliver(opts: {
    room: Room;
    entry: RoomEntry;
    target: TriggerTarget;
    reply: RoomTurnReply;
    late?: { waitedMs: number };
  }): ClaimOutcome {
    return delivery.deliver(this, opts);
  }

  deliverLate(opts: {
    room: Room;
    entry: RoomEntry;
    target: TriggerTarget;
    late: Promise<LateRoomReply>;
  }): void {
    return delivery.deliverLate(this, opts);
  }

  /**
   * Ask one agent something the room never posted — the welcome-back offer's
   * only way in (DOR-1046, spec `team-room-home` D5.2).
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
   * **The agent posts the offer itself, and nothing here hands text back**
   * (spec `tool-only-room-replies` §A2, reversing D12). An offer turn is an
   * ordinary room turn: it calls `post_to_room` or it does not, and one that
   * does not produces nothing and no notice — which is consistent with the four
   * silences below and with ambient silence everywhere else. The greeter used to
   * post whatever this returned, which made the offer the one path in the
   * product where a turn's narration was still the room's message; a second
   * delivery is exactly the drift the graduation removes.
   *
   * **The cascade stamp still stands the offer down**, and it does so through
   * the claim rather than through the greeter's un-provenanced write: the claim
   * below is taken with `aside: true` and at the ceiling, so a post made from
   * inside this turn inherits no root and is stamped spent on arrival. An offer
   * cannot start a conversation, which is the property this reversal had to
   * preserve and is pinned by a test.
   *
   * @param input.room - The room the offer would be made in.
   * @param input.entry - The entry it is ABOUT — the status line this agent just
   *   posted. It frames the turn's context and names the working indicator.
   * @param input.authorId - The agent being asked.
   * @param input.prompt - The question, as the model will see it.
   */
  askAside(input: aside.AsideInput): Promise<aside.AsideResult> {
    return aside.askAside(this, input);
  }

  runAsideInDispatch(input: aside.AsideRun): Promise<aside.AsideResult> {
    return aside.runAsideInDispatch(this, input);
  }

  /**
   * Resolve when the next claim is released, or after `timeoutMs`, whichever is first: how a
   * room hand-off waits out a busy seat (DOR-3397) without polling the claim map.
   *
   * @param timeoutMs - The longest to wait.
   */
  nextRelease(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.releaseWaiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, timeoutMs);
      timer.unref?.();
      this.releaseWaiters.add(wake);
    });
  }

  awaitLate(late: Promise<LateRoomReply>, key: string): Promise<RoomTurnReply> {
    return runTurn.awaitLate(this, late, key);
  }

  rewindClaimCursor(room: Room, entry: RoomEntry, target: TriggerTarget): void {
    return runTurn.rewindClaimCursor(this, room, entry, target);
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
  wasHalted(dispatchId: string): boolean {
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
  forgetHalt(dispatchId: string): void {
    this.haltedTurns.delete(dispatchId);
  }

  reportUnreachedStop(
    roomId: string,
    claim: ActiveClaim,
    sessionId: string,
    receipt: InterruptReceipt
  ): void {
    return halting.reportUnreachedStop(this, roomId, claim, sessionId, receipt);
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
  holdClaim(claim: ActiveClaim): void {
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
      this.republishing = setInterval(
        outsideAuditScope(() => this.republishPresence()),
        PRESENCE_REPUBLISH_MS
      );
      // A heartbeat is not a reason for the process to stay alive: an unref'd
      // interval lets a CLI that has finished exit while a room still holds a
      // claim, instead of hanging for ten seconds at a time on a timer whose
      // only job is to repaint a screen nobody is watching. Optional-called like
      // its sibling in `room-turn-runner.ts`, which does not assume a Node timer.
      this.republishing.unref?.();
    }
  }

  releaseOwnClaim(key: string, dispatchId: string, outcome: ClaimOutcome): void {
    return claims.releaseOwnClaim(this, key, dispatchId, outcome);
  }

  releaseClaim(key: string, outcome: ClaimOutcome): void {
    return claims.releaseClaim(this, key, outcome);
  }

  noteActivity(key: string, activity: SessionActivity | null): void {
    return claims.noteActivity(this, key, activity);
  }

  publishActivityNow(claim: ActiveClaim): void {
    return claims.publishActivityNow(this, claim);
  }

  disarmActivityFlush(claim: ActiveClaim): void {
    return claims.disarmActivityFlush(this, claim);
  }

  noteHold(
    roomId: string,
    authorId: string,
    agentPath: string,
    entryId: string,
    busy: ClaimBusy
  ): void {
    return holds.noteHold(this, roomId, authorId, agentPath, entryId, busy);
  }

  restateSiblingHolds(record: HeldRecord): void {
    return holds.restateSiblingHolds(this, record);
  }

  releaseHold(key: string, reason: HoldEnd): void {
    return holds.releaseHold(this, key, reason);
  }

  resumeElsewhere(agentPath: string, from?: number): void {
    return holds.resumeElsewhere(this, agentPath, from);
  }

  resumeFreedHolds(onlyPath?: string, from?: number): void {
    return holds.resumeFreedHolds(this, onlyPath, from);
  }

  expireHolds(): void {
    return holds.expireHolds(this);
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
   * **It used to write no notice, and DOR-786 changed that for one half of it.**
   * The old reasoning was that the act reaching here is operator-only and already
   * visible — the agent is off the roster, or the room is archived — so the room
   * was not going quiet for no reason. That held while a post promised nothing.
   * It does not now: `POST /api/rooms/:id/entries` answers with the agents it
   * asked to reply (`PostToRoomResponse.triggered`), and the person who sent the
   * message is not necessarily the person who changed the roster. A promise the
   * room makes and then drops in silence is exactly the shape
   * `.claude/rules/room-conduct.md` forbids, so the room now says the member
   * left. The held indicator's `done` still withdraws the live indicator; this is
   * the durable half, which survives a reader who was not watching.
   *
   * **Archiving still writes nothing, and cannot.** `postNotice` refuses an
   * archived room, because archiving promises the room stops gaining entries —
   * so there is nowhere to put the line, and forcing one in would be either an
   * entry after the archive or a swallowed failure dressed up as a notice. The
   * archive is its own announcement, and the room is closed to the reader anyway.
   *
   * @param roomId - The room whose waits are over.
   * @param authorId - One agent, or omitted for every agent in the room —
   *   which is what archiving means.
   */
  abandonHolds(roomId: string, authorId?: string): void {
    return holds.abandonHolds(this, roomId, authorId);
  }

  reportLeft(room: Room | null, collection: RoomCollection): void {
    return holds.reportLeft(this, room, collection);
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

  publishHold(record: HeldRecord, state: 'held' | 'done'): void {
    return holds.publishHold(this, record, state);
  }

  heldBehind(record: HeldRecord): RoomHeldBehind {
    return holds.heldBehind(this, record);
  }

  settleCollection(collection: RoomCollection, reason: HoldEnd): void {
    return holds.settleCollection(this, collection, reason);
  }

  retryWhenFree(room: Room, entry: RoomEntry, target: TriggerTarget): boolean {
    return holds.retryWhenFree(this, room, entry, target);
  }

  retryNow(roomId: string, entryId: string, target: TriggerTarget): void {
    return holds.retryNow(this, roomId, entryId, target);
  }

  private republishPresence(): void {
    return claims.republishPresence(this);
  }

  publishWorkingCount(roomId: string, before: number): void {
    return claims.publishWorkingCount(this, roomId, before);
  }

  publishPresence(
    claim: ActiveClaim,
    state: RoomPresenceState,
    outcome?: 'answered' | 'silent'
  ): void {
    return claims.publishPresence(this, claim, state, outcome);
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
   * **Public, and narrowly so.** Two readers outside this class want it: the room
   * context an agent's turn is handed, and `RoomWithRoster.workingAgents` — the room
   * read a person's app does when it opens a room. Both are answering the
   * same question a member is entitled to ask about a room they are in, and the
   * row carries an author id and a start time and nothing else. What a claim also
   * knows — its cascade, its dispatch id, the entry it answers, the checkout it
   * runs in — stays inside, exactly as {@link RoomTriggerDispatcher.workingCount}
   * describes.
   *
   * @param roomId - The room being described.
   * @returns One row per agent mid-turn there, oldest claim first. Empty when the
   *   room is idle.
   */
  workingIn(roomId: string): RoomWorkingClaim[] {
    return claimsWorkingIn(this.claimed, roomId);
  }

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

  /**
   * Every agent workspace with a turn running in it right now.
   *
   * An in-process seam for the room-worktree reap, which must not delete the
   * directory a live turn is standing in. Unlike
   * {@link RoomTriggerDispatcher.listClaims} this carries filesystem paths, so
   * it is deliberately not part of the diagnostic read surface.
   *
   * @returns Each distinct workspace path holding a claim.
   */
  busyAgentPaths(): string[] {
    return claimedAgentPaths(this.claimed);
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
  busyWith(roomId: string, authorId: string, agentPath: string): ClaimBusy | null {
    return claimBusyWith(
      this.claimed,
      roomId,
      authorId,
      agentPath,
      this.deps.maxConcurrentTurnsPerAgent()
    );
  }

  /**
   * Where this turn runs, and what to tell it about the room's files.
   *
   * **One call, because the answers are one decision.** The turn stands in the
   * agent's home; a room with files of its own also grants the agent's copy of
   * them and describes that copy — measured against the folder actually
   * granted, so the block can never describe a copy the turn cannot reach.
   * Every turn boundary in this file goes through here, so an ordinary turn
   * and a welcome-back aside are placed and described identically.
   *
   * **`agentPath` is both identity and desk now** (spec `agent-home-desk` §5.1):
   * the claim map, both busy ceilings and the runtime lookup key on it, and it
   * is where the turn stands. An agent working in room A still blocks its own
   * turn in room B.
   *
   * Never fails a turn: a room whose files cannot be opened is answered at home
   * with no files section, byte-identical to a room that has none.
   *
   * @param roomId - The room being answered.
   * @param agentPath - The agent's home.
   * @param displayName - The label the room shows for this agent; the readable
   *   half of its copy's folder name and nothing else.
   */
  placeTurn(roomId: string, agentPath: string, displayName: string): Promise<RoomTurnPlace> {
    return resolveRoomTurnPlace(this.deps.worktrees?.(), roomId, agentPath, displayName);
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
  halt(room: Room): Promise<number> {
    return halting.halt(this, room);
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
  haltAgent(room: Room, authorId: string, byAuthorId: string): Promise<number> {
    return halting.haltAgent(this, room, authorId, byAuthorId);
  }

  /** Move an agent's seat by hand. See {@link reseating.reseatByHand}. */
  reseatByHand(
    room: Room,
    agent: { authorId: string; agentPath: string; displayName: string },
    byAuthorId: string,
    accountId: string | undefined
  ): Promise<{ sessionId: string }> {
    return reseating.reseatByHand(this, room, agent, byAuthorId, accountId);
  }

  /** The accounts a seat may move to. See {@link reseating.reseatOptionsFor}. */
  reseatOptions(
    room: Room,
    agent: { authorId: string; agentPath: string }
  ): Promise<ReseatOptions> {
    return reseating.reseatOptionsFor(this, room, agent);
  }
}
