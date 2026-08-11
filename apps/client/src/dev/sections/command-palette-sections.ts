import type { PlaygroundSection } from '../playground-registry';

/** Command palette component sections from CommandPalettePage. */
export const COMMAND_PALETTE_SECTIONS: PlaygroundSection[] = [
  {
    id: 'command-center-zero-query',
    title: 'Command center (zero query)',
    page: 'command-palette',
    category: 'Command Palette',
    keywords: ['continue', 'recent', 'new', 'zero', 'query', 'session', 'verb', 'row', 'grammar'],
  },
  {
    id: 'ranked-results-typed-query',
    title: 'Ranked results (typed query)',
    page: 'command-palette',
    category: 'Command Palette',
    keywords: [
      'ranking',
      'best',
      'match',
      'relevance',
      'frecency',
      'recency',
      'blended',
      'order',
      'query',
    ],
  },
  {
    id: 'agentcommanditem',
    title: 'AgentCommandItem',
    page: 'command-palette',
    category: 'Command Palette',
    keywords: ['agent', 'item', 'row', 'selection', 'color', 'emoji', 'active', 'palette'],
  },
  {
    id: 'highlightedtext',
    title: 'HighlightedText',
    page: 'command-palette',
    category: 'Command Palette',
    keywords: ['highlight', 'match', 'fuse', 'fuzzy', 'search', 'bold', 'indices'],
  },
  {
    id: 'agentsubmenu',
    title: 'AgentSubMenu',
    page: 'command-palette',
    category: 'Command Palette',
    keywords: ['agent', 'sub', 'menu', 'actions', 'open', 'new tab', 'session', 'drill'],
  },
  {
    id: 'palettefooter',
    title: 'PaletteFooter',
    page: 'command-palette',
    category: 'Command Palette',
    keywords: ['footer', 'keyboard', 'shortcut', 'hint', 'navigate', 'enter', 'escape'],
  },
  {
    id: 'edge-cases',
    title: 'Edge Cases',
    page: 'command-palette',
    category: 'Command Palette',
    keywords: ['edge', 'truncation', 'long', 'empty', 'scroll', 'overflow', 'untitled'],
  },
  {
    id: 'live-palette',
    title: 'Live Palette',
    page: 'command-palette',
    category: 'Command Palette',
    keywords: ['live', 'cmd', 'k', 'global', 'frecency', 'prefix', 'search', 'full'],
  },
];
