import { Settings, Sun, Bug } from 'lucide-react';
import type { SidebarFooterContribution } from '@/layers/shared/model';

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
