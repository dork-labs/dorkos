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
 * 3. **A refusal is visible.** It writes a `notice` into the room, once per
 *    agent per cascade. A silently dropped trigger is indistinguishable from a
 *    broken agent, and in a shared room the person who notices is not the
 *    person who configured it.
 *
 * The turn itself is behind {@link RoomTurnRunner}, so this file has no
 * knowledge of sessions, runtimes or locks — `room-turn-runner.ts` holds that,
 * and a test supplies a runner that answers immediately.
 *
 * @module server/services/rooms/room-trigger
 */
import type { Room, RoomEntry, RoomEntryBody } from '@dorkos/shared/room-schemas';
import { logger } from '../../lib/logger.js';
import { selectTriggerTargets, type AddressingMember } from './addressing.js';
import type { AuthorRegistry } from './author-registry.js';
import { buildCascadeNotice, evaluateCascade } from './cascade-guard.js';
import type { RoomAgentLookup } from './room-errors.js';
import type { RoomStore } from './room-store.js';

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

/** What one agent turn produced. */
export interface RoomTurnResult {
  /**
   * The session the turn ran on. Bound to `(room, agent)` first-write-wins, so
   * an agent keeps one thread of context per room.
   */
  sessionId: string;
  /** What the agent said, or `null` when it said nothing worth posting. */
  text: string | null;
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
  /** The live `rooms.maxAgentDepth`, read per dispatch so a change takes effect. */
  maxAgentDepth(): number;
}

/**
 * How many `(room, cascade, author)` refusals to remember before forgetting the
 * oldest. Refusal notices are deduped in memory rather than by querying the log,
 * because "has this cascade already said Ana stopped?" is a question about a
 * JSON body, and one bounded set beats a `LIKE` over every entry. Losing the set
 * on restart costs at most one repeated notice in a cascade that survived a
 * restart, which is not a thing that happens.
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

  /** `(room, cascade, author)` triples with a turn in flight — rule 2 above. */
  private readonly claimed = new Set<string>();

  /** `(room, cascade, author)` triples a refusal notice has already named. */
  private readonly noticed = new Set<string>();

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
    void Promise.all(targets.map((target) => this.runOne(room, entry, target))).finally(() => {
      this.inFlight -= 1;
      if (this.inFlight === 0) {
        const waiters = this.settled;
        this.settled = [];
        for (const resolve of waiters) resolve();
      }
    });
  }

  /**
   * Resolve once no triggered turn is in flight.
   *
   * Exists for tests and for a graceful shutdown: a cascade is asynchronous by
   * construction, so "did the room settle" is otherwise unanswerable without a
   * sleep, and a test that sleeps is a test that flakes.
   */
  idle(): Promise<void> {
    if (this.inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => this.settled.push(resolve));
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
        this.writeRefusalNotice(room, entry, authorId, record?.displayName ?? 'An agent');
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
      });
    }

    for (const target of allowed) {
      this.claimed.add(claimKey(room.id, entry.cascadeRoot, target.authorId));
    }
    return allowed;
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
        sessionId: this.deps.store.getRoomSession(room.id, target.authorId),
        entry,
        authorName: author?.displayName ?? 'Someone',
      });

      // Bind before posting. The binding is what the NEXT turn resumes on, and
      // a reply that landed against a session nothing remembers would make the
      // agent start from nothing every time it answered.
      this.deps.store.bindRoomSession(
        room.id,
        target.authorId,
        result.sessionId,
        new Date().toISOString()
      );

      const text = result.text?.trim();
      if (!text) return;
      this.deps.writer.post(room.id, {
        authorId: target.authorId,
        text,
        sessionId: result.sessionId,
        trigger: { root: entry.cascadeRoot, depth: target.depth },
      });
    } catch (err) {
      // A runtime that fails is not a cascade refusal, so it writes no notice:
      // the failure belongs on the agent's own session stream, where the turn
      // machinery already surfaces it, and duplicating it here would put a
      // stack-trace-shaped event in a room's permanent record.
      logger.warn('[rooms] triggered turn failed', {
        roomId: room.id,
        authorId: target.authorId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.claimed.delete(key);
    }
  }

  /** Write the room's "they stopped replying" notice, at most once per cascade. */
  private writeRefusalNotice(
    room: Room,
    entry: RoomEntry,
    authorId: string,
    displayName: string
  ): void {
    const key = claimKey(room.id, entry.cascadeRoot, authorId);
    if (this.noticed.has(key)) return;
    if (this.noticed.size >= NOTICE_MEMORY) {
      const oldest = this.noticed.values().next().value;
      if (oldest !== undefined) this.noticed.delete(oldest);
    }
    this.noticed.add(key);
    this.deps.writer.postNotice(room.id, buildCascadeNotice(displayName, authorId), {
      root: entry.cascadeRoot,
      depth: entry.cascadeDepth,
    });
  }

  /** Author ids with a turn in flight in one cascade. */
  private claimsIn(roomId: string, cascadeRoot: string): string[] {
    const prefix = `${roomId} ${cascadeRoot} `;
    const authors: string[] = [];
    for (const key of this.claimed) {
      if (key.startsWith(prefix)) authors.push(key.slice(prefix.length));
    }
    return authors;
  }
}

/** One agent that survived the guard, with the depth its reply will carry. */
interface TriggerTarget {
  authorId: string;
  agentPath: string;
  displayName: string;
  depth: number;
}

/**
 * A `(room, cascade, author)` key. Joined on a space, which no id here can
 * contain — room ids, entry ids and author ids are all ULIDs (Crockford
 * base32), so no value can forge a boundary and make one cascade's claim read
 * as another's.
 */
function claimKey(roomId: string, cascadeRoot: string, authorId: string): string {
  return `${roomId} ${cascadeRoot} ${authorId}`;
}
