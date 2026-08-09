import type { PlaygroundSection } from '../playground-registry';

/** Feature promo system sections from PromosPage. */
export const PROMOS_SECTIONS: PlaygroundSection[] = [
  {
    id: 'promo-registry',
    title: 'Promo Registry',
    page: 'promos',
    category: 'Promos',
    keywords: ['promo', 'registry', 'feature', 'discovery', 'shouldshow', 'placement', 'priority'],
  },
  {
    id: 'promoslot-dashboard-sidebar',
    title: 'PromoSlot — dashboard-sidebar',
    page: 'promos',
    category: 'Promos',
    keywords: ['promo', 'slot', 'dashboard', 'sidebar', 'compact'],
  },
  {
    id: 'promoslot-agent-sidebar',
    title: 'PromoSlot — agent-sidebar',
    page: 'promos',
    category: 'Promos',
    keywords: ['promo', 'slot', 'agent', 'sidebar', 'compact', 'session'],
  },
  {
    id: 'override-controls',
    title: 'Override Controls',
    page: 'promos',
    category: 'Promos',
    keywords: ['promo', 'dismiss', 'reset', 'toggle', 'global', 'override', 'localstorage'],
  },
  {
    id: 'dialog-previews',
    title: 'Dialog Previews',
    page: 'promos',
    category: 'Promos',
    keywords: ['promo', 'dialog', 'preview', 'modal', 'relay', 'schedule', 'remote', 'access'],
  },
];
