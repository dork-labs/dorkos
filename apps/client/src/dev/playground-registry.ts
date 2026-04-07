/** Page identifiers for the dev playground. */
export type Page =
  | 'overview'
  | 'tokens'
  | 'forms'
  | 'components'
  | 'chat'
  | 'features'
  | 'promos'
  | 'command-palette'
  | 'simulator'
  | 'topology'
  | 'filter-bar'
  | 'error-states'
  | 'onboarding'
  | 'tables'
  | 'marketplace';

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
export { PROMOS_SECTIONS } from './sections/promos-sections';
export { COMMAND_PALETTE_SECTIONS } from './sections/command-palette-sections';
export { SIMULATOR_SECTIONS } from './sections/simulator-sections';
export { TOPOLOGY_SECTIONS } from './sections/topology-sections';
export { FILTER_BAR_SECTIONS } from './sections/filter-bar-sections';
export { ERROR_STATES_SECTIONS } from './sections/error-states-sections';
export { ONBOARDING_SECTIONS } from './sections/onboarding-sections';
export { TABLES_SECTIONS } from './sections/tables-sections';
export { MARKETPLACE_SECTIONS } from './sections/marketplace-sections';

// Imported under aliases to compose the full registry without circular re-export issues.
import { TOKENS_SECTIONS as tokens } from './sections/tokens-sections';
import { FORMS_SECTIONS as forms } from './sections/forms-sections';
import { COMPONENTS_SECTIONS as components } from './sections/components-sections';
import { CHAT_SECTIONS as chat } from './sections/chat-sections';
import { FEATURES_SECTIONS as features } from './sections/features-sections';
import { PROMOS_SECTIONS as promos } from './sections/promos-sections';
import { COMMAND_PALETTE_SECTIONS as commandPalette } from './sections/command-palette-sections';
import { SIMULATOR_SECTIONS as simulator } from './sections/simulator-sections';
import { TOPOLOGY_SECTIONS as topology } from './sections/topology-sections';
import { FILTER_BAR_SECTIONS as filterBar } from './sections/filter-bar-sections';
import { ERROR_STATES_SECTIONS as errorStates } from './sections/error-states-sections';
import { ONBOARDING_SECTIONS as onboarding } from './sections/onboarding-sections';
import { TABLES_SECTIONS as tables } from './sections/tables-sections';
import { MARKETPLACE_SECTIONS as marketplace } from './sections/marketplace-sections';

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
  ...promos,
  ...commandPalette,
  ...simulator,
  ...topology,
  ...filterBar,
  ...errorStates,
  ...onboarding,
  ...tables,
  ...marketplace,
];
