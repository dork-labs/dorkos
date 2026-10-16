/**
 * One picture the lightbox can show, and the two small facts every host needs
 * about it: what to call it when it is saved, and how to save it.
 *
 * @module shared/ui/image-lightbox/lightbox-image
 */

/** A picture the lightbox can show. */
export interface LightboxImage {
  /** Where the bytes are. Server-relative, absolute, or a `data:` URL. */
  src: string;
  /** What the picture shows, for a screen reader and the caption. */
  alt: string;
  /**
   * The file name a download is saved under. Defaults to the last part of
   * `src`, or `image` when that says nothing useful.
   */
  downloadName?: string;
}

/** File extensions a `data:` image is saved with, by its declared type. */
const DATA_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

/**
 * The name a picture is saved under when its host gave none.
 *
 * The last path segment of a URL usually IS the file name (`/api/uploads/
 * shot.png`), so it is used when it has an extension. A route that names an id
 * instead (`/api/sessions/…/images/01J…`) would save as a bare id with no
 * extension, which the OS then cannot open, so that falls back to `image`.
 *
 * @param image - The picture being saved.
 */
export function lightboxDownloadName(image: LightboxImage): string {
  if (image.downloadName) return image.downloadName;
  if (image.src.startsWith('data:')) {
    const type = /^data:([^;,]+)/.exec(image.src)?.[1] ?? '';
    return `image.${DATA_EXTENSIONS[type] ?? 'png'}`;
  }
  try {
    const segment = new URL(image.src, 'http://local').pathname.split('/').pop() ?? '';
    const name = decodeURIComponent(segment);
    return /\.[a-z0-9]{2,5}$/i.test(name) ? name : 'image';
  } catch {
    return 'image';
  }
}

/** Click a throwaway link — the one way a page can ask the browser to save a file. */
function clickLink(href: string, name: string, newTab: boolean): void {
  const link = document.createElement('a');
  link.href = href;
  link.download = name;
  if (newTab) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  document.body.append(link);
  link.click();
  link.remove();
}

/**
 * Save a picture to the reader's computer.
 *
 * **Fetched first, then saved from memory**, because a `download` attribute is
 * honoured only for a same-origin link: an image from anywhere else would
 * navigate instead of saving, and in the desktop app a navigation is a whole
 * second window. Bytes already in memory have no origin to argue about.
 *
 * When the fetch is refused (a server that sends no CORS headers), the plain
 * link is the fallback, in a new tab so the page the reader is on survives
 * either way.
 *
 * @param image - The picture to save.
 */
export async function downloadLightboxImage(image: LightboxImage): Promise<void> {
  const name = lightboxDownloadName(image);
  try {
    const response = await fetch(image.src);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const url = URL.createObjectURL(await response.blob());
    clickLink(url, name, false);
    // The browser reads the URL when the click lands, not synchronously in
    // every engine, so it is revoked a beat later rather than at once.
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  } catch {
    clickLink(image.src, name, true);
  }
}
