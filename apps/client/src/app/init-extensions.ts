import { lazy } from 'react';
import { PanelRight, Puzzle } from 'lucide-react';
import { useExtensionRegistry } from '@/layers/shared/model';
import { PALETTE_FEATURES, PALETTE_QUICK_ACTIONS } from '@/layers/features/command-palette';
import { SIDEBAR_FOOTER_BUTTONS, SIDEBAR_TAB_CONTRIBUTIONS } from '@/layers/features/session-list';
import { DASHBOARD_SECTION_CONTRIBUTIONS } from '@/layers/widgets/dashboard';
import { DIALOG_CONTRIBUTIONS } from '@/layers/widgets/app-layout';

/**
 * Register all built-in features into the extension registry.
 * Called once at app startup, before React renders.
 */
export function initializeExtensions(): void {
  const { register } = useExtensionRegistry.getState();

  // Command palette items (priority 1-10 for built-ins)
  for (const feature of PALETTE_FEATURES) {
    register('command-palette.items', feature);
  }
  for (const action of PALETTE_QUICK_ACTIONS) {
    register('command-palette.items', action);
  }

  // Sidebar footer buttons
  for (const button of SIDEBAR_FOOTER_BUTTONS) {
    register('sidebar.footer', button);
  }

  // Sidebar tabs
  for (const tab of SIDEBAR_TAB_CONTRIBUTIONS) {
    register('sidebar.tabs', tab);
  }

  // Dashboard sections
  for (const section of DASHBOARD_SECTION_CONTRIBUTIONS) {
    register('dashboard.sections', section);
  }

  // Dialog contributions
  for (const dialog of DIALOG_CONTRIBUTIONS) {
    register('dialog', dialog);
  }

  // Extensions settings tab (lazy-loaded to avoid bloating the initial bundle)
  register('settings.tabs', {
    id: 'extensions',
    label: 'Extensions',
    icon: Puzzle,
    component: lazy(() =>
      import('@/layers/features/extensions').then((m) => ({ default: m.ExtensionsSettingsTab }))
    ),
    priority: 70,
  });

  // Canvas as right-panel contribution (lazy-loaded, only visible on /session)
  register('right-panel', {
    id: 'canvas',
    title: 'Canvas',
    icon: PanelRight,
    component: lazy(() =>
      import('@/layers/features/canvas').then((m) => ({ default: m.CanvasContent }))
    ),
    visibleWhen: ({ pathname }) => pathname === '/session',
    priority: 20,
  });
}
