'use client';

import Image from 'next/image';
import { useReducedMotion } from 'motion/react';
import { LOOP_SURFACES, type ProductSurface, type ProductCrop } from '../lib/features';

/** Directory (under /public) holding the seeded product captures. */
const PRODUCT_BASE = '/product';

/** Aspect ratios per frame size. Cards run tighter to keep the grid dense. */
const HERO_ASPECT = '16 / 10';
const CARD_ASPECT = '16 / 9';

/** Sizes hint for next/image responsive loading. */
const HERO_SIZES = '(min-width: 1024px) 1024px, 100vw';
const CARD_SIZES = '(min-width: 1024px) 400px, (min-width: 640px) 50vw, 100vw';

/** Focal edge → object-position class, for stills whose content sits at one edge. */
const CROP_FOCUS: Record<ProductCrop, string> = {
  top: 'object-top',
  bottom: 'object-bottom',
};

/** Frame chrome treatment per theme (a light still vs a dark loop). */
const FRAME_THEME = {
  light: {
    frame: 'border-warm-gray-light/15 bg-cream-white',
    bar: 'border-warm-gray-light/10 bg-cream-primary/60',
    media: 'bg-cream-white',
    mutedDot: 'bg-warm-gray-light/30',
  },
  dark: {
    frame: 'border-white/10 bg-charcoal',
    bar: 'border-white/5 bg-white/[0.03]',
    media: 'bg-charcoal',
    mutedDot: 'bg-white/15',
  },
} as const;

/** Soft, consistent elevation for every product frame. */
const FRAME_SHADOW = '0 1px 3px rgba(26, 24, 20, 0.06), 0 10px 30px rgba(26, 24, 20, 0.08)';

interface ProductFrameProps {
  /** Capture surface to present. */
  surface: ProductSurface;
  /** Alt text for the still (also the accessible label for the loop). */
  alt: string;
  /**
   * Frame size. `hero` is the large detail-page treatment; `card` is the
   * compact, lazy-loaded catalog thumbnail. Defaults to `card`.
   */
  size?: 'card' | 'hero';
  /**
   * When true and the surface has a loop, autoplay the dark webm (hero use).
   * Cards, and visitors who prefer reduced motion, always get the still.
   */
  animate?: boolean;
  /** Focal edge for a cropped still. */
  crop?: ProductCrop;
  /** Prioritize the still for LCP (hero above the fold). */
  priority?: boolean;
}

/**
 * The single presentation frame for all DorkOS product media.
 *
 * Wraps a still (or an autoplaying loop) in a minimal browser-chrome bar with
 * one consistent border, radius, and shadow. Light stills render a light frame;
 * animated loops are dark-only, so they render a dark frame with the matching
 * still as both poster and reduced-motion fallback.
 *
 * @param surface - Capture surface, resolved to files under `/public/product/`.
 * @param alt - Alt text for the media.
 * @param size - `hero` (large) or `card` (compact thumbnail). Defaults to `card`.
 * @param animate - Autoplay the loop where one exists; ignored on cards and under reduced motion.
 * @param crop - Focal edge for a still with an empty vertical center.
 * @param priority - Eager-load the still for LCP.
 */
export function ProductFrame({
  surface,
  alt,
  size = 'card',
  animate = false,
  crop,
  priority = false,
}: ProductFrameProps) {
  const reducedMotion = useReducedMotion();
  const hasLoop = (LOOP_SURFACES as readonly string[]).includes(surface);
  const showLoop = animate && hasLoop && !reducedMotion;

  // Loops ship dark-only; stills that stand alone use the light capture.
  const themeKey = showLoop ? 'dark' : 'light';
  const theme = FRAME_THEME[themeKey];

  const stillSrc = `${PRODUCT_BASE}/${surface}-${themeKey}.png`;
  const videoSrc = `${PRODUCT_BASE}/${surface}-dark.webm`;
  const posterSrc = `${PRODUCT_BASE}/${surface}-dark.png`;

  const objectPosition = crop ? CROP_FOCUS[crop] : 'object-center';
  const isHero = size === 'hero';

  return (
    <div
      className={`overflow-hidden rounded-xl border ${theme.frame}`}
      style={{ boxShadow: FRAME_SHADOW }}
    >
      {/* Minimal browser-chrome bar */}
      <div className={`flex items-center gap-1.5 border-b px-3 py-2 ${theme.bar}`}>
        <span className="bg-brand-orange/50 h-2 w-2 rounded-full" />
        <span className={`h-2 w-2 rounded-full ${theme.mutedDot}`} />
        <span className={`h-2 w-2 rounded-full ${theme.mutedDot}`} />
      </div>

      {/* Media area */}
      <div
        className={`relative w-full ${theme.media}`}
        style={{ aspectRatio: isHero ? HERO_ASPECT : CARD_ASPECT }}
      >
        {showLoop ? (
          <video
            className={`h-full w-full object-cover ${objectPosition}`}
            autoPlay
            muted
            loop
            playsInline
            poster={posterSrc}
            aria-label={alt}
          >
            <source src={videoSrc} type="video/webm" />
          </video>
        ) : (
          <Image
            src={stillSrc}
            alt={alt}
            fill
            sizes={isHero ? HERO_SIZES : CARD_SIZES}
            priority={priority}
            className={`object-cover ${objectPosition}`}
          />
        )}
      </div>
    </div>
  );
}
