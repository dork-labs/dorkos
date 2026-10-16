/**
 * Click a picture in a message, see it big — the lightbox every message
 * renderer opens its images in.
 *
 * Hosts render {@link ImageLightboxGroup} around one message and
 * {@link ImageLightboxTrigger} around each thumbnail; Markdown surfaces get the
 * same thing for free through {@link MarkdownImage}. The viewer itself is
 * fetched on first open and is not exported: nothing renders it directly.
 *
 * @module shared/ui/image-lightbox
 */
export { ImageLightboxGroup, ImageLightboxTrigger } from './image-lightbox-group';
export type { ImageLightboxGroupProps, ImageLightboxTriggerProps } from './image-lightbox-group';
export { MarkdownImage } from './markdown-image';
export type { MarkdownImageProps } from './markdown-image';
export { lightboxDownloadName } from './lightbox-image';
export type { LightboxImage } from './lightbox-image';
