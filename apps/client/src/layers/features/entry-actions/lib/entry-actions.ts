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

/** Which action this is. Stable — tests and telemetry name these. */
export type EntryActionId = 'reply' | 'copy' | 'mention';

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
 * The order actions are drawn in, everywhere.
 *
 * **The leftmost positions are reserved for quick reactions**, which land in
 * this same surface later and are deliberately not part of it now: there is no
 * reactions backend, and how an agent should behave around a reaction is an
 * open etiquette question (`meta/agent-etiquette.md`). Reserving the space
 * means reactions are PREPENDED to this array when they arrive — the three
 * actions below keep their order relative to each other, so the muscle memory
 * built now survives. A test pins that order, which is what makes this a
 * reservation rather than a note.
 */
export const ENTRY_ACTION_ORDER: readonly EntryActionId[] = ['reply', 'copy', 'mention'];
