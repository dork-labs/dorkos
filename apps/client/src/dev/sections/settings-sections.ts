import type { PlaygroundSection } from '../playground-registry';

/**
 * Settings sections from SettingsPage.
 *
 * Sources: SettingsShowcases — Full Settings Dialog, Individual Tabs,
 * Claude Code Accounts, Mobile Drill-In, Loading & Empty States,
 * Settings Primitives.
 */
export const SETTINGS_SECTIONS: PlaygroundSection[] = [
  // Dialogs
  {
    id: 'full-settings-dialog',
    title: 'Full Settings Dialog',
    page: 'settings',
    category: 'Dialogs',
    keywords: ['settings', 'dialog', 'modal', 'full', 'tabs'],
  },
  // Individual tabs
  {
    id: 'individual-tabs',
    title: 'Individual Tabs',
    page: 'settings',
    category: 'Tabs',
    keywords: [
      'appearance',
      'preferences',
      'status bar',
      'server',
      'tools',
      'integrations',
      'agents',
      'advanced',
      'tab',
      'isolated',
    ],
  },
  {
    id: 'claude-code-accounts',
    title: 'Claude Code Accounts',
    page: 'settings',
    category: 'Tabs',
    keywords: [
      'claude',
      'account',
      'billing',
      'client',
      'config dir',
      'CLAUDE_CONFIG_DIR',
      'switch',
    ],
  },
  // Responsive
  {
    id: 'mobile-drill-in',
    title: 'Mobile Drill-In',
    page: 'settings',
    category: 'Responsive',
    keywords: ['mobile', 'drill', 'drawer', 'responsive', 'narrow'],
  },
  // States
  {
    id: 'loading-and-empty-states',
    title: 'Loading & Empty States',
    page: 'settings',
    category: 'States',
    keywords: ['loading', 'empty', 'skeleton', 'placeholder', 'no data'],
  },
  // Primitives
  {
    id: 'settings-primitives',
    title: 'Settings Primitives',
    page: 'settings',
    category: 'Primitives',
    keywords: ['fieldcard', 'settingrow', 'switch', 'row', 'card', 'wrapper'],
  },
];
