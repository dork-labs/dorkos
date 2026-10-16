import type { PlaygroundSection } from '../../playground-registry';

/**
 * The lightbox a message's pictures open in. Its own file because the
 * Conversation page's main section list is at its size cap; the page composes
 * both.
 */
export const IMAGE_LIGHTBOX_SECTIONS: PlaygroundSection[] = [
  {
    id: 'image-lightbox',
    title: 'Image lightbox',
    page: 'conversation',
    category: 'Messages',
    keywords: ['image', 'picture', 'lightbox', 'zoom', 'gallery', 'attachment', 'photo', 'viewer'],
  },
  {
    id: 'image-lightbox-states',
    title: 'Image lightbox states',
    page: 'conversation',
    category: 'Messages',
    keywords: ['image', 'lightbox', 'single', 'error', 'broken', 'missing'],
  },
];
