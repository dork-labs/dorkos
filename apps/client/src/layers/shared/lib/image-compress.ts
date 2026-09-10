/**
 * Shrink a picture down to something small enough to travel inline with a
 * feedback submission (feedback-attachments decision 3).
 *
 * The image rides WITH the submission as a `data:` URL — client → local server
 * → site → Linear's own asset store — so its size is a bound on the whole
 * request, not just on a file somewhere. This module is the single place that
 * bound is applied: downscale so the longest edge fits
 * {@link MAX_IMAGE_EDGE_PX}, encode WebP at {@link IMAGE_WEBP_QUALITY} (PNG
 * where the browser cannot encode WebP), and refuse anything still over
 * {@link MAX_IMAGE_DATA_URL_LEN} afterwards.
 *
 * **Refusing is the point.** A picture that will not fit is rejected with an
 * {@link ImageCompressError} the caller turns into something the user can see,
 * rather than being quietly dropped on the way to the wire — a submission that
 * silently loses its screenshot is worse than one that never had it, because
 * the reporter believes they sent it.
 *
 * @module shared/lib/image-compress
 */

/**
 * Longest edge, in pixels, a compressed image is scaled down to fit.
 *
 * Big enough that a full-width app screenshot on a retina display still reads
 * (text in a sidebar stays legible), small enough that the encoder has a real
 * chance of landing under {@link MAX_IMAGE_DATA_URL_LEN}. Images already
 * smaller than this are never scaled UP — enlarging a small crop adds bytes and
 * no detail.
 */
export const MAX_IMAGE_EDGE_PX = 2000;

/** Quality handed to the WebP encoder — visually clean, roughly a third of PNG's bytes. */
export const IMAGE_WEBP_QUALITY = 0.8;

/**
 * Hard ceiling, in characters, on the compressed `data:` URL.
 *
 * Deliberately below `MAX_FEEDBACK_SCREENSHOT_DATA_URL_LEN` (850,000), the cap
 * the wire schema enforces: the client refuses first, while there is still a
 * person watching who can pick a smaller picture, so a submission can never be
 * rejected at intake for a reason the sender was never shown.
 */
export const MAX_IMAGE_DATA_URL_LEN = 600_000;

/** The `data:` prefix a canvas produces for each encoding this module accepts. */
const WEBP_PREFIX = 'data:image/webp';
const PNG_PREFIX = 'data:image/png';

/** Why {@link compressImage} refused an image. */
export type ImageCompressReason =
  /** The bytes are not a picture this browser can decode. */
  | 'unreadable'
  /** This browser has no canvas encoder to compress with. */
  | 'unsupported'
  /** Still over {@link MAX_IMAGE_DATA_URL_LEN} after downscaling and encoding. */
  | 'too-large';

/**
 * A refusal from {@link compressImage}, carrying WHY so the caller can say
 * something specific rather than a generic failure.
 *
 * The reason is a closed union rather than a message string on purpose: the
 * wording belongs to whichever surface is showing it, and a surface that has to
 * pattern-match an error message is one refactor away from showing nothing.
 */
export class ImageCompressError extends Error {
  /** Which of the three refusals this is. */
  readonly reason: ImageCompressReason;

  /**
   * Build a refusal.
   *
   * @param reason - Which refusal this is.
   * @param message - Developer-facing detail; never shown to the user verbatim.
   */
  constructor(reason: ImageCompressReason, message: string) {
    super(message);
    this.name = 'ImageCompressError';
    this.reason = reason;
  }
}

/**
 * Decode a source URL into an image element.
 *
 * @param src - An object URL or a `data:` URL.
 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(
        new ImageCompressError('unreadable', `Could not decode the image at ${src.slice(0, 32)}…`)
      );
    image.src = src;
  });
}

/**
 * Encode a drawn canvas, preferring WebP and falling back to PNG.
 *
 * Per the HTML specification a canvas asked for a type it cannot encode answers
 * with a PNG instead of failing, so the prefix that comes back — not a
 * capability flag — is what says which encoder actually ran. Both encodings are
 * shapes the wire schema accepts, so either is a usable answer.
 *
 * @param canvas - A canvas the source image has already been drawn onto.
 */
function encode(canvas: HTMLCanvasElement): string {
  const preferred = canvas.toDataURL('image/webp', IMAGE_WEBP_QUALITY);
  if (preferred.startsWith(WEBP_PREFIX)) return preferred;
  const fallback = preferred.startsWith(PNG_PREFIX) ? preferred : canvas.toDataURL('image/png');
  if (!fallback.startsWith(PNG_PREFIX)) {
    throw new ImageCompressError('unsupported', 'This canvas produced no usable image encoding.');
  }
  return fallback;
}

/**
 * The size the image should be drawn at: unchanged when it already fits, scaled
 * down proportionally when it does not.
 *
 * @param width - The source image's natural width in pixels.
 * @param height - The source image's natural height in pixels.
 * @returns Target width and height, both at least 1px.
 * @internal Exported for testing the scaling arithmetic without a canvas.
 */
export function scaleToFit(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_IMAGE_EDGE_PX / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Downscale and re-encode a picture into a bounded `data:` URL.
 *
 * @param source - A picked file, a pasted or dropped blob, or an existing `data:` URL.
 * @returns A `data:image/webp` (or `data:image/png`) URL no longer than
 *   {@link MAX_IMAGE_DATA_URL_LEN} characters.
 * @throws ImageCompressError When the bytes will not decode, the browser has no
 *   canvas encoder, or the result is still over the cap.
 */
export async function compressImage(source: File | Blob | string): Promise<string> {
  const objectUrl = typeof source === 'string' ? null : URL.createObjectURL(source);
  let image: HTMLImageElement;
  try {
    image = await loadImage(objectUrl ?? (source as string));
  } finally {
    // Safe the moment `onload` has fired: the decoded bitmap outlives the URL.
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }

  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new ImageCompressError('unreadable', 'The image decoded to zero pixels.');
  }

  const target = scaleToFit(sourceWidth, sourceHeight);
  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new ImageCompressError('unsupported', 'This browser gave no 2d canvas context.');
  }
  context.drawImage(image, 0, 0, target.width, target.height);

  const dataUrl = encode(canvas);
  if (dataUrl.length > MAX_IMAGE_DATA_URL_LEN) {
    throw new ImageCompressError(
      'too-large',
      `Compressed to ${dataUrl.length} characters, over the ${MAX_IMAGE_DATA_URL_LEN} cap.`
    );
  }
  return dataUrl;
}
