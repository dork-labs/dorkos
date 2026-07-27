/**
 * Bounds agent-to-agent loops on the room path (spec `rooms` §6,
 * ADR 260726-170127).
 *
 * The relay's budget envelope does not reach here. `enforceBudget` has exactly
 * two call sites, both inside `packages/relay`, and nothing in
 * `services/session` constructs an envelope — the budget is a property of the
 * relay transport, not of the session spine, so a room built on the durable log
 * inherits none of it. Routing room triggers through the relay to borrow the
 * guard would re-add the per-endpoint file writes and per-endpoint watchers the
 * multi-user research already rejected, to buy thirty lines of arithmetic.
 *
 * Two rules, and the second is the load-bearing one. A pure depth counter
 * permits N-1 wasted model calls before it fires; the ancestry rule kills
 * A→B→A at the first repeat.
 *
 * Pure — the caller supplies the provenance it read, and the ceiling it is
 * measuring against. There is deliberately no default ceiling here: the number
 * lives in `rooms.maxAgentDepth` (user config), and a second copy in this file
 * would be the one somebody edits when the real one is elsewhere.
 *
 * `room-trigger.ts` is the production caller.
 *
 * @module server/services/rooms/cascade-guard
 */
import type { AuthorKind, RoomEntryBody } from '@dorkos/shared/room-schemas';

/** Why a trigger was refused. */
export type CascadeRefusalReason = 'depth' | 'ancestry';

/**
 * The provenance a trigger carries, read off the entry that would trigger it
 * plus one indexed query over the cascade.
 */
export interface CascadeProvenance {
  /** Entry id that began this cascade — `cascadeRoot` of the triggering entry. */
  root: string;
  /** `cascadeDepth` of the triggering entry. The triggered turn inherits this + 1. */
  depth: number;
  /**
   * Distinct author ids already in this cascade
   * (`SELECT DISTINCT author_id FROM room_entries WHERE room_id = ? AND cascade_root = ?`).
   */
  authorsInCascade: readonly string[];
}

/** The verdict on one prospective trigger. */
export interface CascadeDecision {
  allowed: boolean;
  /** The depth the triggered turn would carry (`provenance.depth + 1`). */
  depth: number;
  /** Set only when `allowed` is false. */
  reason?: CascadeRefusalReason;
}

/**
 * Decide whether `targetAuthorId` may be triggered from an entry with this
 * provenance.
 *
 * @param targetAuthorId - The agent author the trigger would run.
 * @param provenance - The triggering entry's cascade root, depth, and prior authors.
 * @param opts.maxAgentDepth - How many automatic replies deep a cascade may run
 *   (`rooms.maxAgentDepth`). Required: this module holds no default, so the
 *   number a person can change is the only one in play.
 * @returns Whether to trigger, the depth it would carry, and the refusal reason.
 */
export function evaluateCascade(
  targetAuthorId: string,
  provenance: CascadeProvenance,
  opts: { maxAgentDepth: number }
): CascadeDecision {
  const { maxAgentDepth } = opts;
  const depth = provenance.depth + 1;

  if (depth > maxAgentDepth) return { allowed: false, depth, reason: 'depth' };
  if (provenance.authorsInCascade.includes(targetAuthorId)) {
    return { allowed: false, depth, reason: 'ancestry' };
  }
  return { allowed: true, depth };
}

/**
 * Where a post's own cascade begins.
 *
 * **Gated on who is writing, never on how the call was shaped.** Spec §6 grants
 * a fresh cascade to a **human** post, and only to that: it is what lets a
 * person re-engage a room the guard has stopped, and it is a person's
 * prerogative because a person is who the budget belongs to.
 *
 * **What `authorKind` is worth, precisely.** It is as good as the answer to
 * "who is calling", and in the DEFAULT posture that answer is weak: with
 * `auth.enabled` off, `resolveCaller` reads a request carrying no
 * `X-DorkOS-Agent` header as the local human, so a program on this machine
 * becomes `'human'` here by *omitting* a header. That is the documented DOR-505
 * residual (`lib/caller-authority.ts` names the same move) and it is not
 * closable from this module — with login off there is nothing left to tell a
 * local program from the person at the keyboard.
 *
 * So this rule is the precise one, not the last one. `turn-budget.ts` carries
 * the bound that does not ask who is calling, and it is what actually caps
 * spend in the default posture. Do not read the sentence above as a promise
 * that an agent cannot reach depth 0; read it as the rule that holds whenever
 * identity means anything.
 *
 * An earlier revision keyed the fresh start on whether a `trigger` argument was
 * passed, which reads as the same rule and is not. `POST /api/rooms/:id/entries`
 * passes no trigger and resolves an `X-DorkOS-Agent` bearer to that agent — and
 * the token sits in every spawned session's environment — so any agent with a
 * shell could mint `cascadeDepth: 0` at will. Measured: two `always` agents
 * posting through that path ran 30 hops, 30 turns, 30 distinct cascade roots,
 * max depth 0 and not one refusal notice. Unbounded by depth, unbounded by
 * ancestry, invisible in the room, one model call per hop. This is the exact
 * failure ADR 260726-170127 predicted — "a path that forgets to carry it is
 * unguarded and looks fine in tests".
 *
 * So an agent writing with no provenance behind it starts a cascade that is
 * already spent: its own id, stamped AT the ceiling. The entry is durable and
 * readable like any other, and anything it would address is refused by the
 * depth rule — visibly, with a notice — instead of silently costing a turn.
 * An agent that genuinely is mid-turn passes its `trigger` and is unaffected.
 *
 * @param entryId - The id of the entry being written.
 * @param opts.trigger - The cascade the writing turn was triggered under, if any.
 * @param opts.authorKind - Who is writing. Only `human` starts fresh.
 * @param opts.maxAgentDepth - The ceiling an un-provenanced agent post is stamped at.
 * @returns The `cascadeRoot` / `cascadeDepth` to persist on the entry.
 */
export function deriveCascade(
  entryId: string,
  opts: {
    trigger?: { root: string; depth: number };
    authorKind: AuthorKind;
    maxAgentDepth: number;
  }
): { cascadeRoot: string; cascadeDepth: number } {
  if (opts.trigger) {
    return { cascadeRoot: opts.trigger.root, cascadeDepth: opts.trigger.depth };
  }
  if (opts.authorKind === 'human') return { cascadeRoot: entryId, cascadeDepth: 0 };
  return { cascadeRoot: entryId, cascadeDepth: opts.maxAgentDepth };
}

/**
 * The durable `notice` a cascade refusal writes into the room.
 *
 * A silently dropped trigger is indistinguishable from a broken agent, and in a
 * shared room the person who notices is not the person who configured it. So
 * the room says what happened in its own voice — no stack trace, no reason code
 * in the prose — and says what to do about it.
 *
 * @param agentName - Display name of the agent that did not reply.
 * @param subjectAuthorId - Author id of that agent, for rendering.
 */
export function buildCascadeNotice(agentName: string, subjectAuthorId: string): RoomEntryBody {
  return {
    text: `${agentName} stopped replying here — this back-and-forth hit its automatic-reply limit. Send a message to pick it back up.`,
    notice: 'cascade_stopped',
    subjectAuthorId,
  };
}

/**
 * The durable `notice` the room writes when it runs out of hourly budget.
 *
 * Deliberately different words from the cascade notice, because it is a
 * different thing and the person reading it needs to act differently: the
 * cascade one means "this conversation went around enough times", and one
 * message restarts it. This one means "this room has done all the automatic
 * replying it may do for now", and another message will not.
 */
export function buildBudgetNotice(): RoomEntryBody {
  return {
    text: 'This room has used up its automatic replies for the hour. It will pick up again shortly — or raise the limit in Settings if this room is meant to be this busy.',
    notice: 'budget_reached',
  };
}
