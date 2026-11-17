import type { PlaygroundSection } from '../playground-registry';

/**
 * Sections for the monthly spend limit on paid app actions (DOR-4204), shown
 * on the Home, Inbox & Approvals page beside the other Connections surfaces.
 *
 * Source: SpendingShowcases.
 */
export const SPENDING_SECTIONS: PlaygroundSection[] = [
  {
    id: 'spending',
    title: 'Spending',
    page: 'home-inbox',
    category: 'Connections',
    keywords: ['spending', 'limit', 'monthly', 'money', 'paid', 'meter', 'where it went'],
  },
  {
    id: 'paid-run-card',
    title: 'Paid-run card',
    page: 'home-inbox',
    category: 'Connections',
    keywords: ['paid', 'spend', 'approval', 'card', 'allow once', 'price', 'set a limit'],
  },
  {
    id: 'spends-money-marker',
    title: 'Spends money marker',
    page: 'home-inbox',
    category: 'Connections',
    keywords: ['spends money', 'coins', 'marker', 'paid', 'chip'],
  },
];
