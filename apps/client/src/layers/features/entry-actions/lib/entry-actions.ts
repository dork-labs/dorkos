/**
 * The action set every message in a room offers, defined once.
 *
 * There are three ways to reach these actions — a toolbar on hover or focus, a
 * right-click menu, and a long-press drawer on touch — and they are three
 * renderings of THIS list, never three lists. A menu that offers one thing the
 * toolbar does not is two dialects of the same surface, and the reader has to
 * learn which is which.
 *
 * @module features/entry-actions/lib/entry-actions
 */
import type { LucideIcon } from 'lucide-react';

/** One position in the capsule. Stable — tests and telemetry name these. */
export type EntryActionSlot =
  | 'react'
  | 'react-more'
  | 'run-with'
  | 'reply'
  | 'copy'
  | 'mention'
  | 'profile';

/**
 * Which action this is.
 *
 * The slots a COMMAND can fill — a button with an icon that does one thing. The
 * three others are excluded deliberately: `react` is however many quick emoji
 * this reader has, and `react-more` and `run-with` each open a menu rather than
 * running, so none of them is one of these.
 */
export type EntryActionId = Exclude<EntryActionSlot, 'react' | 'react-more' | 'run-with'>;

/** One thing you can do to a message. */
export interface EntryAction {
  /** Stable identity, independent of the label's wording. */
  id: EntryActionId;
  /**
   * What it is called. One string for all three renderings: it is the button's
   * accessible name in the toolbar and the visible words in the menu, so a
   * person who hears the toolbar and a person who reads the drawer are told the
   * same thing.
   */
  label: string;
  /** The icon all three renderings draw. */
  icon: LucideIcon;
  /** Do it. */
  run: () => void;
}

/**
 * The order the capsule is drawn in, everywhere.
 *
 * **Reactions are its leftmost tenants** (`specs/room-messaging-design` §2):
 * this reader's three most-used emoji, then the button that opens the full
 * picker, then a divider, then reply / copy / mention — which kept the order
 * they had before reactions arrived, so the muscle memory built on the earlier
 * capsule survives.
 *
 * **`profile` is last, and being last is load-bearing.** It was added after the
 * other four, and every position before the end would have moved a command a
 * reader's fingers already know — `room-entry-actions.spec.ts` walks this row
 * with arrow keys and counts the presses to reach Reply. It is also the reason
 * the author's face can stay out of the tab order: the face is a pointer and
 * touch affordance, and this is the same destination reached the way every
 * other per-message action is reached (DOR-1251).
 *
 * **`run-with` sits with the other menu-opener, not with the commands.** It
 * arrived when the session's lone "Run this with…" control and this capsule
 * became one surface, and it is placed beside `react-more` because both open a
 * menu instead of doing something. Nothing a finger already knows moved: the
 * conversations that offer `run-with` (`capabilities.runWith`) offer none of
 * the room's commands, and the ones that offer the commands do not offer it —
 * so `room-entry-actions.spec.ts`, which counts arrow presses to reach Reply,
 * counts exactly what it counted before.
 *
 * One array, three renderings. The toolbar maps over it, the right-click menu
 * and the touch drawer render the commands from it in the same order, and a test
 * pins the sequence — which is what makes this the single source rather than a
 * note that three files currently agree with.
 */
export const ENTRY_ACTION_ORDER: readonly EntryActionSlot[] = [
  'react',
  'react-more',
  'run-with',
  'reply',
  'copy',
  'mention',
  'profile',
];
