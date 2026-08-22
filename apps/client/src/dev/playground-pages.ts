/**
 * Which React component renders each playground page.
 *
 * Split out of `DevPlayground.tsx` so it can be imported without the shell
 * (DOR-1117). Importing `DevPlayground` runs module-level side effects — it
 * builds a `QueryClient`, a playground `Transport` and a memory-history router
 * at load time — which a gate that mounts pages one at a time does not want and
 * should not have to inherit. This module holds the map and nothing else.
 *
 * It is the second half of a pair: `playground-config.ts` says which pages
 * EXIST, this says what draws them. `every-showcase-mounts.test.tsx` asserts
 * the two agree, so a page added to one and forgotten in the other is a failing
 * test rather than a blank screen.
 *
 * @module dev/playground-pages
 */
import type { ComponentType } from 'react';
import { CommandPalettePage } from './pages/CommandPalettePage';
import { ComponentsPage } from './pages/ComponentsPage';
import { ConversationPage } from './pages/ConversationPage';
import { EntryActionsPage } from './pages/EntryActionsPage';
import { ErrorStatesPage } from './pages/ErrorStatesPage';
import { FeaturesPage } from './pages/FeaturesPage';
import { FilterBarPage } from './pages/FilterBarPage';
import { FormsPage } from './pages/FormsPage';
import { GenUiPage } from './pages/GenUiPage';
import { IdentityPage } from './pages/IdentityPage';
import { MarketplacePage } from './pages/MarketplacePage';
import { OnboardingPage } from './pages/OnboardingPage';
import { OneBarPage } from './pages/OneBarPage';
import { OverviewPage } from './pages/OverviewPage';
import { PromosPage } from './pages/PromosPage';
import { RoomsPage } from './pages/RoomsPage';
import { SettingsPage } from './pages/SettingsPage';
import { SidebarBootPage } from './pages/SidebarBootPage';
import { SidebarModelPage } from './pages/SidebarModelPage';
import { SimulatorPage } from './pages/SimulatorPage';
import { TablesPage } from './pages/TablesPage';
import { TokensPage } from './pages/TokensPage';
import { TopologyPage } from './pages/TopologyPage';
import { TourSpotlightPage } from './pages/TourSpotlightPage';
import type { Page } from './playground-registry';

/**
 * Props shared by all playground page components. Only OverviewPage uses
 * `onNavigate`.
 *
 * Deliberately not exported: every consumer reaches these components through
 * {@link PAGE_COMPONENTS}, whose value type already carries the shape.
 */
interface PlaygroundPageProps {
  onNavigate?: (page: Page) => void;
}

/** Page component lookup — maps page IDs to their React components. */
export const PAGE_COMPONENTS: Record<string, ComponentType<PlaygroundPageProps>> = {
  overview: OverviewPage as ComponentType<PlaygroundPageProps>,
  tokens: TokensPage,
  forms: FormsPage,
  components: ComponentsPage,
  conversation: ConversationPage,
  'entry-actions': EntryActionsPage,
  features: FeaturesPage,
  identity: IdentityPage,
  topology: TopologyPage,
  promos: PromosPage,
  'command-palette': CommandPalettePage,
  simulator: SimulatorPage,
  'filter-bar': FilterBarPage,
  'error-states': ErrorStatesPage,
  onboarding: OnboardingPage,
  tables: TablesPage,
  settings: SettingsPage,
  marketplace: MarketplacePage,
  'gen-ui': GenUiPage,
  rooms: RoomsPage,
  'tour-spotlight': TourSpotlightPage,
  'sidebar-model': SidebarModelPage,
  'sidebar-boot': SidebarBootPage,
  'one-bar': OneBarPage,
};
