import type { PlaygroundSection } from '../playground-registry';

/** Section registry entries for the Sidebar Model page. */
export const SIDEBAR_MODEL_SECTIONS: PlaygroundSection[] = [
  {
    id: 'sidebar-model-journeys',
    title: 'Sidebar Model Journeys',
    page: 'sidebar-model',
    category: 'Sidebar',
    keywords: [
      'sidebar',
      'model',
      'zones',
      'now',
      'today',
      'library',
      'getting started',
      'fixtures',
      'journeys',
      'reason',
      'first run',
      'quiet',
      'busy',
      'power',
    ],
  },
  {
    id: 'sidebar-unread-tiers',
    title: 'Sidebar Unread Tiers',
    page: 'sidebar-model',
    category: 'Sidebar',
    keywords: ['sidebar', 'unread', 'badge', 'bold', 'mention', 'dm', 'directed', 'activity'],
  },
];
