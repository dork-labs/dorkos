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

/** What the conversation rule reads. One query, on the room log. */
export interface ConversationDeps {
  store: Pick<RoomStore, 'listRecentPostsInScope'>;
}

/**
 * The window an AGENT's post is weighed against: the values that shipped
 * before DOR-2823 raised the configured ones.
 *
 * The configured window is now the conversation a PERSON is having, and people
 * expect an answer an hour later. Agents talking to each other are the traffic
 * `meta/agent-etiquette.md` asks to stay quiet in speech, so their rule keeps
 * the old bound rather than inheriting the longer one. Capped by the config in
 * {@link agentPostWindow}, so turning the window off still turns it off.
 */
export const AGENT_POST_WINDOW: EngagedWindow = { minutes: 10, posts: 5 };

/**
 * The window an agent's post is weighed against: {@link AGENT_POST_WINDOW},
 * never longer than the configured one.
 *
 * @param configured - The live `rooms.engagedWindow*` ceilings.
 */
export function agentPostWindow(configured: EngagedWindow): EngagedWindow {
  return {
    minutes: Math.min(configured.minutes, AGENT_POST_WINDOW.minutes),
    posts: Math.min(configured.posts, AGENT_POST_WINDOW.posts),
  };
}

/** Who a person's post is for by conversation, and how long that lasts. */
export interface Conversation {
  /** The agent members the person is talking to here. Usually one. */
  partners: string[];
  /** The window the anchor opens, in the same shape the engaged window uses. */
  window: EngagementWindow;
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

/**
 * Who a PERSON's post is for when it names nobody: the agent they are talking
 * to in this scope (DOR-2823, room-participation spec §9.2).
 *
 * **Follow the conversation, not the clock.** Walk the scope newest first,
 * starting at the post itself, and stop at the first post that says who the
 * conversation is with:
 *
 * - a post by an agent member — the agent that spoke last is the one being
 *   answered, so an agent's OWN posts anchor and extend the window;
 * - a person's post that @mentioned agent members — the one they last named,
 *   which is also how a person moves the conversation to somebody else.
 *
 * A person's post that names nobody says nothing about who, so the walk passes
 * over it, and it counts toward the post ceiling. The anchor must be inside the
 * window on both halves: younger than `window.minutes`, and fewer than
 * `window.posts` posts landed on top of it.
 *
 * Only for a person's post in a channel. An agent's post keeps the
 * mention-anchored {@link engagementFor} rule: agents talking to each other is
 * the traffic that must stay quiet.
 *
 * The post being weighed is index 0, so a post that @mentions agents is its own
 * anchor — which is why the mentioned turn carries a window too, exactly as it
 * did under the engaged window.
 *
 * Reads at most `window.posts + 1` rows on the same indexes as the engaged
 * window, so it costs one bounded query per post, not one per member.
 *
 * @param deps - The room store.
 * @param opts.roomId - The room.
 * @param opts.threadRootEntryId - The post's thread, or `null` for the top level.
 *   A thread's root is part of its scope.
 * @param opts.isAgentMember - Whether an author id is an agent member of this
 *   room. Anything else (a person, a departed agent) is not an anchor by
 *   authorship; only a person's mentions anchor, and only of agent members.
 * @param opts.isPerson - Whether an author id is a person.
 * @param opts.window - The configured ceilings.
 * @param opts.now - The clock.
 * @returns The partners and their window, or `null` when the post is not part
 *   of a conversation with any agent here.
 */
export function conversationFor(
  deps: ConversationDeps,
  opts: {
    roomId: string;
    threadRootEntryId: string | null;
    isAgentMember: (authorId: string) => boolean;
    isPerson: (authorId: string) => boolean;
    window: EngagedWindow;
    now: Date;
  }
): Conversation | null {
  const { minutes, posts } = opts.window;
  if (minutes <= 0 || posts <= 0) return null;

  const recent = deps.store.listRecentPostsInScope(opts.roomId, {
    threadRootEntryId: opts.threadRootEntryId,
    limit: posts,
  });

  for (let since = 0; since < recent.length; since++) {
    const entry = recent[since]!;
    let partners: string[] = [];
    if (opts.isAgentMember(entry.authorId)) partners = [entry.authorId];
    else if (opts.isPerson(entry.authorId)) {
      partners = [...new Set(entry.mentions.filter((id) => opts.isAgentMember(id)))];
    }
    if (partners.length === 0) continue;

    const anchored = Date.parse(entry.createdAt);
    if (Number.isNaN(anchored)) return null;
    const closes = anchored + minutes * 60_000;
    if (closes <= opts.now.getTime()) return null;
    return { partners, window: { until: new Date(closes), postsLeft: posts - since - 1 } };
  }
  return null;
}
