import { lazy } from 'react';
import { PanelRight, Puzzle, SquareTerminal, User } from 'lucide-react';
import { useExtensionRegistry } from '@/layers/shared/model';
import {
  PALETTE_FEATURES,
  PALETTE_QUICK_ACTIONS,
  PALETTE_DEV_ACTIONS,
} from '@/layers/features/command-palette';
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

  // Dev-only command palette items
  if (import.meta.env.DEV) {
    for (const action of PALETTE_DEV_ACTIONS) {
      register('command-palette.items', action);
    }
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

  // Agent Hub as right-panel contribution (lazy-loaded).
  // Hidden on the marketplace routes: the Agent Profile follows the operator's
  // selected working directory, which on /marketplace is usually a plain repo
  // root with no agent manifest, so the panel would default to a misleading
  // "Agent not found" error. The marketplace has no agent context to profile.
  register('right-panel', {
    id: 'agent-hub',
    title: 'Agent Profile',
    icon: User,
    component: lazy(() =>
      import('@/layers/features/agent-hub').then((m) => ({ default: m.AgentHub }))
    ),
    visibleWhen: ({ pathname }) => !pathname.startsWith('/marketplace'),
    priority: 10,
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

  // Terminal as right-panel contribution (lazy-loaded — @xterm/* lands in its
  // own async chunk). Web-only: shown on /session AND only when the active
  // transport supports a server-side PTY (hidden under the in-process Obsidian
  // transport, D3).
  register('right-panel', {
    id: 'terminal',
    title: 'Terminal',
    icon: SquareTerminal,
    component: lazy(() =>
      import('@/layers/features/terminal').then((m) => ({ default: m.TerminalPanel }))
    ),
    visibleWhen: ({ pathname, transport }) =>
      pathname === '/session' && transport?.supportsTerminal === true,
    priority: 25,
  });
}
