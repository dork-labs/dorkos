/**
 * The geometry that makes a picture grow out of its thumbnail and shrink back
 * into it: where the thumbnail is, relative to where the viewer will draw it.
 *
 * @module shared/ui/image-lightbox/flip
 */

/** A picture's position as an offset from the stage's centre and a scale. */
export interface FlipOffset {
  x: number;
  y: number;
  scale: number;
}

/** A box on screen. */
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where a picture with this natural size actually draws inside a box, when it
 * is fitted with `object-contain` and never enlarged past its own size.
 *
 * @param natural - The picture's own width and height in pixels.
 * @param box - The box it is fitted into.
 * @param allowUpscale - Whether it may draw larger than its natural size.
 */
export function containedBox(
  natural: { width: number; height: number },
  box: Box,
  allowUpscale: boolean
): Box {
  const fit = Math.min(box.width / natural.width, box.height / natural.height);
  const ratio = allowUpscale ? fit : Math.min(fit, 1);
  const width = natural.width * ratio;
  const height = natural.height * ratio;
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
  };
}

/**
 * The offset and scale that put the viewer's picture exactly over its
 * thumbnail, or `null` when there is nothing sensible to grow from: a
 * thumbnail not yet loaded, scrolled out of view, or with no size at all.
 *
 * @param thumb - The thumbnail `<img>` on the page.
 * @param stage - The box the viewer fits the picture into.
 * @param viewport - The visible window, to tell a scrolled-away thumbnail.
 */
export function flipFromThumbnail(
  thumb: HTMLImageElement,
  stage: Box,
  viewport: { width: number; height: number }
): FlipOffset | null {
  const natural = { width: thumb.naturalWidth, height: thumb.naturalHeight };
  if (natural.width === 0 || natural.height === 0) return null;
  const rect = thumb.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const onScreen =
    rect.bottom > 0 && rect.right > 0 && rect.top < viewport.height && rect.left < viewport.width;
  if (!onScreen) return null;
  // A thumbnail is shown with `object-contain` in a box that may be wider
  // than the picture, so the picture's own rectangle is the one to match.
  const from = containedBox(natural, rect, true);
  const to = containedBox(natural, stage, false);
  return {
    x: from.left + from.width / 2 - (stage.left + stage.width / 2),
    y: from.top + from.height / 2 - (stage.top + stage.height / 2),
    scale: from.width / to.width,
  };
}
