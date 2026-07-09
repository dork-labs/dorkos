import { ProductFrame } from './ProductFrame';
import { getProductShot } from '../lib/shots';

interface ProductShotProps {
  /** A registered shot id (see the shot registry / `manifest.json`). */
  id: string;
  /** Alt text for the media (a11y + SEO). Required. */
  alt: string;
  /**
   * Autoplay the loop where one exists. Defaults to `true` for loop shots and
   * is ignored for still-only shots or under reduced motion.
   */
  animate?: boolean;
  /** `hero` (large) or `card` (compact). Defaults to `hero` for docs embeds. */
  size?: 'card' | 'hero';
  /** Focal edge for a still whose content sits at one edge. */
  crop?: 'top' | 'bottom';
}

/**
 * Embed real DorkOS product media in a documentation page.
 *
 * `<ProductShot id="canvas" alt="…" />` resolves a registered shot to the same
 * `/product/` assets the marketing site uses, wrapped in the shared
 * {@link ProductFrame} (browser chrome for desktop shots, a phone shell for
 * mobile shots). The shot registry (published in `manifest.json`) is the single
 * source of truth; a docs guard test asserts every embedded id exists and its
 * files are present.
 *
 * @param id - The shot id to render.
 * @param alt - Alt text for the media.
 * @param animate - Autoplay the loop (loop shots only). Defaults to `true`.
 * @param size - `hero` (default) or `card`.
 * @param crop - Focal edge for a cropped still.
 */
export function ProductShot({ id, alt, animate, size = 'hero', crop }: ProductShotProps) {
  const shot = getProductShot(id);
  if (!shot) {
    throw new Error(
      `<ProductShot id="${id}" /> is not a registered shot — check the id against the shot registry (manifest.json shots).`
    );
  }
  const hasLoop = shot.kind === 'loop';
  return (
    <ProductFrame
      surface={shot.id}
      alt={alt}
      size={size}
      frame={shot.frame === 'mobile' ? 'phone' : 'desktop'}
      animate={animate ?? hasLoop}
      crop={crop}
    />
  );
}
