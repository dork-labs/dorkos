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
 * 4. **A slow turn is late, never lost.** When a turn outruns the room's wait
 *    the room stops waiting, not the turn — the answer is posted when it lands,
 *    saying how long it took (room-participation spec, §5 edge case 6).
 *
 * The turn itself is behind {@link RoomTurnRunner}, so this file has no
 * knowledge of sessions, runtimes or locks — `room-turn-runner.ts` holds that,
 * and a test supplies a runner that answers immediately.
 *
 * @module server/services/rooms/room-trigger
 */
import { randomUUID } from 'node:crypto';
import type { Room, RoomEntry, RoomEntryBody } from '@dorkos/shared/room-schemas';
import { logger } from '../../lib/logger.js';
import { selectTriggerTargets, type AddressingMember } from './addressing.js';
import type { AuthorRegistry } from './author-registry.js';
import { evaluateCascade } from './cascade-guard.js';
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
  /** The agent's rendered name, for the prompt's framing. */
  displayName: string;
  /** The session bound to this `(room, agent)`, or `null` on its first answer. */
  sessionId: string | null;
  /** The entry that triggered this turn. */
  entry: RoomEntry;
  /** Who wrote that entry, rendered. */
  authorName: string;
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

/** How a post gets written back into the room. */
export interface RoomTriggerWriter {
  post(
    roomId: string,
    input: { authorId: string; text: string; sessionId?: string; trigger: CascadeStamp }
  ): RoomEntry;
  postNotice(roomId: string, body: RoomEntryBody, cascade: CascadeStamp): RoomEntry;
}

/** The cascade a written entry belongs to. */
export interface CascadeStamp {
  root: string;
  depth: number;
}

/** Everything {@link RoomTriggerDispatcher} is constructed from. */
export interface RoomTriggerDeps {
  store: RoomStore;
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
}

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
    const addressing: AddressingMember[] = [];
    for (const member of members) {
      const record = records.get(member.authorId);
      if (!record) continue;
      addressing.push({
        authorId: member.authorId,
        kind: record.kind,
        responseMode: member.responseMode,
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

    for (const target of affordable) {
      // Bind the session HERE, not after the turn. Reading the binding inside
      // `runOne` and writing it on completion left a window: two posts before
      // the first reply both saw `null`, both minted a UUID, and the second
      // lost the `onConflictDoNothing` race — leaving a real session with its
      // own projector and `session_metadata` row bound to nothing, whose reply
      // was produced from an empty context. `bindRoomSession` returns the
      // WINNER, so claiming resolves the race to one session per (room, agent).
      target.sessionId = this.deps.store.bindRoomSession(
        room.id,
        target.authorId,
        this.deps.store.getRoomSession(room.id, target.authorId) ?? randomUUID(),
        new Date().toISOString()
      );
      this.claimed.set(claimKey(room.id, entry.cascadeRoot, target.authorId), {
        roomId: room.id,
        cascadeRoot: entry.cascadeRoot,
        authorId: target.authorId,
        depth: target.depth,
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
      const author = this.deps.authors.getById(entry.authorId);
      const result = await this.deps.runner.run({
        room,
        authorId: target.authorId,
        agentPath: target.agentPath,
        displayName: target.displayName,
        sessionId: target.sessionId,
        entry,
        authorName: author?.displayName ?? 'Someone',
      });

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
      this.claimed.delete(key);
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
    });
  }

  /**
   * Post an answer the room stopped waiting for, once it lands.
   *
   * The turn was never cancelled, so this is the answer to a real question that
   * a real person asked — it goes in, saying how long it took. The claim on
   * `(room, cascade, author)` is already gone by then, which is correct: the
   * cascade stamp is passed explicitly, so the guard still sees the hop.
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
      })
      .finally(() => this.settleOne());
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
      this.deps.writer.postNotice(room.id, body, {
        root: entry.cascadeRoot,
        depth: entry.cascadeDepth,
      });
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

  /** Author ids with a turn in flight in one cascade. */
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

/** One turn in flight: which cascade it belongs to, and how deep it sits. */
interface ActiveClaim {
  roomId: string;
  cascadeRoot: string;
  authorId: string;
  depth: number;
}

/** One agent that survived the guard, with the depth its reply will carry. */
interface TriggerTarget {
  authorId: string;
  agentPath: string;
  displayName: string;
  depth: number;
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
