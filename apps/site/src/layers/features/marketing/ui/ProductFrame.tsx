'use client';

import Image from 'next/image';
import { useReducedMotion } from 'motion/react';
import { type ProductCrop, type ProductFrameVariant } from '../lib/features';
import { shotHasLoop } from '../lib/shots';

/** Directory (under /public) holding the seeded product captures. */
const PRODUCT_BASE = '/product';

/** Aspect ratios per frame. Desktop captures are 16/10; phones are portrait. */
const HERO_ASPECT = '16 / 10';
const CARD_ASPECT = '16 / 10';
const PHONE_ASPECT = '390 / 844';

/** Max width for a portrait phone shell, so it stays contained in each context. */
const PHONE_MAX_WIDTH = { card: 200, hero: 280 } as const;

/** Sizes hint for next/image responsive loading. */
const HERO_SIZES = '(min-width: 1024px) 1024px, 100vw';
const CARD_SIZES = '(min-width: 1024px) 400px, (min-width: 640px) 50vw, 100vw';
const PHONE_SIZES = '280px';

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
  /**
   * Capture surface (a registered shot id) to present. Resolves to files under
   * `/public/product/` by convention; loop-ness comes from the shot registry.
   */
  surface: string;
  /** Alt text for the still (also the accessible label for the loop). */
  alt: string;
  /**
   * Frame size. `hero` is the large detail-page treatment; `card` is the
   * compact, lazy-loaded catalog thumbnail. Defaults to `card`.
   */
  size?: 'card' | 'hero';
  /** Frame chrome. `desktop` (browser chrome) or `phone` (portrait shell). Defaults to `desktop`. */
  frame?: ProductFrameVariant;
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
 * Wraps a still (or an autoplaying loop) in either a minimal browser-chrome bar
 * (`desktop`) or a portrait phone shell (`phone`), with one consistent border,
 * radius, and shadow. Light stills render a light frame; animated loops are
 * dark-only, so they render a dark frame with the matching still as both poster
 * and reduced-motion fallback.
 *
 * @param surface - Capture surface, resolved to files under `/public/product/`.
 * @param alt - Alt text for the media.
 * @param size - `hero` (large) or `card` (compact thumbnail). Defaults to `card`.
 * @param frame - `desktop` browser chrome or `phone` portrait shell. Defaults to `desktop`.
 * @param animate - Autoplay the loop where one exists; ignored on cards and under reduced motion.
 * @param crop - Focal edge for a still with an empty vertical center.
 * @param priority - Eager-load the still for LCP.
 */
export function ProductFrame({
  surface,
  alt,
  size = 'card',
  frame = 'desktop',
  animate = false,
  crop,
  priority = false,
}: ProductFrameProps) {
  const reducedMotion = useReducedMotion();
  const hasLoop = shotHasLoop(surface);
  const showLoop = animate && hasLoop && !reducedMotion;

  // Loops ship dark-only; stills that stand alone use the light capture.
  const themeKey = showLoop ? 'dark' : 'light';
  const theme = FRAME_THEME[themeKey];

  const stillSrc = `${PRODUCT_BASE}/${surface}-${themeKey}.png`;
  const videoSrc = `${PRODUCT_BASE}/${surface}-dark.webm`;
  const posterSrc = `${PRODUCT_BASE}/${surface}-dark.png`;

  const objectPosition = crop ? CROP_FOCUS[crop] : 'object-center';
  const isHero = size === 'hero';
  const isPhone = frame === 'phone';

  let stillSizes = CARD_SIZES;
  if (isPhone) stillSizes = PHONE_SIZES;
  else if (isHero) stillSizes = HERO_SIZES;

  const media = showLoop ? (
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
      sizes={stillSizes}
      priority={priority}
      className={`object-cover ${objectPosition}`}
    />
  );

  if (isPhone) {
    // Minimal phone shell: a thin charcoal bezel around a rounded portrait screen.
    return (
      <div className="mx-auto w-full" style={{ maxWidth: PHONE_MAX_WIDTH[size] }}>
        <div
          className="bg-charcoal overflow-hidden rounded-[2rem] border border-white/10 p-2"
          style={{ boxShadow: FRAME_SHADOW }}
        >
          <div
            className={`relative w-full overflow-hidden rounded-[1.4rem] ${theme.media}`}
            style={{ aspectRatio: PHONE_ASPECT }}
          >
            {media}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`flex flex-col overflow-hidden rounded-xl border ${theme.frame}`}
      style={{ boxShadow: FRAME_SHADOW }}
    >
      {/* Minimal browser-chrome bar */}
      <div className={`flex shrink-0 items-center gap-1.5 border-b px-3 py-2 ${theme.bar}`}>
        <span className="bg-brand-orange/50 h-2 w-2 rounded-full" />
        <span className={`h-2 w-2 rounded-full ${theme.mutedDot}`} />
        <span className={`h-2 w-2 rounded-full ${theme.mutedDot}`} />
      </div>

      {/* Media area — a fixed 16/10 box; the still object-covers within it, so a
          `crop` focal edge shows a coherent slice rather than a stretched-tall frame. */}
      <div
        className={`relative w-full ${theme.media}`}
        style={{ aspectRatio: isHero ? HERO_ASPECT : CARD_ASPECT }}
      >
        {media}
      </div>
    </div>
  );
}
