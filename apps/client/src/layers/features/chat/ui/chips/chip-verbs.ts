/**
 * The verb vocabulary the chip surfaces share: one glyph, one past-tense word,
 * and one canonical order, so the summary line, the tray's filter bar, and the
 * chip itself never disagree about what a `read` looks like or where it sits.
 *
 * @module features/chat/ui/chips/chip-verbs
 */
import type { TouchChip, TouchChipVerb } from '../../lib/touch-chips';

/** The glyph each verb wears (design record §5). */
export const VERB_ICON: Record<TouchChipVerb, string> = {
  read: '📖',
  search: '🔍',
  edit: '✏️',
  create: '✚',
  delete: '🗑',
  fetch: '🌐',
  run: '▮',
};

/** What each verb is called out loud — the accessible name and the filter's label. */
export const VERB_LABEL: Record<TouchChipVerb, string> = {
  read: 'Read',
  search: 'Searched',
  edit: 'Edited',
  create: 'Created',
  delete: 'Deleted',
  fetch: 'Fetched',
  run: 'Ran',
};

/**
 * Reading order for the verbs: what was looked at, then what was changed, then
 * what was reached for. Fixed rather than derived from the data so the summary
 * line does not reshuffle itself as a turn goes on.
 */
export const VERB_ORDER: readonly TouchChipVerb[] = [
  'read',
  'search',
  'edit',
  'create',
  'delete',
  'fetch',
  'run',
];

/** Every chip of one verb, counted and totalled. */
export interface VerbGroup {
  /** The verb this group collects. */
  verb: TouchChipVerb;
  /** The chips in it, in first-touch order. */
  chips: TouchChip[];
  /** Lines added across the group, when any chip reported a diffstat. */
  additions?: number;
  /** Lines removed across the group, when any chip reported a diffstat. */
  deletions?: number;
}

/**
 * Collect chips by verb in {@link VERB_ORDER}, dropping verbs nothing touched.
 *
 * @param chips - The turn's deduplicated roster.
 * @returns One group per verb present, each with its running diffstat.
 */
export function groupChipsByVerb(chips: TouchChip[]): VerbGroup[] {
  return VERB_ORDER.map((verb) => {
    const members = chips.filter((chip) => chip.verb === verb);
    const group: VerbGroup = { verb, chips: members };

    for (const chip of members) {
      if (chip.additions !== undefined) group.additions = (group.additions ?? 0) + chip.additions;
      if (chip.deletions !== undefined) group.deletions = (group.deletions ?? 0) + chip.deletions;
    }
    return group;
  }).filter((group) => group.chips.length > 0);
}
