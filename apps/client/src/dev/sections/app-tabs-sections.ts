import type { PlaygroundSection } from '../playground-registry';

/**
 * The window tab strip's sections: the strip, what each tab says, and how
 * tabs are pinned, moved and closed. Spread into the components page's list
 * where the strip's showcases render, so the TOC order matches the page.
 *
 * Sources: NavigationShowcases (AppTabStrip), TabStripInteractionsShowcases,
 * TabIdentityShowcases.
 */
export const APP_TABS_SECTIONS: PlaygroundSection[] = [
  {
    id: 'apptabstrip',
    title: 'AppTabStrip',
    page: 'components',
    category: 'Navigation',
    keywords: ['tab', 'tabs', 'strip', 'window', 'titlebar', 'close', 'new tab', 'session'],
  },
  // TabStripInteractionsShowcases
  {
    id: 'tab-strip-interactions',
    title: 'Tab strip interactions',
    page: 'components',
    category: 'Navigation',
    keywords: [
      'tab',
      'tabs',
      'pin',
      'pinned',
      'duplicate',
      'copy link',
      'close others',
      'drag',
      'reorder',
      'context menu',
    ],
  },
  // TabIdentityShowcases
  {
    id: 'tab-identity',
    title: 'Tab identity',
    page: 'components',
    category: 'Navigation',
    keywords: [
      'tab',
      'identity',
      'status',
      'hover card',
      'window title',
      'paused',
      'needs you',
      'unread',
      'smart names',
    ],
  },
];
