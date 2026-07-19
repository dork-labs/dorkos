import type { ComponentType } from 'react';
import { Settings, Sun, Bug, LayoutGrid, MessageSquare, Clock, Plug2 } from 'lucide-react';
import type { SidebarFooterContribution, SidebarTabContribution } from '@/layers/shared/model';

// These components currently accept props from their parent (SessionSidebar).
// They are cast to ComponentType here because the contribution interface requires
// zero-prop components. Phase 3 migration (task 3.4) will refactor these components
// to be self-contained, fetching their own data from hooks instead of props.
import { OverviewTabPanel } from '../ui/OverviewTabPanel';
import { SessionsView } from '../ui/SessionsView';
import { TasksView } from '../ui/TasksView';
import { ConnectionsView } from '../ui/ConnectionsView';

/**
 * Built-in sidebar footer buttons.
 *
 * Note: The `settings` and `theme` buttons use no-op `onClick` placeholders —
 * the rendering component (`SidebarFooterBar`) overrides click behavior for
 * these IDs because their handlers require React hooks (URL deep-link navigation
 * for settings; theme state for theme cycling) that can't run outside a component.
 */
export const SIDEBAR_FOOTER_BUTTONS: SidebarFooterContribution[] = [
  {
    id: 'settings',
    icon: Settings,
    label: 'App Settings',
    onClick: () => {
      // Overridden in SidebarFooterBar — the actual handler calls
      // `useSettingsDeepLink().open()` which requires the router context.
    },
    priority: 2,
  },
  {
    id: 'theme',
    icon: Sun,
    label: 'Toggle Theme',
    onClick: () => {
      // Theme cycling is handled by the rendering component (SidebarFooterBar)
      // because it needs the current theme state. This onClick is a no-op placeholder;
      // the rendering component overrides click behavior for the 'theme' button by ID.
    },
    priority: 3,
  },
  {
    id: 'devtools',
    icon: Bug,
    label: 'Devtools',
    onClick: () => {
      // Overridden in SidebarFooterBar — the actual behavior is a dropdown menu
      // with multiple dev tool toggles and links.
    },
    priority: 4,
    showInDevOnly: true,
  },
];

/**
 * Built-in sidebar tab contributions.
 *
 * Registered into the `sidebar.tabs` slot alongside any extension-contributed
 * tabs (which append after these by priority). Built-in panels still render
 * from hardcoded, prop-fed markup in `SessionSidebar` \u2014 their `component` here
 * is a placeholder the tab strip never mounts (it renders the strip from this
 * metadata; `SessionSidebar` renders the panels). Extension tabs, by contrast,
 * are self-contained and DO mount their `component`.
 */
export const SIDEBAR_TAB_CONTRIBUTIONS: SidebarTabContribution[] = [
  {
    id: 'overview',
    icon: LayoutGrid,
    label: 'Overview',
    component: OverviewTabPanel as unknown as ComponentType,
    priority: 1,
  },
  {
    id: 'sessions',
    icon: MessageSquare,
    label: 'Sessions',
    component: SessionsView as unknown as ComponentType,
    priority: 2,
  },
  {
    id: 'schedules',
    icon: Clock,
    label: 'Schedules',
    component: TasksView as unknown as ComponentType,
    // Schedules visibility is gated locally in SessionSidebar (via the Tasks
    // tool status), not here \u2014 the panel and its badge already live there.
    priority: 3,
  },
  {
    id: 'connections',
    icon: Plug2,
    label: 'Connections',
    component: ConnectionsView as unknown as ComponentType,
    priority: 4,
  },
];

/**
 * Ids of the four built-in sidebar tabs, in strip order. The Cmd/Ctrl+1\u20134
 * shortcuts and the tooltip shortcut hint key off a tab's index here, so the
 * number that selects a built-in stays stable no matter which extension tabs
 * are installed. Extension-contributed tabs are reachable by click and arrow
 * keys, never by a number shortcut.
 */
export const BUILTIN_SIDEBAR_TAB_IDS = SIDEBAR_TAB_CONTRIBUTIONS.map((t) => t.id);

/**
 * Whether `id` is one of the four built-in tabs (vs an extension contribution).
 *
 * @param id - A sidebar tab id.
 */
export function isBuiltinSidebarTab(id: string): boolean {
  return BUILTIN_SIDEBAR_TAB_IDS.includes(id);
}
