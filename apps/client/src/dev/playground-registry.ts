/** Page identifiers for the dev playground. */
export type Page =
  | 'overview'
  | 'tokens'
  | 'forms'
  | 'components'
  | 'chat'
  | 'features'
  | 'simulator';

/** A single searchable/navigable section in the playground. */
export interface PlaygroundSection {
  /** Anchor ID matching the section element's id attribute. */
  id: string;
  /** Display name shown in TOC and search. */
  title: string;
  /** Which page this section lives on. */
  page: Page;
  /** Showcase group for search grouping. */
  category: string;
  /** Alias keywords for fuzzy search matching. */
  keywords: string[];
}

export { TOKENS_SECTIONS } from './sections/tokens-sections';
export { FORMS_SECTIONS } from './sections/forms-sections';
export { COMPONENTS_SECTIONS } from './sections/components-sections';
export { CHAT_SECTIONS } from './sections/chat-sections';
export { FEATURES_SECTIONS } from './sections/features-sections';
export { SIMULATOR_SECTIONS } from './sections/simulator-sections';

// Imported under aliases to compose the full registry without circular re-export issues.
import { TOKENS_SECTIONS as tokens } from './sections/tokens-sections';
import { FORMS_SECTIONS as forms } from './sections/forms-sections';
import { COMPONENTS_SECTIONS as components } from './sections/components-sections';
import { CHAT_SECTIONS as chat } from './sections/chat-sections';
import { FEATURES_SECTIONS as features } from './sections/features-sections';
import { SIMULATOR_SECTIONS as simulator } from './sections/simulator-sections';

/**
 * Full playground registry combining all page-level section arrays.
 *
 * Used as the data source for the TOC sidebar and Cmd+K search.
 */
export const PLAYGROUND_REGISTRY: PlaygroundSection[] = [
  ...tokens,
  ...forms,
  ...components,
  ...chat,
  ...features,
  ...simulator,
];
