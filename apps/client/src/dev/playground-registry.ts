/** Page identifiers for the dev playground. */
export type Page =
  | 'overview'
  | 'tokens'
  | 'forms'
  | 'components'
  | 'conversation'
  | 'entry-actions'
  | 'features'
  | 'home-inbox'
  | 'identity'
  | 'promos'
  | 'command-palette'
  | 'simulator'
  | 'topology'
  | 'filter-bar'
  | 'error-states'
  | 'onboarding'
  | 'tables'
  | 'settings'
  | 'marketplace'
  | 'gen-ui'
  | 'rooms'
  | 'tour-spotlight'
  | 'sidebar-model'
  | 'sidebar-boot'
  | 'one-bar';

/** A single searchable/navigable section in the playground. */
export interface PlaygroundSection {
  /** Anchor ID matching the section element's id attribute. */
  id: string;
  /** Display name shown in TOC and search. */
  title: string;
  /** Which page this section lives on. */
  page: Page;
  /**
   * The feature or subsystem this section belongs to.
   *
   * `TocSidebar` groups the page's TOC by this field into labeled
   * sub-headings, keyed by name (DOR-1766, batch 20 audit finding 20.3) — a
   * category can appear anywhere in the array and its sections still render
   * under one heading, positioned at its first occurrence. ⌘K still groups
   * only by `page` (`PlaygroundSearch`); this has never been a search
   * grouping.
   */
  category: string;
  /** Alias keywords for fuzzy search matching. */
  keywords: string[];
}

export { TOKENS_SECTIONS } from './sections/tokens-sections';
export { FORMS_SECTIONS } from './sections/forms-sections';
export { COMPONENTS_SECTIONS } from './sections/components-sections';
export { CONVERSATION_SECTIONS } from './sections/conversation-sections';
export { ENTRY_ACTIONS_SECTIONS } from './sections/entry-actions-sections';
export { FEATURE_AGENT_SECTIONS } from './sections/features-agent-sections';
export { FEATURE_SURFACE_SECTIONS } from './sections/features-surface-sections';
export { IDENTITY_SECTIONS } from './sections/identity-sections';
export { PROMOS_SECTIONS } from './sections/promos-sections';
export { COMMAND_PALETTE_SECTIONS } from './sections/command-palette-sections';
export { SIMULATOR_SECTIONS } from './sections/simulator-sections';
export { TOPOLOGY_SECTIONS } from './sections/topology-sections';
export { FILTER_BAR_SECTIONS } from './sections/filter-bar-sections';
export { ERROR_STATES_SECTIONS } from './sections/error-states-sections';
export { ONBOARDING_SECTIONS } from './sections/onboarding-sections';
export { TABLES_SECTIONS } from './sections/tables-sections';
export { SETTINGS_SECTIONS } from './sections/settings-sections';
export { MARKETPLACE_SECTIONS } from './sections/marketplace-sections';
export { GEN_UI_SECTIONS } from './sections/gen-ui-sections';
export { ROOMS_SECTIONS } from './sections/rooms-sections';
export { TOUR_SPOTLIGHT_SECTIONS } from './sections/tour-spotlight-sections';
export { SIDEBAR_MODEL_SECTIONS } from './sections/sidebar-model-sections';
export { SIDEBAR_BOOT_SECTIONS } from './sections/sidebar-boot-sections';
export { ONE_BAR_SECTIONS } from './sections/one-bar-sections';

// Imported under aliases to compose the full registry without circular re-export issues.
import { TOKENS_SECTIONS as tokens } from './sections/tokens-sections';
import { FORMS_SECTIONS as forms } from './sections/forms-sections';
import { COMPONENTS_SECTIONS as components } from './sections/components-sections';
import { CONVERSATION_SECTIONS as conversation } from './sections/conversation-sections';
import { ENTRY_ACTIONS_SECTIONS as entryActions } from './sections/entry-actions-sections';
import { FEATURE_AGENT_SECTIONS as featureAgent } from './sections/features-agent-sections';
import { FEATURE_SURFACE_SECTIONS as featureSurface } from './sections/features-surface-sections';
import { IDENTITY_SECTIONS as identity } from './sections/identity-sections';
import { PROMOS_SECTIONS as promos } from './sections/promos-sections';
import { COMMAND_PALETTE_SECTIONS as commandPalette } from './sections/command-palette-sections';
import { SIMULATOR_SECTIONS as simulator } from './sections/simulator-sections';
import { TOPOLOGY_SECTIONS as topology } from './sections/topology-sections';
import { FILTER_BAR_SECTIONS as filterBar } from './sections/filter-bar-sections';
import { ERROR_STATES_SECTIONS as errorStates } from './sections/error-states-sections';
import { ONBOARDING_SECTIONS as onboarding } from './sections/onboarding-sections';
import { TABLES_SECTIONS as tables } from './sections/tables-sections';
import { SETTINGS_SECTIONS as settings } from './sections/settings-sections';
import { MARKETPLACE_SECTIONS as marketplace } from './sections/marketplace-sections';
import { GEN_UI_SECTIONS as genUi } from './sections/gen-ui-sections';
import { ROOMS_SECTIONS as rooms } from './sections/rooms-sections';
import { TOUR_SPOTLIGHT_SECTIONS as tourSpotlight } from './sections/tour-spotlight-sections';
import { SIDEBAR_MODEL_SECTIONS as sidebarModel } from './sections/sidebar-model-sections';
import { SIDEBAR_BOOT_SECTIONS as sidebarBoot } from './sections/sidebar-boot-sections';
import { ONE_BAR_SECTIONS as oneBar } from './sections/one-bar-sections';

/**
 * Full playground registry combining all page-level section arrays.
 *
 * Used as the data source for the TOC sidebar and Cmd+K search.
 */
export const PLAYGROUND_REGISTRY: PlaygroundSection[] = [
  ...tokens,
  ...forms,
  ...components,
  ...conversation,
  ...entryActions,
  ...featureAgent,
  ...featureSurface,
  ...identity,
  ...promos,
  ...commandPalette,
  ...simulator,
  ...topology,
  ...filterBar,
  ...errorStates,
  ...onboarding,
  ...tables,
  ...settings,
  ...marketplace,
  ...genUi,
  ...rooms,
  ...tourSpotlight,
  ...sidebarModel,
  ...sidebarBoot,
  ...oneBar,
];
