import { Sun, Bug } from 'lucide-react';
import type { SidebarFooterContribution } from '@/layers/shared/model';

/**
 * Built-in sidebar footer buttons.
 *
 * Note: The `theme` button uses a no-op `onClick` placeholder — the rendering
 * component overrides click behavior for that ID because its handler requires
 * React hooks (theme state) that can't run outside a component.
 *
 * **`settings` is deliberately not here.** The settings dialog has one door in
 * this panel now: "Workspace settings" in the header block's menu (BC-43). It
 * was contributed here while the header block did not exist, and P2.5's own
 * comment recorded the fold as its home "until then" — so it goes with the
 * arrival of P2.4 rather than leaving one dialog behind two differently-named
 * rows in two different menus.
 */
export const SIDEBAR_FOOTER_BUTTONS: SidebarFooterContribution[] = [
  {
    id: 'theme',
    icon: Sun,
    label: 'Toggle Theme',
    onClick: () => {
      // Theme cycling is handled by the rendering component (SidebarFooterStrip)
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
      // Overridden in SidebarFooterStrip — the actual behavior is a dropdown menu
      // with multiple dev tool toggles and links.
    },
    priority: 4,
    showInDevOnly: true,
  },
];
