import type { PlaygroundSection } from '../../playground-registry';

/**
 * Overlay surface sections from OverlaysPage.
 *
 * Source: OverlaySurfaceShowcases.
 */
export const OVERLAYS_SECTIONS: PlaygroundSection[] = [
  {
    id: 'menus',
    title: 'Menus',
    page: 'overlays',
    category: 'Surfaces',
    keywords: ['dropdown', 'context', 'select', 'menu', 'row', 'highlight', 'separator', 'drawer'],
  },
  {
    id: 'floating-surfaces',
    title: 'Floating surfaces',
    page: 'overlays',
    category: 'Surfaces',
    keywords: ['popover', 'hover card', 'tooltip', 'delay', 'touch'],
  },
  {
    id: 'modal-surfaces',
    title: 'Modal surfaces',
    page: 'overlays',
    category: 'Surfaces',
    keywords: ['dialog', 'alert', 'sheet', 'drawer', 'grabber', 'focus', 'scroll edge'],
  },
];
