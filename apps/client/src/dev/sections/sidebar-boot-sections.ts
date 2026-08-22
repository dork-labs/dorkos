import type { PlaygroundSection } from '../playground-registry';

/** Section registry entries for the Sidebar Boot & Motion page. */
export const SIDEBAR_BOOT_SECTIONS: PlaygroundSection[] = [
  {
    id: 'sidebar-boot',
    title: 'Sidebar Boot',
    page: 'sidebar-boot',
    category: 'Sidebar',
    keywords: [
      'sidebar',
      'boot',
      'skeleton',
      'cold',
      'warm',
      'reveal',
      'loading',
      'first paint',
      'bones',
      'aria-busy',
      'reduced motion',
      'cache',
      'clear cache',
      'local memory',
      'persisted',
      'localStorage',
    ],
  },
  {
    // Motion lives on the boot page because the two are one subject: how the
    // panel behaves over time. The reveal above is the first beat of it, and
    // these four are every beat after (spec `sidebar-simplification` D5).
    id: 'sidebar-motion',
    title: 'Sidebar Motion',
    page: 'sidebar-boot',
    category: 'Sidebar',
    keywords: [
      'sidebar',
      'motion',
      'animation',
      'fold',
      'collapse',
      'spring',
      'chevron',
      'roll-up',
      'arrive',
      'tint',
      'settle',
      'layout',
      'flip',
      'reorder',
      'drag',
      'lift',
      'drop target',
      'ring',
      'reduced motion',
    ],
  },
];
