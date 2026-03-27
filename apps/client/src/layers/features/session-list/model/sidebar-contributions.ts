import type { ComponentType } from 'react';
import {
  Pencil,
  Settings,
  Sun,
  Bug,
  LayoutDashboard,
  MessageSquare,
  Clock,
  Radio,
} from 'lucide-react';
import type { SidebarFooterContribution, SidebarTabContribution } from '@/layers/shared/model';
import { useAppStore } from '@/layers/shared/model';

// These components currently accept props from their parent (SessionSidebar).
// They are cast to ComponentType here because the contribution interface requires
// zero-prop components. Phase 3 migration (task 3.4) will refactor these components
// to be self-contained, fetching their own data from hooks instead of props.
import { OverviewTabPanel } from '../ui/OverviewTabPanel';
import { SessionsView } from '../ui/SessionsView';
import { SchedulesView } from '../ui/SchedulesView';
import { ConnectionsView } from '../ui/ConnectionsView';

/**
 * Built-in sidebar footer buttons.
 *
 * Note: The theme button uses `Sun` as the default icon. The actual
 * rendering component (`SidebarFooterBar`) handles dynamic icon swapping
 * based on the current theme by checking the contribution `id`.
 */
export const SIDEBAR_FOOTER_BUTTONS: SidebarFooterContribution[] = [
  {
    id: 'edit-agent',
    icon: Pencil,
    label: 'Edit Agent',
    onClick: () => useAppStore.getState().setAgentDialogOpen(true),
    priority: 1,
  },
  {
    id: 'settings',
    icon: Settings,
    label: 'Settings',
    onClick: () => useAppStore.getState().setSettingsOpen(true),
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
    onClick: () => useAppStore.getState().toggleDevtools(),
    priority: 4,
    showInDevOnly: true,
  },
];

/**
 * Built-in sidebar tab contributions.
 *
 * Components are cast to `ComponentType` because they currently accept props
 * from SessionSidebar. Phase 3 migration will refactor them to be self-contained.
 */
export const SIDEBAR_TAB_CONTRIBUTIONS: SidebarTabContribution[] = [
  {
    id: 'overview',
    icon: LayoutDashboard,
    label: 'Overview',
    component: OverviewTabPanel as unknown as ComponentType,
    shortcut: '\u23181',
    priority: 1,
  },
  {
    id: 'sessions',
    icon: MessageSquare,
    label: 'Sessions',
    component: SessionsView as unknown as ComponentType,
    shortcut: '\u23182',
    priority: 2,
  },
  {
    id: 'schedules',
    icon: Clock,
    label: 'Schedules',
    component: SchedulesView as unknown as ComponentType,
    // visibleWhen will be wired to actual pulse tool status during phase 3 migration.
    // Currently returns true because pulseToolEnabled is derived locally in SessionSidebar,
    // not stored in the app store.
    visibleWhen: () => true,
    shortcut: '\u23183',
    priority: 3,
  },
  {
    id: 'connections',
    icon: Radio,
    label: 'Connections',
    component: ConnectionsView as unknown as ComponentType,
    shortcut: '\u23184',
    priority: 4,
  },
];
