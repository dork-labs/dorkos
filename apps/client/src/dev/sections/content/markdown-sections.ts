import type { PlaygroundSection } from '../../playground-registry';

/** Real canvas editor states for typography, theme, and interaction review. */
export const MARKDOWN_SECTIONS: PlaygroundSection[] = [
  {
    id: 'markdown-reading',
    title: 'Markdown reading',
    page: 'markdown',
    category: 'Canvas',
    keywords: ['blintz', 'typography', 'lists', 'tables', 'code', 'math', 'theme'],
  },
  {
    id: 'markdown-canvas',
    title: 'Markdown canvas',
    page: 'markdown',
    category: 'Canvas',
    keywords: ['blintz', 'canvas', 'session', 'scrolling'],
  },
  {
    id: 'markdown-editing',
    title: 'Markdown editing',
    page: 'markdown',
    category: 'Canvas',
    keywords: ['blintz', 'editing', 'toolbar', 'slash', 'source'],
  },
  {
    id: 'markdown-narrow-panel',
    title: 'Markdown narrow panel',
    page: 'markdown',
    category: 'Canvas',
    keywords: ['blintz', 'mobile', 'responsive', 'overflow'],
  },
  {
    id: 'markdown-frontmatter',
    title: 'Markdown frontmatter',
    page: 'markdown',
    category: 'Canvas',
    keywords: ['blintz', 'metadata', 'yaml'],
  },
  {
    id: 'markdown-empty-document',
    title: 'Markdown empty document',
    page: 'markdown',
    category: 'Canvas',
    keywords: ['blintz', 'placeholder', 'empty'],
  },
];
