import type { CommandPaletteContribution } from '@/layers/shared/model';

/** Built-in feature palette items (priority 1-4 for core features). */
export const PALETTE_FEATURES: CommandPaletteContribution[] = [
  {
    id: 'tasks',
    label: 'Tasks Scheduler',
    icon: 'Clock',
    action: 'openTasks',
    category: 'feature',
    priority: 1,
  },
  {
    id: 'relay',
    label: 'Channels',
    icon: 'Radio',
    action: 'openRelay',
    category: 'feature',
    priority: 2,
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
    label: 'Agent Profile',
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
    label: 'Go to Dashboard',
    icon: 'Home',
    action: 'navigateDashboard',
    category: 'quick-action',
    priority: 1,
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
    label: 'Import Projects',
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
    id: 'canvas',
    label: 'Toggle Canvas',
    icon: 'PanelRight',
    action: 'toggleCanvas',
    category: 'quick-action',
    priority: 7,
  },
];
