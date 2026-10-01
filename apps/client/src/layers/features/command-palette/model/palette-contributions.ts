import type { CommandPaletteContribution, SettingsTab } from '@/layers/shared/model';
import { SETTINGS_TAB_DIRECTORY } from '@/layers/shared/lib';

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

/** Action-id prefix for a row that opens Settings on one tab: `openSettingsTab:<tab id>`. */
const SETTINGS_TAB_ACTION_PREFIX = 'openSettingsTab:';

/**
 * The Settings tab a palette action opens, or null when the action is not one
 * of the per-tab rows.
 *
 * @param action - A palette action id.
 */
export function settingsTabForAction(action: string): SettingsTab | null {
  return action.startsWith(SETTINGS_TAB_ACTION_PREFIX)
    ? action.slice(SETTINGS_TAB_ACTION_PREFIX.length)
    : null;
}

/**
 * One searchable row per built-in Settings tab (extension tabs are not listed), straight to that tab by its deep link
 * (DOR-2629). It matters most for the five behind the Advanced fold — typing
 * "danger" or "room limits" should not depend on knowing where they are filed.
 * The rows only appear when searching; the zero-query palette is unchanged.
 */
const PALETTE_SETTINGS_TABS: CommandPaletteContribution[] = SETTINGS_TAB_DIRECTORY.map(
  (tab, index) => ({
    id: `settings-${tab.id}`,
    // The tab's own name leads, so typing it lands here — and typing
    // "settings" still finds the plain Settings row first, not sixteen tabs.
    label: `${tab.label} — Settings`,
    icon: 'Settings',
    action: `${SETTINGS_TAB_ACTION_PREFIX}${tab.id}`,
    category: 'feature',
    // After every core feature, in sidebar order.
    priority: 20 + index,
    // The group's name, so "advanced" lists everything behind the fold. Not
    // "settings": that word belongs to the plain Settings row.
    keywords: [tab.group.toLowerCase()],
  })
);

/** Built-in feature palette items (priority 1-5 for core features, then one row per Settings tab). */
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
  ...PALETTE_SETTINGS_TABS,
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
    label: 'New session',
    icon: 'Plus',
    action: 'newSession',
    category: 'quick-action',
    priority: 2,
  },
  {
    id: 'create-agent',
    label: 'Create agent',
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
    label: 'Browse filesystem',
    icon: 'FolderOpen',
    action: 'browseFilesystem',
    category: 'quick-action',
    priority: 5,
  },
  {
    id: 'theme',
    label: 'Toggle theme',
    icon: 'Moon',
    action: 'toggleTheme',
    category: 'quick-action',
    priority: 6,
  },
  {
    id: 'switch-shape',
    label: 'Switch shape',
    icon: 'Shapes',
    action: 'switchShape',
    category: 'quick-action',
    priority: 7,
  },
  {
    id: 'canvas',
    label: 'Toggle canvas',
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
    // The GitHub "Report an issue" entry was removed from the palette; that path
    // is one link in the feedback form's own footer now (DOR-2232). Searching
    // these lands on the in-app dialog, which is the primary path.
    keywords: ['feedback', 'report', 'bug', 'issue', 'idea', 'feature request'],
  },
  {
    id: 'your-reports',
    label: 'Your reports',
    icon: 'Inbox',
    action: 'openYourReports',
    category: 'quick-action',
    priority: 11,
    // What the help menu calls the person's own sent reports (DOR-2232). The
    // phone has no help menu to find it in, so the palette is one of its doors.
    keywords: ['feedback', 'reports', 'my reports', 'sent', 'status', 'requests'],
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
