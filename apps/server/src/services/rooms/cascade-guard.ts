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
 * Two rules, and the second is the one that bounds ping-pong. The depth rule
 * counts the whole chain however many agents are in it, so it only ever fires
 * for a long run of DISTINCT agents (or when the ceiling is 0). The repeat rule
 * counts each author separately and refuses the one that has already answered
 * often enough, which is what stops A→B→A→B running the chain out between two
 * agents while every other member waits.
 *
 * **The repeat rule used to be an ancestry rule** — a target already anywhere
 * in the cascade was refused, so A→B→A died at the first repeat. That was one
 * turn per agent per conversation, forever, and it was too tight to hold a real
 * exchange: two agents working something out cannot do it in one sentence each.
 * It is now a counter (`rooms.maxTurnsPerAgentPerCascade`), so the same
 * mechanism fires at N instead of at 1. Nothing about its standing changed: it
 * is still a bound in code and never a prompt (ADR 260726-170127, amended).
 *
 * **The unit it counts is a TURN, not a message** (DOR-1434). One turn may write
 * as many entries as it likes — progress notes posted through the rooms tool,
 * then the answer the dispatcher delivers — and they all spend one. The counting
 * lives in `RoomStore.turnsByAuthorInCascade`, which reads each entry's
 * `dispatch_id`; nothing in this module has to know that, which is the point of
 * it taking the counts rather than the rows.
 *
 * Pure — the caller supplies the provenance it read, and the ceiling it is
 * measuring against. There is deliberately no default ceiling here: the number
 * lives in `rooms.maxAgentDepth` (user config), and a second copy in this file
 * would be the one somebody edits when the real one is elsewhere.
 *
 * A refusal here is visible: `room-trigger.ts`, the production caller, writes
 * the room's own-voice `notice` for it. The words live in `notices/notice-copy.ts`
 * with every other thing the room says about itself.
 *
 * @module server/services/rooms/cascade-guard
 */
import type { AuthorKind } from '@dorkos/shared/room-schemas';

/** Why a trigger was refused. */
export type CascadeRefusalReason = 'depth' | 'repeat';

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
   * How many TURNS each author has already taken in this cascade — one indexed
   * read, `RoomStore.turnsByAuthorInCascade`.
   *
   * A count rather than a set, because the repeat rule fires at
   * `maxTurnsPerAgentPerCascade` rather than at the first repeat. An author
   * absent from the map has spoken zero times here.
   *
   * Turns, not rows: entries written by one turn share a `dispatch_id` and
   * collapse to one, so an agent narrating its work as it goes is not charged
   * for being legible (DOR-1434). Entries with no turn behind them — a person's
   * post, an un-provenanced agent post, anything written before that column —
   * count one each.
   */
  turnsByAuthor: ReadonlyMap<string, number>;
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
 * @param provenance - The triggering entry's cascade root, depth, and per-author
 *   turn counts.
 * @param opts.maxAgentDepth - How many automatic replies deep a cascade may run
 *   (`rooms.maxAgentDepth`). Required: this module holds no default, so the
 *   number a person can change is the only one in play.
 * @param opts.maxTurnsPerAgentPerCascade - How many of those replies one author
 *   may run (`rooms.maxTurnsPerAgentPerCascade`). Required for the same reason.
 * @returns Whether to trigger, the depth it would carry, and the refusal reason.
 */
export function evaluateCascade(
  targetAuthorId: string,
  provenance: CascadeProvenance,
  opts: { maxAgentDepth: number; maxTurnsPerAgentPerCascade: number }
): CascadeDecision {
  const { maxAgentDepth, maxTurnsPerAgentPerCascade } = opts;
  const depth = provenance.depth + 1;

  if (depth > maxAgentDepth) return { allowed: false, depth, reason: 'depth' };
  const taken = provenance.turnsByAuthor.get(targetAuthorId) ?? 0;
  if (taken >= maxTurnsPerAgentPerCascade) {
    return { allowed: false, depth, reason: 'repeat' };
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
 * `X-DorkOS-Agent` header as the owner's own human author, so a program on this machine
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
 * max depth 0 and not one refusal notice. Unbounded by depth, unbounded by the
 * repeat rule, invisible in the room, one model call per hop. This is the exact
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
