import type { PlaygroundSection } from '../playground-registry';

/**
 * Design token sections from TokensPage.
 *
 * IDs must match `slugify(title)` from `lib/slugify.ts`.
 */
export const TOKENS_SECTIONS: PlaygroundSection[] = [
  {
    id: 'client-surface-color',
    title: 'Client Surface Color',
    page: 'tokens',
    category: 'Colors',
    keywords: ['surface', 'color', 'client', 'background'],
  },
  {
    id: 'status-colors',
    title: 'Status Colors',
    page: 'tokens',
    category: 'Colors',
    keywords: ['color', 'status', 'success', 'error', 'warning', 'info', 'pending', 'semantic'],
  },
  {
    id: 'sidebar-colors',
    title: 'Sidebar Colors',
    page: 'tokens',
    category: 'Colors',
    keywords: ['color', 'sidebar', 'navigation', 'panel'],
  },
  {
    id: 'typography',
    title: 'Typography',
    page: 'tokens',
    category: 'Typography',
    keywords: ['type', 'font', 'text', 'scale', 'weight', 'family', 'sans', 'mono', 'size'],
  },
  {
    id: 'spacing',
    title: 'Spacing',
    page: 'tokens',
    category: 'Layout',
    keywords: ['space', 'gap', 'padding', 'margin', 'grid', '8pt'],
  },
  {
    id: 'border-radius',
    title: 'Border Radius',
    page: 'tokens',
    category: 'Shape',
    keywords: ['radius', 'rounded', 'corner', 'shape', 'border'],
  },
  {
    id: 'shadows',
    title: 'Shadows',
    page: 'tokens',
    category: 'Shape',
    keywords: ['shadow', 'elevation', 'depth', 'box-shadow'],
  },
  {
    id: 'client-icon-sizes',
    title: 'Client Icon Sizes',
    page: 'tokens',
    category: 'Layout',
    keywords: ['icon', 'size', 'height', 'width', 'dimension', 'mobile'],
  },
];
