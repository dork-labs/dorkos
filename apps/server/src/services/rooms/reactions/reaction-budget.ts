/**
 * How many emoji one agent may put on one room's messages in an hour
 * (ADR 260814-195522, the reversal of etiquette E16b).
 *
 * ## Why a bound exists at all
 *
 * Everything else an agent does in a room is already bounded by something: a
 * reply spends a turn, and turns are counted twice over (`turn-budget.ts`). A
 * reaction spends nothing — no turn, no model call, no entry, no cascade — which
 * is exactly what makes it worth allowing, and exactly why nothing else in the
 * system would ever slow one down. Two agents that each acknowledge everything
 * the other says would sit in a pill-storm forever at zero cost, and the person
 * reading the room is the one who pays.
 *
 * So this is `I2` applied to the new verb: the bound is a MECHANISM, not a line
 * in a prompt. "React sparingly" is not a rule an agent can follow, for the same
 * reason "don't get into a loop" is not.
 *
 * ## The grain, and why it is this one
 *
 * `(room, agent)` per rolling hour. The room half is what keeps one busy channel
 * from spending an agent's whole allowance everywhere else; the agent half is
 * what keeps one misconfigured agent from spending everybody's. It deliberately
 * does NOT carry a second, install-wide ceiling the way `RoomTurnBudget` does:
 * that ceiling exists there because turns cost money, and these do not. What is
 * being protected here is a person's attention in one conversation, which is a
 * per-room quantity.
 *
 * **People are never counted.** A person clicking pills is the feature working.
 *
 * ## Additions are counted; taking one back is free
 *
 * Only a reaction that LANDS spends. Removing one is never refused and never
 * charged, for two reasons that point the same way: a retraction is the remedy
 * for a reaction somebody regrets, and an agent that cannot take one back is an
 * agent whose mistakes are permanent. It also makes the ceiling honest to
 * describe — twenty reactions an hour means twenty pills, not twenty clicks —
 * and it means a no-op toggle (`on: true` on a reaction already standing) costs
 * nothing, which is what a client that may retry needs.
 *
 * The residual is a toggle loop: add, retract, add. Each ADD spends, so the loop
 * is bounded at the same twenty; what it can churn is rows and reaction events,
 * at a cost of one SQLite write apiece. That is a fair trade for never trapping
 * an agent behind its own mistake.
 *
 * ## Durable without a table of its own
 *
 * The window is rebuilt from `room_entry_reactions`, which is already durable and
 * already carries `created_at` — so an agent that spent its hour and then met a
 * restart comes back spent, the property DOR-1205 bought for turns, at the cost
 * of no new table and no migration. The read happens once per `(room, agent)`
 * pair per process, on that pair's first reaction; after that the decision is
 * pure memory, like {@link RoomTurnBudget}'s.
 *
 * The one thing hydration cannot see is a reaction that was added and then taken
 * back inside the window: the row is gone, so a restart forgets it. Within a
 * process it is counted — the add spent when it landed — so the residual is one
 * restart's worth of an agent flipping an emoji on and off.
 *
 * ## The number is ours and unsourced
 *
 * Like every threshold in this domain (`meta/agent-etiquette.md` §9): no vendor
 * publishes a figure for how many acknowledgments a person will tolerate from a
 * machine, and no study establishes one. It is a constant rather than a setting
 * for the same reason `WAITING_NOTICE_GRACE_MS` is: it changes how chatty one
 * quiet affordance is, never what the room does, and there is no honest guidance
 * to hand somebody tuning it. If dogfooding says otherwise, that is evidence, and
 * evidence is what should buy a setting.
 *
 * @module server/services/rooms/reactions/reaction-budget
 */
import { roomEntryReactions, and, eq, gt, ne, type Db } from '@dorkos/db';
import { ROOM_RECEIPT_EMOJI } from '@dorkos/shared/room-schemas';
import { logger } from '../../../lib/logger.js';

/** One hour, the window the ceiling is denominated in. */
const WINDOW_MS = 60 * 60_000;

/**
 * How many reactions one agent may land in one room per hour.
 *
 * Twenty is enough to acknowledge a working conversation and far too few to
 * sustain a storm. See the module TSDoc: it is ours, and unsourced.
 */
const AGENT_REACTIONS_PER_ROOM_PER_HOUR = 20;

/**
 * How many `(room, agent)` pairs to keep windows for before dropping the least
 * recently touched — the same trade {@link RoomTurnBudget} makes, in the same
 * direction: an evicted pair reads as unspent, and re-hydrates from the durable
 * rows the moment it reacts again, so eviction costs at most the reactions it
 * has already taken back.
 */
const TRACKED_PAIRS = 512;

/**
 * Separator for a window key.
 *
 * The NUL character, written as an ESCAPE and never as the byte itself.
 * `room-claims.ts` says
 * why in its own words — a literal NUL there was described by a comment as a
 * space, and the next reader wrote a lookup against the space — and this file
 * shipped the sharper version of the same mistake: the literal byte made it a
 * BINARY file, so `grep` skipped it, `git diff` printed "Binary files differ",
 * and a stale ADR id inside it survived a find-and-replace across the whole
 * branch. A separator you cannot see is a file nobody can review.
 */
const PAIR_SEPARATOR = '\u0000';

/**
 * A rolling count of one agent's reactions in one room, held in memory and
 * recovered from the reactions themselves.
 *
 * Insertion-ordered `Map`, so the least recently touched pair is always the first
 * key — which makes eviction one `keys().next()`.
 */
export class ReactionBudget {
  private readonly db: Db;
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly limit: () => number;
  private readonly spent = new Map<string, number[]>();

  /**
   * Build a budget over a database. Nothing is read until the first reservation:
   * a pair's window is recovered on the first reaction it asks for, so an install
   * with no agent reactions in it does no work at all.
   *
   * @param opts.db - Where the standing reactions live, for recovery.
   * @param opts.limit - The ceiling, read per call so a future setting takes
   *   effect on the next reaction rather than the next restart.
   * @param opts.now - Clock, injectable so a test can roll the window without
   *   sleeping for an hour.
   * @param opts.windowMs - Window length; defaults to one hour.
   */
  constructor(opts: { db: Db; limit?: () => number; now?: () => number; windowMs?: number }) {
    this.db = opts.db;
    this.limit = opts.limit ?? (() => AGENT_REACTIONS_PER_ROOM_PER_HOUR);
    this.now = opts.now ?? (() => Date.now());
    this.windowMs = opts.windowMs ?? WINDOW_MS;
  }

  /**
   * Claim one reaction for an agent in a room, reserving on success.
   *
   * Reserving inside the check is what stops two toggles landing in the same tick
   * from both spending the last unit.
   *
   * Callers ask this only for a reaction that will LAND — see the module TSDoc on
   * why a retraction is free.
   *
   * @param roomId - The room the reaction lands in.
   * @param authorId - The agent reacting. Callers pass only non-person authors;
   *   this class does not know what an author IS, and the kind check belongs
   *   where the author registry already is.
   * @returns `true` when the reaction may land.
   */
  tryReserve(roomId: string, authorId: string): boolean {
    const at = this.now();
    const floor = at - this.windowMs;
    const key = pairKey(roomId, authorId);
    const window = (this.spent.get(key) ?? this.hydrate(roomId, authorId, floor)).filter(
      (t) => t > floor
    );

    if (window.length >= this.limit()) {
      this.store(key, window);
      return false;
    }
    window.push(at);
    this.store(key, window);
    return true;
  }

  /**
   * The hour this pair was already inside when the process started, read once.
   *
   * Bounded at both ends for the reason {@link RoomTurnBudget.hydrate} states: a
   * clock that jumped backwards leaves rows a lower bound alone would count
   * forever. Fails open, loudly — a budget that cannot read is exactly the
   * pre-durability behaviour, and refusing an emoji because a counter is
   * unreadable would be the worse trade.
   *
   * @param roomId - The room being read.
   * @param authorId - The agent whose standing reactions are counted.
   * @param floor - The oldest instant still inside the window, epoch ms.
   * @returns The timestamps already spent inside the window.
   */
  private hydrate(roomId: string, authorId: string, floor: number): number[] {
    const at = this.now();
    try {
      const rows = this.db
        .select({ createdAt: roomEntryReactions.createdAt })
        .from(roomEntryReactions)
        .where(
          and(
            eq(roomEntryReactions.roomId, roomId),
            eq(roomEntryReactions.authorId, authorId),
            gt(roomEntryReactions.createdAt, new Date(floor).toISOString()),
            // The room's 👀 receipt is written under the agent's id but is the
            // room's, never the agent's spend (DOR-2823).
            ne(roomEntryReactions.emoji, ROOM_RECEIPT_EMOJI)
          )
        )
        .all();
      return rows
        .map((row) => Date.parse(row.createdAt))
        .filter((stamped) => Number.isFinite(stamped) && stamped > floor && stamped <= at);
    } catch (err) {
      logger.warn('[rooms] could not read the reactions an agent has already spent this hour', {
        roomId,
        authorId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Write a pair's pruned window back, re-inserting it as most recently used.
   *
   * @param key - The `(room, agent)` map key.
   * @param window - That pair's timestamps, already pruned to the window.
   */
  private store(key: string, window: number[]): void {
    this.spent.delete(key);
    this.spent.set(key, window);
    if (this.spent.size > TRACKED_PAIRS) {
      const oldest = this.spent.keys().next().value;
      if (oldest !== undefined) this.spent.delete(oldest);
    }
  }
}

/**
 * The `(room, agent)` identity, for map keys only. Nothing parses it back apart.
 *
 * @param roomId - The room.
 * @param authorId - The agent reacting in it.
 * @returns The map key for that pair.
 */
function pairKey(roomId: string, authorId: string): string {
  return [roomId, authorId].join(PAIR_SEPARATOR);
}
