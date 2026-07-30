/**
 * The engaged window: how long an agent keeps answering after somebody talked to
 * it (room-participation spec §9.2).
 *
 * This is Sacks/Schegloff/Jefferson 1974 rule 1(c) — the current speaker may
 * continue, and the rules re-apply at each transition-relevance place. It is the
 * one turn-allocation rule DorkOS had no mode for: `mention-only` taxes a person
 * with an `@` on every message, and `always` is rule 1(b) self-selection with a
 * participant that cannot lose the race for the floor. `engaged` is the only
 * bounded option, because it decays.
 *
 * **Nothing is stored, and that is the design rather than an optimisation.** The
 * window is a pure predicate over the room log, which is durable and never
 * trimmed. No column, no table, no in-memory window to reset on restart, and no
 * state that can disagree with the log. Contrast `turn-budget.ts`, whose windows
 * ARE in-memory and do reset (ADR 260726-170127): that one has to count
 * something the log does not record, and this one does not.
 *
 * Pure over the store and an injected clock: no config, no runtime, no model.
 * `room-trigger.ts` is the production caller and it evaluates this once per
 * entry, before addressing runs.
 *
 * @module server/services/rooms/engagement
 */
import type { RoomStore } from './room-store.js';

/** The two ceilings the window decays against, whichever runs out first. */
export interface EngagedWindow {
  /** `rooms.engagedWindowMinutes` — how long a mention keeps an agent engaged. */
  minutes: number;
  /** `rooms.engagedWindowPosts` — how many messages by others end it. */
  posts: number;
}

/** What the predicate reads. One query, on the room log. */
export interface EngagementDeps {
  store: Pick<RoomStore, 'listRecentPostsByOthers'>;
}

/**
 * An open window, described the way a member of the room would describe it.
 *
 * Both halves, because a deadline alone reads as the whole rule and it is half
 * of one — the window ends on other people's messages too, and whichever runs
 * out first ends it.
 */
export interface EngagementWindow {
  /** When the window closes on the clock. */
  until: Date;
  /**
   * How many more messages from other members can land before it closes.
   *
   * Remaining, not the ceiling: the ceiling is a number the agent cannot place
   * itself against, because it cannot see how much of the window has already
   * been spent. `0` means the next message by anybody else ends it.
   */
  postsLeft: number;
}

/**
 * One agent member's open engaged window, or `null` when it is not engaged here.
 *
 * An agent `M` is engaged in room `R` at thread scope `T` when both hold, over
 * the entries of that scope:
 *
 * 1. the most recent post by somebody else that mentions `M` is less than
 *    `window.minutes` old, and
 * 2. fewer than `window.posts` posts by authors other than `M` have landed since
 *    it.
 *
 * Being mentioned again resets both, by construction rather than by a rule:
 * the new mention simply becomes the anchor.
 *
 * **The read RETURNS at most `window.posts + 1` rows.** Scanning back from the
 * newest post, a mention that is not inside that many entries has by definition
 * had more than `window.posts` messages land on top of it, so the answer is no
 * without reading further. Six rows at the shipped defaults.
 *
 * **Rows returned is not rows scanned, and the difference was a real defect.**
 * This runs once per engaged agent per message, so it must never cost a turn and
 * must not get more expensive as a room fills up (`meta/agent-etiquette.md` E7).
 * The bound that matters is the one the query planner honours: the top-level
 * scope walks the `(room_id, seq)` primary key backwards, and the thread scope
 * needs `idx_room_entries_thread_root` — which it only gets because migration
 * 0040 put `seq` in that index. `room-store.ts` carries the measurement, and
 * `__tests__/engagement.test.ts` asserts the plan rather than the row count,
 * because a count of rows RETURNED cannot fail.
 *
 * Both ceilings at `0` mean "never engaged", which is the honest reading of a
 * zero-length window: `engaged` then behaves exactly like `mention-only`.
 *
 * @param deps - The room store.
 * @param opts.roomId - The room.
 * @param opts.threadRootEntryId - The thread the window is scoped to, or `null`
 *   for the channel's top level. A thread is a position inside a channel, so
 *   being addressed in one engages an agent there and nowhere else (spec §3.2).
 * @param opts.authorId - The agent member being weighed.
 * @param opts.window - The two ceilings, read live from user config.
 * @param opts.now - The clock, injected so a test can move it.
 * @returns The open window, or `null` when the member is not engaged.
 */
export function engagementFor(
  deps: EngagementDeps,
  opts: {
    roomId: string;
    threadRootEntryId: string | null;
    authorId: string;
    window: EngagedWindow;
    now: Date;
  }
): EngagementWindow | null {
  const { minutes, posts } = opts.window;
  if (minutes <= 0 || posts <= 0) return null;

  const recent = deps.store.listRecentPostsByOthers(opts.roomId, {
    threadRootEntryId: opts.threadRootEntryId,
    excludeAuthorId: opts.authorId,
    limit: posts + 1,
  });

  // Newest first, so the index IS the number of messages by others that have
  // landed since — no arithmetic on seq, which would count this member's own
  // posts and every notice in between.
  const since = recent.findIndex((entry) => entry.mentions.includes(opts.authorId));
  if (since === -1 || since >= posts) return null;

  const anchored = Date.parse(recent[since]!.createdAt);
  if (Number.isNaN(anchored)) return null;
  const closes = anchored + minutes * 60_000;
  if (closes <= opts.now.getTime()) return null;
  // `- 1` because `since` counts what has already landed and the NEXT message
  // has to still leave the count under the ceiling: at the shipped `5`, a
  // just-delivered mention leaves room for four more before the fifth ends it.
  return { until: new Date(closes), postsLeft: posts - since - 1 };
}
