/**
 * Touch chips — the turn-level record of the files, URLs, and commands an
 * assistant turn handled.
 *
 * Internal to `features/chat`; not exported from the feature barrel.
 */
export { TouchChipStrip } from './TouchChipStrip';
export { TouchChip } from './TouchChip';
export { ChipPile } from './ChipPile';
export { ChipTray } from './ChipTray';
export { groupChipsByVerb, VERB_ICON, VERB_LABEL, VERB_ORDER } from './chip-verbs';
export type { VerbGroup } from './chip-verbs';
