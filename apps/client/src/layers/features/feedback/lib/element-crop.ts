/**
 * Cut one element out of a picture of the whole app (feedback-attachments
 * decision 9).
 *
 * A report that points at a thing should arrive showing that thing, not a
 * full-screen shot with the thing somewhere in it. The gesture happens in CSS
 * pixels — `getBoundingClientRect()` and the viewport — and the picture is in
 * image pixels, which are NOT the same pixels and are not off by a constant
 * either:
 *
 * - The desktop shell's `capturePage()` hands back **device** pixels, so a
 *   retina window comes back at twice the CSS size.
 * - snapdom re-draws the DOM at its `scale` option, which is 1, so its picture
 *   is CSS-sized — and it frames `#root`, which on a scrolling page is taller
 *   than the window and starts above it.
 *
 * So neither the scale nor the origin can be assumed. Both are DERIVED, from the
 * region the capture reports against the size the image actually came back at —
 * which means this arithmetic stays right if either engine changes its mind
 * about pixel ratios, and it is why {@link computeElementCrop} takes the numbers
 * rather than reading any of them from the DOM. Being pure is what makes the one
 * genuinely error-prone part of this feature testable at every ratio and every
 * edge without a browser.
 *
 * @module features/feedback/lib/element-crop
 */
import {
  AppCaptureError,
  compressImage,
  getAppCaptureRoot,
  IMAGE_DECODE_TIMEOUT_MS,
  type AppCaptureRegion,
  type AppCaptureShot,
} from '@/layers/shared/lib';

/**
 * How much room to leave around the element, in CSS pixels.
 *
 * An element cut out exactly at its own edges reads as a floating fragment: a
 * button with no gap around it could be any button. A little of what surrounds
 * it is what makes the crop recognisable as a place in the app, and 24px is
 * about one comfortable gutter in this design system — enough for context,
 * little enough that a small control still fills the picture.
 */
export const ELEMENT_CROP_PADDING_PX = 24;

/** A rectangle in CSS pixels, measured from the viewport's top-left corner. */
export interface CssRect {
  /** Distance from the viewport's left edge. */
  left: number;
  /** Distance from the viewport's top edge. */
  top: number;
  /** Width in CSS pixels. */
  width: number;
  /** Height in CSS pixels. */
  height: number;
}

/** A rectangle in the captured image's own pixels, ready for `drawImage`. */
export interface ImageCrop {
  /** Left edge of the source rectangle, in image pixels. */
  sx: number;
  /** Top edge of the source rectangle, in image pixels. */
  sy: number;
  /** Width of the source rectangle, in image pixels. */
  sw: number;
  /** Height of the source rectangle, in image pixels. */
  sh: number;
}

/** Everything {@link computeElementCrop} needs, and nothing it could read wrong. */
export interface ElementCropInput {
  /** The element's box, as `getBoundingClientRect()` reports it. */
  element: CssRect;
  /** The visible viewport, in CSS pixels. */
  viewport: { width: number; height: number };
  /** What the picture covers, in CSS pixels — see `AppCaptureRegion`. */
  region: AppCaptureRegion;
  /** The captured image's real size, in image pixels. */
  image: { width: number; height: number };
  /** Room to leave around the element. Defaults to {@link ELEMENT_CROP_PADDING_PX}. */
  padding?: number;
}

/** The overlap of two rectangles, or `null` when they do not overlap at all. */
function intersect(a: CssRect, b: CssRect): CssRect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Work out which pixels of the capture show the element.
 *
 * Pads the element's box, clips it to what the person can actually see, clips
 * that to what the picture actually contains, and converts the result into the
 * image's own pixels at whatever scale the capture came back at.
 *
 * Both clips are load-bearing and neither replaces the other. The viewport clip
 * is the promise the overlay makes — the crop shows what was on screen, not the
 * off-screen half of an element scrolled past the fold. The region clip is
 * safety: sampling outside a canvas source rectangle is transparent pixels, so
 * an element beyond the picture's edge would come back as a band of nothing.
 *
 * @param input - See {@link ElementCropInput}.
 * @returns The source rectangle in image pixels, or `null` when the element is
 *   not inside both the viewport and the picture — at which point there is
 *   nothing of it to show and the caller should say so rather than crop noise.
 */
export function computeElementCrop(input: ElementCropInput): ImageCrop | null {
  const { element, viewport, region, image } = input;
  const padding = input.padding ?? ELEMENT_CROP_PADDING_PX;
  // A region of no area needs no guard of its own — it cannot intersect
  // anything, so the clip below already refuses it. An IMAGE of no area does:
  // it makes both scales zero, which collapses every crop to the top-left
  // corner and then floors it back up to a 1x1 picture of nothing.
  if (image.width <= 0 || image.height <= 0) return null;

  const padded: CssRect = {
    left: element.left - padding,
    top: element.top - padding,
    width: element.width + padding * 2,
    height: element.height + padding * 2,
  };

  const onScreen = intersect(padded, {
    left: 0,
    top: 0,
    width: viewport.width,
    height: viewport.height,
  });
  if (!onScreen) return null;
  const inPicture = intersect(onScreen, region);
  if (!inPicture) return null;

  // Derived per axis rather than once: an engine that letterboxes, or a window
  // whose height is rounded differently to its width, would otherwise skew the
  // crop along one axis only — the kind of wrong that looks almost right.
  const scaleX = image.width / region.width;
  const scaleY = image.height / region.height;

  const sx = Math.round((inPicture.left - region.left) * scaleX);
  const sy = Math.round((inPicture.top - region.top) * scaleY);
  // Rounded from the far EDGE, not by rounding the width: rounding both corners
  // independently is what keeps a crop from drifting a pixel wider or narrower
  // than the box it was measured from.
  const right = Math.round((inPicture.left + inPicture.width - region.left) * scaleX);
  const bottom = Math.round((inPicture.top + inPicture.height - region.top) * scaleY);

  // The far edges need no clamp of their own: the region clip above already put
  // them inside the picture, and `region.width * scaleX` IS `image.width`. The
  // near edges do — a rectangle whose left edge rounds up to the image's own
  // width has no room left to be one pixel wide.
  const clampedX = Math.min(Math.max(0, sx), Math.max(0, image.width - 1));
  const clampedY = Math.min(Math.max(0, sy), Math.max(0, image.height - 1));
  // A sub-pixel element (a 1px divider, a hairline rule) rounds to nothing at a
  // small scale. One pixel of picture is still a picture; zero is a canvas the
  // browser refuses to encode.
  return {
    sx: clampedX,
    sy: clampedY,
    sw: Math.max(1, right - clampedX),
    sh: Math.max(1, bottom - clampedY),
  };
}

/**
 * Decode a `data:` URL into an image element, giving up after
 * {@link IMAGE_DECODE_TIMEOUT_MS}.
 *
 * Bounded for the same reason `compressImage`'s own decode is, and the bound is
 * the same one: an `Image` handed bytes it cannot make progress on may fire
 * NEITHER `load` nor `error`, and a promise that never settles here leaves the
 * dialog's "preparing" flag stuck on — which disables Send for the rest of the
 * session, on a report the person has already written. The capture's own timeout
 * does not cover this: it ends the moment the capture hands back a picture, and
 * this is what happens to that picture next.
 *
 * @param dataUrl - The capture to decode.
 */
function decode(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const element = new Image();
    const refuse = (detail: string) => {
      clearTimeout(timer);
      reject(new AppCaptureError('failed', detail));
    };
    const timer = setTimeout(
      () => refuse(`The capture did not decode within ${IMAGE_DECODE_TIMEOUT_MS}ms.`),
      IMAGE_DECODE_TIMEOUT_MS
    );
    element.onload = () => {
      clearTimeout(timer);
      resolve(element);
    };
    element.onerror = () => refuse('The capture did not decode, so it cannot be cropped.');
    element.src = dataUrl;
  });
}

/**
 * Redraw just the cropped rectangle onto a canvas of its own.
 *
 * PNG on the way out, and lossless is the point: the result goes straight into
 * `compressImage`, which re-encodes it to WebP. Handing that step a lossy
 * intermediate would compress an already-compressed picture twice and show it in
 * the artefacts, on the one image whose whole job is to be looked at closely.
 *
 * @param image - The decoded capture.
 * @param crop - Which pixels to keep.
 * @returns A `data:image/png` URL of the crop alone.
 * @throws AppCaptureError When the browser gives no 2d context.
 */
function cropToDataUrl(image: HTMLImageElement, crop: ImageCrop): string {
  const canvas = document.createElement('canvas');
  canvas.width = crop.sw;
  canvas.height = crop.sh;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new AppCaptureError('failed', 'This browser gave no 2d canvas context to crop with.');
  }
  context.drawImage(image, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh);
  return canvas.toDataURL('image/png');
}

/**
 * Turn a whole-app capture into the bounded picture of one element.
 *
 * The crop is computed against the element's box as it stands NOW rather than
 * when it was clicked, because the capture takes two frames of hiding plus a
 * full re-draw and the layout underneath is free to move in that time. Measuring
 * late means the crop matches the picture that was just taken.
 *
 * **Two refusals come before any pixels are touched**, and both are cases where
 * {@link computeElementCrop} would otherwise return a perfectly valid rectangle
 * over the wrong part of the picture:
 *
 * 1. The element has **no box** — `display: none`, a wrapper that lays out to
 *    nothing, or a node detached from the document, all of which measure
 *    {0,0,0,0}. The padding grows that into a 48x48 box straddling the origin,
 *    and the origin is inside every picture, so the report would arrive cropped
 *    to the top-left corner of the app: sharp, confident, and of nothing. (There
 *    is no separate `isConnected` check, because a detached node has no box by
 *    definition and is outside the root besides — it is caught twice over here,
 *    and a guard that can never be the one to fire is not worth reading.)
 * 2. The element is **outside the captured app root** — a Radix popover or
 *    tooltip portaled to `<body>`. Neither path photographs those: snapdom never
 *    frames them, and the desktop shell photographs them faded to nothing. So
 *    their rectangle in the picture holds whatever the app was showing BEHIND
 *    them, which is a picture of the wrong thing rather than no picture.
 *
 * @param shot - What `captureAppShot()` produced.
 * @param element - The element to crop to.
 * @returns A compressed `data:` URL of the element and its surroundings.
 * @throws ImageCompressError From the compression step.
 * @throws AppCaptureError For either refusal above, when the capture will not
 *   decode, when the element has left the frame entirely, or when the crop
 *   cannot be drawn — the same refusal shape the capture itself uses, so the
 *   dialog has one sentence for "no picture" however far the attempt got.
 */
export async function cropShotToElement(shot: AppCaptureShot, element: Element): Promise<string> {
  const box = element.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) {
    throw new AppCaptureError('failed', 'That element has no size to crop to.');
  }
  if (!getAppCaptureRoot().contains(element)) {
    throw new AppCaptureError('failed', 'That element is not part of the app that was captured.');
  }

  const image = await decode(shot.dataUrl);
  const crop = computeElementCrop({
    element: { left: box.left, top: box.top, width: box.width, height: box.height },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    region: shot.region,
    image: {
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height,
    },
  });
  if (!crop) {
    throw new AppCaptureError('failed', 'That element is no longer inside the captured picture.');
  }
  return compressImage(cropToDataUrl(image, crop));
}
