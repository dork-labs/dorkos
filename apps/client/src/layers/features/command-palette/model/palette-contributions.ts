import type { CommandPaletteContribution } from '@/layers/shared/model';

/**
 * The quick actions that MAKE something, in the order the zero-query "New"
 * group draws them.
 *
 * An allowlist of ids rather than a new contribution category: "creating
 * anything → one New button" is a decision about the cockpit's own two creation
 * paths (design-decisions §7), not a slot extensions are invited into. Anything
 * an extension contributes stays a quick action and stays searchable — it just
 * does not get a seat in the four rows a person sees before typing.
 */
export const PALETTE_NEW_ACTION_IDS: readonly string[] = ['new-session', 'create-agent'];

/** Built-in feature palette items (priority 1-4 for core features). */
export const PALETTE_FEATURES: CommandPaletteContribution[] = [
  {
    id: 'tasks',
    label: 'Scheduled tasks',
    icon: 'Clock',
    action: 'openTasks',
    category: 'feature',
    priority: 1,
  },
  {
    id: 'relay',
    label: 'Connections',
    icon: 'Radio',
    action: 'openRelay',
    category: 'feature',
    priority: 2,
    // The words this surface answered to before it had one name, plus the
    // services people actually go looking for. Searching "telegram" or "gmail"
    // should land here whether or not anyone learned the new noun.
    keywords: ['integrations', 'connectors', 'adapters', 'telegram', 'slack', 'webhook', 'gmail'],
  },
  {
    id: 'mesh',
    label: 'Agents',
    icon: 'Globe',
    action: 'openMesh',
    category: 'feature',
    priority: 3,
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: 'Settings',
    action: 'openSettings',
    category: 'feature',
    priority: 4,
  },
  {
    id: 'agent-profile',
    label: 'View profile',
    icon: 'User',
    action: 'openAgentProfile',
    category: 'feature',
    priority: 5,
  },
];

/** Built-in quick action palette items (priority 1-6 for core actions). */
export const PALETTE_QUICK_ACTIONS: CommandPaletteContribution[] = [
  {
    id: 'dashboard',
    label: 'Go home',
    icon: 'Home',
    action: 'navigateDashboard',
    category: 'quick-action',
    priority: 1,
    // `/` is called Home everywhere now (sidebar, window tabs, tab bar). The
    // word it answered to before still finds it, so nobody's muscle memory
    // comes up empty.
    keywords: ['dashboard'],
  },
  {
    id: 'new-session',
    label: 'New Session',
    icon: 'Plus',
    action: 'newSession',
    category: 'quick-action',
    priority: 2,
  },
  {
    id: 'create-agent',
    label: 'Create Agent',
    icon: 'Plus',
    action: 'createAgent',
    category: 'quick-action',
    priority: 3,
  },
  {
    id: 'discover',
    label: 'Bring in existing projects',
    icon: 'Search',
    action: 'discoverAgents',
    category: 'quick-action',
    priority: 4,
  },
  {
    id: 'browse',
    label: 'Browse Filesystem',
    icon: 'FolderOpen',
    action: 'browseFilesystem',
    category: 'quick-action',
    priority: 5,
  },
  {
    id: 'theme',
    label: 'Toggle Theme',
    icon: 'Moon',
    action: 'toggleTheme',
    category: 'quick-action',
    priority: 6,
  },
  {
    id: 'switch-shape',
    label: 'Switch Shape',
    icon: 'Shapes',
    action: 'switchShape',
    category: 'quick-action',
    priority: 7,
  },
  {
    id: 'canvas',
    label: 'Toggle Canvas',
    icon: 'PanelRight',
    action: 'toggleCanvas',
    category: 'quick-action',
    priority: 8,
  },
  {
    id: 'control-center',
    label: 'Control Center',
    icon: 'Zap',
    action: 'openControlCenter',
    category: 'quick-action',
    priority: 9,
    keywords: ['power', 'permissions', 'trust', 'autonomy', 'warm agents', 'mesh', 'overrides'],
  },
  {
    id: 'open-feedback',
    label: 'Send feedback',
    icon: 'MessageSquarePlus',
    action: 'openFeedback',
    category: 'quick-action',
    priority: 10,
    // The GitHub "Report an issue" entry was removed from the palette (it stays
    // under "Help and feedback" in the sidebar footer's `⋯` menu, demoted).
    // Searching these still lands on the in-app dialog, which is now the primary
    // path.
    keywords: ['feedback', 'report', 'bug', 'issue', 'idea', 'feature request'],
  },
];

/** Dev-only palette items. Registered conditionally in init-extensions.ts. */
export const PALETTE_DEV_ACTIONS: CommandPaletteContribution[] = [
  {
    id: 'dev-playground',
    label: 'Open Dev Playground',
    icon: 'LayoutGrid',
    action: 'openDevPlayground',
    category: 'quick-action',
    priority: 90,
  },
  {
    id: 'toggle-rq-devtools',
    label: 'Toggle React Query DevTools',
    icon: 'Bug',
    action: 'toggleDevtools',
    category: 'quick-action',
    priority: 91,
  },
  {
    id: 'toggle-router-devtools',
    label: 'Toggle Router DevTools',
    icon: 'Bug',
    action: 'toggleRouterDevtools',
    category: 'quick-action',
    priority: 92,
  },
];
