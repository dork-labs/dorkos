import type { PlaygroundSection } from '../playground-registry';

/** Message action-surface sections for the Entry Actions playground page. */
export const ENTRY_ACTIONS_SECTIONS: PlaygroundSection[] = [
  {
    id: 'revealing-the-toolbar',
    title: 'Revealing the toolbar',
    page: 'entry-actions',
    category: 'Entry Actions',
    keywords: ['hover', 'focus', 'reveal', 'opacity', 'toolbar', 'message', 'room', 'keyboard'],
  },
  {
    id: 'the-sticky-rail',
    title: 'The sticky rail',
    page: 'entry-actions',
    category: 'Entry Actions',
    keywords: ['sticky', 'rail', 'clamp', 'scroll', 'tall', 'long message', 'viewport', 'anchor'],
  },
  {
    id: 'how-many-actions',
    title: 'How many actions',
    page: 'entry-actions',
    category: 'Entry Actions',
    keywords: ['reply', 'copy', 'mention', 'action set', 'count', 'pill', 'width', 'reactions'],
  },
  {
    id: 'grouped-and-ungrouped',
    title: 'Grouped and ungrouped',
    page: 'entry-actions',
    category: 'Entry Actions',
    keywords: ['group', 'continuation', 'first', 'middle', 'last', 'avatar', 'gutter', 'rhythm'],
  },
  {
    id: 'both-themes',
    title: 'Both themes',
    page: 'entry-actions',
    category: 'Entry Actions',
    keywords: ['theme', 'dark', 'light', 'opaque', 'popover', 'shadow', 'elevation', 'contrast'],
  },
];
