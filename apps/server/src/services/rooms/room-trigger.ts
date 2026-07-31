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
 * 2. **A target is claimed BEFORE its turn runs.** The ancestry rule reads the
 *    authors already in a cascade, which is a durable query — and an agent that
 *    has been triggered but has not answered yet is in the cascade without
 *    being in that table. Two `always` agents would each be triggered twice
 *    from one human message through that window. {@link RoomTriggerDispatcher}
 *    holds an in-flight claim per `(room, cascade, author)` and feeds it to the
 *    guard alongside the query, so the rule is the same rule whatever the
 *    scheduler does.
 *
 * 3. **Every way an agent can fail to answer is visible, and said once.** The
 *    guard refusing it, its session being busy, its turn failing: each writes a
 *    `notice` into the room. A silently dropped trigger is indistinguishable
 *    from a broken agent, and in a shared room the person who notices is not
 *    the person who configured it. But a notice per refusal is its own failure
 *    — over-participation, not silence, is what people complain about — so each
 *    is damped, and the two kinds are damped on DIFFERENT keys: the guard's per
 *    cascade, because that is what its rule is about, and a busy or failed
 *    agent's per `(room, agent)` until it answers again, because every message
 *    a person sends starts its own cascade and a cascade key would never
 *    collide. The one silence that stays silent is an agent that ran a turn and
 *    chose to say nothing, because that is conduct rather than a fault.
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
 * The turn itself is behind {@link RoomTurnRunner}, so this file has no
 * knowledge of sessions, runtimes or locks — `room-turn-runner.ts` holds that,
 * and a test supplies a runner that answers immediately.
 *
 * @module server/services/rooms/room-trigger
 */
import { randomUUID } from 'node:crypto';
import type { RoomContextData } from '@dorkos/shared/additional-context';
import type {
  Room,
  RoomEntry,
  RoomEntryBody,
  RoomPresencePayload,
  RoomPresenceState,
} from '@dorkos/shared/room-schemas';
import { logger } from '../../lib/logger.js';
import { selectTriggerTargets, type AddressingMember } from './addressing.js';
import type { AuthorRegistry } from './author-registry.js';
import { evaluateCascade } from './cascade-guard.js';
import { engagementFor, type EngagedWindow, type EngagementWindow } from './engagement.js';
import type { ReactionStore } from './reaction-store.js';
import { buildRoomContext } from './room-context.js';
import {
  buildBudgetNotice,
  buildBusyNotice,
  buildCascadeNotice,
  buildTurnFailedNotice,
  withLateAnswerNote,
} from './room-notices.js';
import type { RoomAgentLookup } from './room-errors.js';
import type { RoomStore } from './room-store.js';
import type { BudgetRefusalScope, RoomTurnBudget } from './turn-budget.js';

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
   * Where the turn is happening: the room, the roster, what the agent missed and
   * what is left to spend. Rides the runtime-neutral `additionalContext` bag
   * rather than the message (ADR-0273), so `entry.body.text` reaches the model
   * as exactly the words a person typed.
   */
  roomContext: RoomContextData;
}

/**
 * Why a turn produced no answer, when a member has to be told.
 *
 * Absent means the turn ran normally — a `null` `text` alongside no reason is
 * an agent that chose to stay quiet, which is conduct, not a fault, and the
 * room says nothing about it.
 *
 * - `busy` — another writer held the agent's session, so no turn ran.
 * - `failed` — a turn ran and ended in an error, or never finished at all.
 */
export type RoomTurnUnanswered = 'busy' | 'failed';

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
}

/**
 * How a post gets written back into the room.
 *
 * `replyTo` is what keeps an answer where the question was asked: an agent
 * triggered by a thread reply answers in that thread, not at the channel's top
 * level (ADR 260728-022013). Under the child-room shape the answer landed in the
 * thread for free, because the thread was the room.
 */
export interface RoomTriggerWriter {
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
  postNotice(
    roomId: string,
    body: RoomEntryBody,
    cascade: CascadeStamp,
    replyTo?: string
  ): RoomEntry;
}

/** The cascade a written entry belongs to. */
export interface CascadeStamp {
  root: string;
  depth: number;
}

/** Everything {@link RoomTriggerDispatcher} is constructed from. */
export interface RoomTriggerDeps {
  store: RoomStore;
  /** Read-only here: the room context reports acknowledgments, never writes one. */
  reactions: ReactionStore;
  authors: AuthorRegistry;
  agents: RoomAgentLookup;
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
 * How many keys either notice memory holds before forgetting the oldest.
 *
 * Notices are deduped in memory rather than by querying the log, because "has
 * the room already said Ana is busy?" is a question about a JSON body, and one
 * bounded set beats a `LIKE` over every entry. Losing a set on restart costs at
 * most one repeated line.
 */
const NOTICE_MEMORY = 512;

/**
 * Runs addressing, the cascade guard, and the turns that survive both.
 *
 * Construction is deliberately cheap and side-effect free: an install with no
 * rooms in it pays for one object.
 */
export class RoomTriggerDispatcher {
  private readonly deps: RoomTriggerDeps;

  /**
   * Turns in flight, keyed `(room, cascade, author)`.
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
   * `(room, cascade, author)` triples a CASCADE refusal notice has already
   * named. Bounded FIFO: a cascade is short-lived, so forgetting the oldest
   * costs at most one repeated line.
   *
   * Per CASCADE is the right lifetime for this one and the wrong one for the
   * set below — see its doc. The rooms spec says so directly: "one notice per
   * agent per cascade, not per refusal… a later cascade may legitimately
   * notice again."
   */
  private readonly noticedCascades = new Set<string>();

  /**
   * `(room, author)` pairs the room has already reported as not answering,
   * because the agent was busy or its turn failed.
   *
   * **Keyed on the agent, NOT the cascade, and that is the whole point.** Every
   * message a person sends starts its own cascade root, so a cascade-keyed
   * memory never collides for this case: four messages to a busy agent produced
   * four identical apologies while the doc beside them claimed one. That is the
   * same trap the depth-refusal branch in `claimTargets` is deliberately not
   * walking into, and it does not get a pass here because the copy is nicer.
   *
   * Re-armed on recovery rather than on a clock, the way {@link
   * RoomTriggerDispatcher.noticedBudget} re-arms: the moment that agent takes a
   * turn in that room without a reason to refuse it, the block is over and the
   * NEXT one is news again. No timer, no staleness, and nothing to tune.
   */
  private readonly noticedSilence = new Set<string>();

  /**
   * Rooms that have already been told they are out of budget.
   *
   * Separate from the set above, with a different lifetime and a different key
   * shape, because it answers a different question. Sharing one FIFO meant
   * budget keys were evicted non-deterministically by ordinary refusal traffic,
   * AND — worse — a room that was told once was never told again, since nothing
   * ever cleared the entry. A room silently refusing to reply after its first
   * hour is exactly the state a notice exists to prevent.
   *
   * Cleared the moment the room can spend again ({@link
   * RoomTriggerDispatcher.claimTargets} on a successful reserve), so the next
   * exhaustion speaks up. No clock needed: recovery IS the re-arm.
   */
  private readonly noticedBudget = new Set<string>();

  /** In-flight dispatches, so {@link RoomTriggerDispatcher.idle} can wait them out. */
  private inFlight = 0;
  private settled: Array<() => void> = [];

  constructor(deps: RoomTriggerDeps) {
    this.deps = deps;
  }

  /**
   * Trigger whoever this entry addresses. Returns immediately: posting is
   * trigger-only (ADR-0264), so the HTTP 202 must not wait on a model call.
   *
   * @param room - The room the entry landed in.
   * @param entry - The committed entry.
   */
  dispatch(room: Room, entry: RoomEntry): void {
    // A notice is the room talking about itself. Letting it address anyone would
    // make "Ana stopped replying" a reason for Bo to start.
    if (entry.kind !== 'post') return;

    const targets = this.claimTargets(room, entry);
    if (targets.length === 0) return;

    this.inFlight += 1;
    void Promise.all(targets.map((target) => this.runOne(room, entry, target))).finally(() =>
      this.settleOne()
    );
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
   * Select this entry's targets, run each past the guard, write a notice for
   * every refusal, and claim the survivors.
   *
   * Evaluation happens for ALL targets before any of them is claimed, so two
   * agents addressed by the same message do not cancel each other out — they
   * were both addressed by a message neither of them wrote.
   */
  private claimTargets(room: Room, entry: RoomEntry): TriggerTarget[] {
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
    for (const member of members) {
      const record = records.get(member.authorId);
      if (!record) continue;
      // Only an `engaged` agent that did not write this entry can be inside a
      // window, so no other membership pays for the query.
      const open =
        record.kind === 'agent' &&
        member.responseMode === 'engaged' &&
        member.authorId !== entry.authorId
          ? engagementFor(this.deps, {
              roomId: room.id,
              threadRootEntryId,
              authorId: member.authorId,
              window,
              now,
            })
          : null;
      if (open) engaged.set(member.authorId, open);
      addressing.push({
        authorId: member.authorId,
        kind: record.kind,
        responseMode: member.responseMode,
        isEngaged: open !== null,
      });
    }

    const selected = selectTriggerTargets({ roomKind: room.kind, entry, members: addressing });
    if (selected.length === 0) return [];

    const provenance = {
      root: entry.cascadeRoot,
      depth: entry.cascadeDepth,
      authorsInCascade: [
        ...this.deps.store.authorsInCascade(room.id, entry.cascadeRoot),
        ...this.claimsIn(room.id, entry.cascadeRoot),
      ],
    };
    const maxAgentDepth = this.deps.maxAgentDepth();

    const allowed: TriggerTarget[] = [];
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
        //   2. The `(room, cascade, author)` damping key CANNOT repeat here,
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
        const fromRealChain = entry.cascadeRoot !== entry.id;
        if (decision.reason === 'ancestry' || fromRealChain) {
          const name = record?.displayName ?? 'An agent';
          this.announce(room, entry, authorId, buildCascadeNotice(name, authorId));
        }
        continue;
      }
      // `naturalKey` is the agentPath — the only handle the turn machinery needs
      // and the one thing that survives a mesh reconciler rebuild.
      if (!record || record.kind !== 'agent') continue;
      allowed.push({
        authorId,
        agentPath: record.naturalKey,
        displayName: record.displayName,
        depth: decision.depth,
        engaged: engaged.get(authorId) ?? null,
        // Replaced with the real binding once the budget has been charged; a
        // target that never becomes affordable never mints a session.
        sessionId: '',
      });
    }

    // The cascade guard has allowed these on the merits. The budget is the
    // second, blunter question — can this ROOM afford another automatic turn at
    // all — and it is asked without reference to who wrote the entry, so a
    // caller who reached depth 0 by claiming to be human still stops here.
    const affordable: TriggerTarget[] = [];
    for (const target of allowed) {
      const decision = this.deps.budget.tryReserve(room.id);
      if (decision.allowed) {
        // Spending again means the window moved, so re-arm the notice: the next
        // exhaustion is news, not a repeat.
        this.noticedBudget.delete(room.id);
        affordable.push(target);
        continue;
      }
      this.writeBudgetNotice(room, entry, decision.scope ?? 'room');
      break;
    }

    // Bind every session BEFORE claiming any of them, in two passes rather than
    // one. The binds are SQLite writes and can throw; the claims cannot. Taken in
    // one pass, a failure on the second target left the first one claimed with no
    // turn coming — which used to be a stale entry in a map, and is now an
    // indicator saying an agent is working, re-stated every ten seconds forever.
    // That is the one shape the client's TTL cannot rescue, because a republished
    // claim never goes stale. Two passes make it unreachable instead of handled.
    for (const target of affordable) {
      // Bind the session HERE, not after the turn. Reading the binding inside
      // `runOne` and writing it on completion left a window: two posts before
      // the first reply both saw `null`, both minted a UUID, and the second
      // lost the `onConflictDoNothing` race — leaving a real session with its
      // own projector and `session_metadata` row bound to nothing, whose reply
      // was produced from an empty context. `bindRoomSession` returns the
      // WINNER, so claiming resolves the race to one session per (room, agent).
      //
      // The id minted here is a PLACEHOLDER on the first turn: the runtime may
      // hand back its own, and {@link RoomStore.rebindRoomSession} in `runOne`
      // moves the binding onto it the moment the turn reports. Racing safely and
      // remembering correctly are two different jobs; this one is the race.
      target.sessionId = this.deps.store.bindRoomSession(
        room.id,
        target.authorId,
        this.deps.store.getRoomSession(room.id, target.authorId) ?? randomUUID(),
        new Date().toISOString()
      );
    }
    for (const target of affordable) {
      this.holdClaim({
        roomId: room.id,
        cascadeRoot: entry.cascadeRoot,
        authorId: target.authorId,
        entryId: entry.id,
        depth: target.depth,
        claimedAt: new Date().toISOString(),
        pastDeadline: false,
      });
    }
    return affordable;
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
    let active: CascadeStamp | undefined;
    for (const claim of this.claimed.values()) {
      if (claim.authorId !== authorId) continue;
      if (!active || claim.depth > active.depth) {
        active = { root: claim.cascadeRoot, depth: claim.depth };
      }
    }
    return active;
  }

  /** Run one agent's turn and post whatever it said back into the room. */
  private async runOne(room: Room, entry: RoomEntry, target: TriggerTarget): Promise<void> {
    const key = claimKey(room.id, entry.cascadeRoot, target.authorId);
    try {
      const result = await this.deps.runner.run({
        room,
        authorId: target.authorId,
        agentPath: target.agentPath,
        sessionId: target.sessionId,
        entry,
        // Derived HERE rather than in the runner, and after every target of this
        // entry has been claimed: `working` is read off the live claim map, so a
        // second agent addressed by the same message is already in it. Assembling
        // it runs no model and takes no turn — silence has to stay free
        // (`meta/agent-etiquette.md` E7).
        roomContext: buildRoomContext(this.deps, {
          room,
          agentAuthorId: target.authorId,
          entry,
          working: this.workingIn(room.id),
          budget: this.deps.budget.remaining(room.id),
          repliesLeftInThisChain: Math.max(0, this.deps.maxAgentDepth() - target.depth),
          engaged: target.engaged,
        }),
      });

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
      }
      this.deliver({ room, entry, target, reply: result, sessionId: result.sessionId });
    } catch (err) {
      // The failure detail belongs on the agent's own session stream, where the
      // turn machinery already surfaces it — a room log is no place for a stack
      // trace. But the FACT belongs here: a turn that threw and said nothing is
      // indistinguishable from an agent that ignored you (DOR-621).
      logger.warn('[rooms] triggered turn failed', {
        roomId: room.id,
        authorId: target.authorId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.reportSilence(room, entry, target, 'failed');
    } finally {
      // `runner.run()` resolving is the end of the WAIT, which is only the end
      // of the TURN when the turn beat the deadline. A late turn is still
      // running and must still read as working — to the guard, to a room-mate
      // reading `room_context.working`, and to the person watching.
      // {@link RoomTriggerDispatcher.deliverLate} releases it when the answer
      // finally settles, whichever way it settles.
      if (this.claimed.get(key)?.pastDeadline !== true) this.releaseClaim(key);
    }
  }

  /**
   * Put one turn's outcome into the room: the answer, or why there is none.
   *
   * @param opts.reply - What the turn produced, from the runner.
   * @param opts.sessionId - The session it ran on, carried onto the post.
   * @param opts.late - Set on a late answer, so the post can say which message
   *   it is answering and how long it took.
   */
  private deliver(opts: {
    room: Room;
    entry: RoomEntry;
    target: TriggerTarget;
    reply: RoomTurnReply;
    sessionId: string;
    late?: { waitedMs: number };
  }): void {
    const { room, entry, target, reply } = opts;
    if (reply.unanswered) {
      this.reportSilence(room, entry, target, reply.unanswered);
      return;
    }

    // The turn ran and nothing refused it, so whatever was blocking this agent
    // here is over. Recovery IS the re-arm: the next time it cannot answer, the
    // room says so again.
    this.noticedSilence.delete(silenceKey(room.id, target.authorId));

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
    if (!said) return;
    const text =
      opts.late === undefined
        ? said
        : withLateAnswerNote(said, { waitedMs: opts.late.waitedMs, question: entry.body.text });
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
  }

  /**
   * Post an answer the room stopped waiting for, once it lands — and release
   * the claim that has been saying, all along, that the agent is still on it.
   *
   * The turn was never cancelled, so this is the answer to a real question that
   * a real person asked — it goes in, saying how long it took. The claim on
   * `(room, cascade, author)` is still held when this runs (see
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
    const key = claimKey(opts.room.id, opts.entry.cascadeRoot, opts.target.authorId);
    this.inFlight += 1;
    void opts.late
      .then((reply) =>
        this.deliver({
          room: opts.room,
          entry: opts.entry,
          target: opts.target,
          reply,
          sessionId: opts.sessionId,
          late: { waitedMs: reply.waitedMs },
        })
      )
      .catch((err) => {
        logger.warn('[rooms] a late answer never landed', {
          roomId: opts.room.id,
          authorId: opts.target.authorId,
          error: err instanceof Error ? err.message : String(err),
        });
        // An infrastructure failure this deep into a turn used to leave a log
        // line and nothing else: the room had shown the agent working for up to
        // an hour and then simply stopped, with no answer and nothing on the log
        // to explain either. It gets the same damped `turn_failed` notice every
        // other failure gets — best-effort, and damped on `(room, agent)` like
        // the rest, so a run of them is still one line.
        this.reportSilence(opts.room, opts.entry, opts.target, 'failed');
      })
      .finally(() => {
        this.releaseClaim(key);
        this.settleOne();
      });
  }

  /**
   * Say once, until that agent answers again, that it did not answer here.
   *
   * The damping key is `(room, agent)`, never the cascade. A person sending
   * four messages to a busy agent mints four cascade roots, so a cascade-keyed
   * memory would put four apologies in the room while claiming to write one —
   * the exact over-participation this whole programme exists to prevent (E17).
   * The block clears the moment that agent takes a turn there, in {@link
   * RoomTriggerDispatcher.deliver}.
   *
   * @param reason - Why it stayed quiet, which picks the words.
   */
  private reportSilence(
    room: Room,
    entry: RoomEntry,
    target: TriggerTarget,
    reason: RoomTurnUnanswered
  ): void {
    const key = silenceKey(room.id, target.authorId);
    if (this.noticedSilence.has(key)) return;
    const body =
      reason === 'busy'
        ? buildBusyNotice(target.displayName, target.authorId)
        : buildTurnFailedNotice(target.displayName, target.authorId);
    if (this.writeNotice(room, entry, target.authorId, body)) {
      remember(this.noticedSilence, key);
    }
  }

  /**
   * Say once, per agent per cascade, that the guard stopped an exchange.
   *
   * Per cascade because that is what the rule is about: this conversation went
   * around enough times, and a later one may legitimately say so again (rooms
   * spec §6). Deliberately a different memory from {@link
   * RoomTriggerDispatcher.noticedSilence}, which answers a different question
   * with a different lifetime.
   *
   * @param body - The notice copy, from `room-notices.ts`.
   */
  private announce(room: Room, entry: RoomEntry, authorId: string, body: RoomEntryBody): void {
    const key = claimKey(room.id, entry.cascadeRoot, authorId);
    if (this.noticedCascades.has(key)) return;
    // Remembered only once it is actually in the log. Marking first meant a
    // cascade whose FIRST notice threw went silent for good — precisely the
    // state the notice exists to prevent.
    if (this.writeNotice(room, entry, authorId, body)) remember(this.noticedCascades, key);
  }

  /**
   * Write one notice into the room, reporting whether it landed.
   *
   * @returns `false` when the write failed, so no caller records a line the
   *   room never got.
   */
  private writeNotice(
    room: Room,
    entry: RoomEntry,
    authorId: string | null,
    body: RoomEntryBody
  ): boolean {
    try {
      this.deps.writer.postNotice(
        room.id,
        body,
        { root: entry.cascadeRoot, depth: entry.cascadeDepth },
        // Reported where the exchange happened. A refusal at the channel's top
        // level, about a back-and-forth three replies deep inside a thread, is a
        // notice the reader cannot connect to anything.
        entry.threadRootEntryId ?? undefined
      );
      return true;
    } catch (err) {
      // Refusals are evaluated synchronously inside `post`, so a throw here
      // would surface as a failure of the message that was already committed —
      // the poster would see their own successful post 500. The room being
      // archived between the post and the notice is the reachable case.
      logger.warn('[rooms] could not write a room notice', {
        roomId: room.id,
        authorId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Say once, per exhaustion, that the room is out of automatic turns.
   *
   * Keyed on the ROOM rather than the cascade, because the budget is a property
   * of the room: a caller minting a fresh cascade per message would otherwise
   * get a fresh notice per message, turning the thing that reports a flood into
   * part of it. Re-armed as soon as the room can spend again, so "once" means
   * once per exhaustion and not once ever.
   *
   * @param scope - Which cap refused, so the copy points at the right setting.
   */
  private writeBudgetNotice(room: Room, entry: RoomEntry, scope: BudgetRefusalScope): void {
    if (this.noticedBudget.has(room.id)) return;
    if (this.writeNotice(room, entry, null, buildBudgetNotice(scope))) {
      this.noticedBudget.add(room.id);
    }
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
   * to release one: an author already claimed in a cascade is in the guard's
   * in-flight union ({@link RoomTriggerDispatcher.claimsIn}), so it is refused
   * before it can be selected a second time under the same key.
   *
   * @param claim - The claim being taken, already fully resolved.
   */
  private holdClaim(claim: ActiveClaim): void {
    const before = this.workingCount(claim.roomId);
    this.claimed.set(claimKey(claim.roomId, claim.cascadeRoot, claim.authorId), claim);
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
   * nothing — and on the client it would clear an indicator belonging to some
   * other live claim for the same agent.
   *
   * @param key - The `(room, cascade, author)` key being released.
   */
  private releaseClaim(key: string): void {
    const claim = this.claimed.get(key);
    if (!claim) return;
    const before = this.workingCount(claim.roomId);
    this.claimed.delete(key);
    this.publishPresence(claim, 'done');
    this.publishWorkingCount(claim.roomId, before);
    if (this.republishing !== null && this.claimed.size === 0) {
      clearInterval(this.republishing);
      this.republishing = null;
    }
  }

  /**
   * Re-state every live claim, on the interval.
   *
   * **One event per CLAIM, not per agent** — deliberately, and differently from
   * {@link RoomTriggerDispatcher.workingIn}, which collapses an agent's claims
   * to one name. The two answer different questions. `workingIn` writes a
   * sentence for a model to read, where "Ana, Ana" is noise. This writes the
   * indicator's identity, `(room, author, entryId)`, and the client keys its
   * store on exactly that so it can render one name while tracking both claims
   * (room-presence spec §3.2, §5.1). Collapsing here would break the release: a
   * `done` for one of an agent's two claims would be indistinguishable from a
   * `done` for both, and DOR-752's double-cascade case would strand or
   * prematurely clear an indicator that is still true.
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
   * **One entry per agent, at its earliest claim.** The map's grain is
   * `(room, cascade, author)`, so one agent can legitimately hold several claims
   * here at once — the shipped `engaged` default produces it on the ordinary
   * path, when a held-late agent is re-triggered by the next message inside its
   * window. Walking the map raw then said the same name twice, and the roster
   * block an agent reads rendered "Working right now: Ana, Ana". A reader wants
   * to know Ana is busy and since when, not how many claims the scheduler is
   * holding, so the count collapses and the OLDEST `since` wins — an elapsed
   * time must measure how long the agent has been working, not how long ago it
   * was most recently interrupted.
   *
   * ISO-8601 strings from `toISOString()` are fixed-width and UTC, so `<` on the
   * string is `<` on the instant. No parsing, no clock.
   *
   * @param roomId - The room being described.
   */
  private workingIn(roomId: string): Array<{ authorId: string; since: string }> {
    const earliest = new Map<string, string>();
    for (const claim of this.claimed.values()) {
      if (claim.roomId !== roomId) continue;
      const seen = earliest.get(claim.authorId);
      if (seen === undefined || claim.claimedAt < seen)
        earliest.set(claim.authorId, claim.claimedAt);
    }
    return [...earliest].map(([authorId, since]) => ({ authorId, since }));
  }

  /**
   * How many agents are working in one room right now.
   *
   * The narrow read the room list and the `room_presence` fan-out are given, in
   * place of the claim map itself: a count cannot be mistaken for a roster, and
   * no caller outside this class can start reasoning about cascades, sessions or
   * entry ids it has no business knowing. Distinct AGENTS, not claims — the
   * sidebar answers "is anyone on it", and an agent answering two triggers is
   * one busy agent.
   *
   * @param roomId - The room being asked about.
   * @returns The number of distinct agents holding a claim there. `0` when idle.
   */
  workingCount(roomId: string): number {
    return this.workingIn(roomId).length;
  }

  /**
   * Author ids with a turn in flight in one cascade.
   *
   * Unioned with the durable ancestry query, so the guard reads the same rule
   * whether an agent has already answered or is still answering. Holding a claim
   * past the wait deadline strengthens that union in one visible way: an author
   * whose late turn ends up saying nothing never lands a durable stamp, so a
   * re-trigger of it in the same cascade during the late window is now refused
   * where it once bought a second turn. That refusal is correct — the author
   * really does have a turn in flight on that `(room, agent)` session — and it is
   * pinned in `room-presence-claims.test.ts` rather than left to be rediscovered.
   *
   * @param roomId - The room the cascade is running in.
   * @param cascadeRoot - The entry the exchange began at.
   */
  private claimsIn(roomId: string, cascadeRoot: string): string[] {
    const authors: string[] = [];
    for (const claim of this.claimed.values()) {
      if (claim.roomId === roomId && claim.cascadeRoot === cascadeRoot) {
        authors.push(claim.authorId);
      }
    }
    return authors;
  }
}

/**
 * One turn in flight: which cascade it belongs to, how deep it sits, what it is
 * answering, and whether the room has stopped waiting for it.
 *
 * A claim is taken before its turn runs and released when that turn reaches a
 * terminal — an answer, a notice, or the agent choosing to say nothing. It is
 * the only live record that an agent is working, so three readers depend on it
 * today, and holding it for the whole turn changed what each of them sees:
 *
 * 1. {@link RoomTriggerDispatcher.claimsIn} — the cascade guard's in-flight
 *    union. A late turn that ends up silent is now in the cascade it is
 *    answering, so it cannot be triggered again inside that cascade.
 * 2. {@link RoomTriggerDispatcher.workingIn} — `room_context.working`. A late
 *    turn is now reported, once per agent, from its earliest claim.
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
interface ActiveClaim {
  roomId: string;
  cascadeRoot: string;
  authorId: string;
  /**
   * The entry whose trigger this claim answers. NOT interchangeable with
   * `cascadeRoot`: the two coincide only at depth 0, and every deeper hop
   * answers a reply rather than the message that began the exchange.
   */
  entryId: string;
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

/** One agent that survived the guard, with the depth its reply will carry. */
interface TriggerTarget {
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
 * A `(room, cascade, author)` key, for map identity only. Nothing parses it back
 * apart; every reader goes through the {@link ActiveClaim} value instead.
 */
function claimKey(roomId: string, cascadeRoot: string, authorId: string): string {
  return [roomId, cascadeRoot, authorId].join(CLAIM_KEY_SEPARATOR);
}

/**
 * A `(room, agent)` key: what the room has already said about one agent being
 * unable to answer, with no cascade in it. The absence of the cascade is the
 * whole design — see `noticedSilence`.
 */
function silenceKey(roomId: string, authorId: string): string {
  return [roomId, authorId].join(CLAIM_KEY_SEPARATOR);
}

/**
 * Record a key, evicting the oldest when the set is full.
 *
 * Bounded because these sets are only ever added to by traffic: a room nobody
 * is watching should not be able to grow one without limit.
 *
 * @param seen - The FIFO set to record into.
 * @param key - The key that just earned its place.
 */
function remember(seen: Set<string>, key: string): void {
  if (seen.size >= NOTICE_MEMORY) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  seen.add(key);
}
