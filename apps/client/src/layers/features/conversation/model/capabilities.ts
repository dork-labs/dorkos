/**
 * What a conversation is, and what it can do.
 *
 * Two types, and the whole difference between the cockpit's messaging surfaces
 * lives in the second one. `ConversationSurface` says which presentation this
 * is — it names the thing for a person reading the code and for the one place
 * that has to choose a word ("channel" or "session") — and it is never allowed
 * to decide BEHAVIOUR. Behaviour comes from {@link ConversationCapabilities},
 * declared once per host as a module constant, so "rooms have reactions and
 * sessions do not" is a boolean in a table rather than an `if` scattered
 * through the row, the list and the composer.
 *
 * The rule is mechanical, not aspirational: nothing under `Conversation.Root`
 * may read `surface`, and `__tests__/no-surface-switches.test.ts` scans every
 * source file in this slice — `ui/`, `lib/` and `model/` — for a comparison
 * against it or a switch on it, and fails on a hit.
 *
 * @module features/conversation/model/capabilities
 */

/** Which of the three presentations this conversation is. */
export type ConversationSurface = 'session' | 'room' | 'dm';

/** What this conversation can do. Behaviour branches on these, never on `surface`. */
export interface ConversationCapabilities {
  /** Emoji reactions on a row. */
  reactions: boolean;
  /** Rows can open a thread, and a thread panel exists. */
  threads: boolean;
  /** The "run this with…" action on a row (session only today). */
  runWith: boolean;
  /** The composer accepts files. */
  attachments: boolean;
  /**
   * The composer offers an `@` picker.
   *
   * Read by `Conversation.Composer`, which draws the `mentionPicker` slot only
   * where this is true — so a surface that declares `mentions: false` cannot
   * grow a picker by passing a node.
   *
   * There is no `toolCards` flag beside it, and its absence is a decision: what
   * a body may contain is settled by which body renderer the HOST hands the
   * timeline (`renderSessionBody` vs `renderRoomBody`), which is §2.6's gate and
   * already discriminates. A boolean two capability tables had to keep in step
   * while nothing read it was a check that could not fail.
   */
  mentions: boolean;
  /** The lane may show presence for other authors. */
  presence: boolean;
  /** The lane may show this conversation's own turn status (elapsed, tokens, mode). */
  turnStatus: boolean;
  /** The lane may grow an Ask card. */
  asks: boolean;
}
