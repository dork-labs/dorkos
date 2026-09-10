/**
 * Shrink a picture down to something small enough to travel inline with a
 * feedback submission (feedback-attachments decision 3).
 *
 * The image rides WITH the submission as a `data:` URL — client → local server
 * → site → Linear's own asset store — so its size is a bound on the whole
 * request, not just on a file somewhere. This module is the single place that
 * bound is applied: downscale so the longest edge fits
 * {@link MAX_IMAGE_EDGE_PX}, encode with the first of WebP / JPEG / PNG the
 * browser can actually produce, take one step down in size and quality if that
 * lands over {@link MAX_IMAGE_DATA_URL_LEN}, and refuse anything still over it.
 *
 * **Refusing is the point.** A picture that will not fit is rejected with an
 * {@link ImageCompressError} the caller turns into something the user can see,
 * rather than being quietly dropped on the way to the wire — a submission that
 * silently loses its screenshot is worse than one that never had it, because
 * the reporter believes they sent it. That promise covers the CLIENT leg only:
 * once a submission is accepted here, the server may still drop the screenshot
 * and retry without it if the site's intake answers 413 (PR 1 behaviour), which
 * is the durable record's choice to make and not something this module can see.
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

/** Quality handed to the lossy encoders — visually clean, a fraction of PNG's bytes. */
export const IMAGE_ENCODE_QUALITY = 0.8;

/**
 * Longest edge for the second attempt, when the first lands over the cap.
 *
 * Half the pixels of a 2000px edge, which is roughly half the encoded bytes —
 * enough to rescue the case the retry exists for (a PNG-only browser, where the
 * first attempt can miss by a wide margin) without dropping so far that the
 * screenshot stops being readable evidence.
 */
export const RETRY_IMAGE_EDGE_PX = 1400;

/** Quality for that second attempt — lower, because fitting now matters more than fidelity. */
export const RETRY_IMAGE_QUALITY = 0.6;

/**
 * Hard ceiling, in characters, on the compressed `data:` URL.
 *
 * Deliberately below `MAX_FEEDBACK_SCREENSHOT_DATA_URL_LEN` (850,000), the cap
 * the wire schema enforces: the client refuses first, while there is still a
 * person watching who can crop to something smaller, so a submission can never
 * be rejected at intake for a reason the sender was never shown.
 */
export const MAX_IMAGE_DATA_URL_LEN = 600_000;

/** How long to wait for a picture to decode before calling it unreadable. */
export const IMAGE_DECODE_TIMEOUT_MS = 10_000;

/**
 * Encodings this module will produce, best first.
 *
 * WebP is smallest; JPEG is the one that matters most here, because it is the
 * fallback that keeps a photo under the cap on a browser with no canvas WebP
 * encoder — PNG of the same picture routinely runs several times the ceiling.
 * PNG stays last as the encoding every canvas is required to support. All three
 * are shapes the wire schema accepts.
 */
const ENCODINGS = ['image/webp', 'image/jpeg', 'image/png'] as const;

/** A `data:` URL carrying one of the three encodings, as the wire schema spells it. */
const ACCEPTED_DATA_URL = /^data:image\/(webp|png|jpeg);base64,/;

/** Why {@link compressImage} refused an image. */
export type ImageCompressReason =
  /** The bytes are not a picture this browser can decode, or decoding timed out. */
  | 'unreadable'
  /** This browser has no canvas encoder to compress with. */
  | 'unsupported'
  /** Still over {@link MAX_IMAGE_DATA_URL_LEN} after the step-down retry. */
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
 * Whether a string is a `data:` URL this module would have produced — one of the
 * three accepted encodings, and inside {@link MAX_IMAGE_DATA_URL_LEN}.
 *
 * The guard for an image that arrives ALREADY compressed, from a caller rather
 * than from a person picking a file. Such a value never passes through
 * {@link compressImage}, so without this check nothing would bound it before it
 * reached the wire, and an over-cap or non-image value would fail at intake
 * instead of here.
 *
 * @param value - A candidate `data:` URL.
 */
export function isAcceptableImageDataUrl(value: string): boolean {
  return ACCEPTED_DATA_URL.test(value) && value.length <= MAX_IMAGE_DATA_URL_LEN;
}

/**
 * Decode a source URL into an image element, giving up after
 * {@link IMAGE_DECODE_TIMEOUT_MS}.
 *
 * The bound is what keeps a caller's "preparing…" state from lasting forever: an
 * `Image` handed something it cannot make progress on may fire neither `load`
 * nor `error`, and a promise that never settles is a spinner that never stops.
 *
 * @param src - An object URL or a `data:` URL.
 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = setTimeout(() => {
      reject(
        new ImageCompressError(
          'unreadable',
          `Decoding timed out after ${IMAGE_DECODE_TIMEOUT_MS}ms.`
        )
      );
    }, IMAGE_DECODE_TIMEOUT_MS);
    image.onload = () => {
      clearTimeout(timer);
      resolve(image);
    };
    image.onerror = () => {
      clearTimeout(timer);
      reject(
        new ImageCompressError('unreadable', `Could not decode the image at ${src.slice(0, 32)}…`)
      );
    };
    image.src = src;
  });
}

/**
 * Encode a drawn canvas as the first of {@link ENCODINGS} it can actually
 * produce.
 *
 * Per the HTML specification a canvas asked for a type it cannot encode answers
 * with a PNG instead of failing, so the prefix that comes back — not a
 * capability flag — is what says which encoder actually ran. A substituted PNG
 * is therefore not taken as a WebP answer; it falls through to the next
 * candidate, and is only accepted once PNG is what was asked for.
 *
 * @param canvas - A canvas the source image has already been drawn onto.
 * @param quality - Quality for the lossy encodings; PNG ignores it.
 */
function encode(canvas: HTMLCanvasElement, quality: number): string {
  for (const type of ENCODINGS) {
    const encoded = canvas.toDataURL(type, quality);
    if (encoded.startsWith(`data:${type};base64,`)) return encoded;
  }
  throw new ImageCompressError('unsupported', 'This canvas produced no usable image encoding.');
}

/**
 * The size the image should be drawn at: unchanged when it already fits, scaled
 * down proportionally when it does not.
 *
 * @param width - The source image's natural width in pixels.
 * @param height - The source image's natural height in pixels.
 * @param maxEdge - Longest edge to fit within. Defaults to {@link MAX_IMAGE_EDGE_PX}.
 * @returns Target width and height, both at least 1px.
 * @internal Exported for testing the scaling arithmetic without a canvas.
 */
export function scaleToFit(
  width: number,
  height: number,
  maxEdge: number = MAX_IMAGE_EDGE_PX
): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Draw the image at one target size and encode it once.
 *
 * @param image - The decoded source image.
 * @param size - Target width and height in pixels.
 * @param quality - Quality for the lossy encodings.
 */
function drawAndEncode(
  image: HTMLImageElement,
  size: { width: number; height: number },
  quality: number
): string {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new ImageCompressError('unsupported', 'This browser gave no 2d canvas context.');
  }
  context.drawImage(image, 0, 0, size.width, size.height);
  return encode(canvas, quality);
}

/**
 * Downscale and re-encode a picture into a bounded `data:` URL.
 *
 * @param source - A picked file, a pasted or dropped blob, or an existing `data:` URL.
 * @returns A `data:image/webp`, `data:image/jpeg` or `data:image/png` URL no
 *   longer than {@link MAX_IMAGE_DATA_URL_LEN} characters.
 * @throws ImageCompressError When the bytes will not decode, the browser has no
 *   canvas encoder, or the result is still over the cap after the retry.
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

  let dataUrl = drawAndEncode(image, scaleToFit(sourceWidth, sourceHeight), IMAGE_ENCODE_QUALITY);
  if (dataUrl.length > MAX_IMAGE_DATA_URL_LEN) {
    // One step down, not a search: a loop would spend a visible amount of time
    // encoding the same picture over and over, and the second attempt is where
    // nearly all of the recoverable cases land.
    dataUrl = drawAndEncode(
      image,
      scaleToFit(sourceWidth, sourceHeight, RETRY_IMAGE_EDGE_PX),
      RETRY_IMAGE_QUALITY
    );
  }
  if (dataUrl.length > MAX_IMAGE_DATA_URL_LEN) {
    throw new ImageCompressError(
      'too-large',
      `Compressed to ${dataUrl.length} characters, over the ${MAX_IMAGE_DATA_URL_LEN} cap.`
    );
  }
  return dataUrl;
}
