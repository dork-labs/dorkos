import type { PlaygroundSection } from '../playground-registry';

/**
 * Settings sections from SettingsPage.
 *
 * Sources: SettingsShowcases — Full Settings Dialog, Full Agent Dialog,
 * Individual Tabs, Mobile Drill-In, Loading & Empty States, Settings Primitives.
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
  {
    id: 'full-agent-dialog',
    title: 'Full Agent Dialog',
    page: 'settings',
    category: 'Dialogs',
    keywords: ['agent', 'dialog', 'modal', 'configuration'],
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
      'channels',
      'agents',
      'advanced',
      'tab',
      'isolated',
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
