import type { AnimateOptions } from 'streamdown';

/** Available text streaming animation modes. */
export type TextEffectMode = 'none' | 'fade' | 'blur-in' | 'slide-up';

/** Configuration for text streaming animation. */
export interface TextEffectConfig {
  mode: TextEffectMode;
  duration?: number;
  easing?: string;
  sep?: 'word' | 'char';
}

/** Default text effect: Perplexity-style blur-in at word level. */
export const DEFAULT_TEXT_EFFECT: TextEffectConfig = {
  mode: 'blur-in',
  duration: 150,
  easing: 'ease-out',
  sep: 'word',
};

/** Map from TextEffectMode to streamdown's animation preset name. */
const MODE_TO_ANIMATION: Record<TextEffectMode, AnimateOptions['animation'] | undefined> = {
  none: undefined,
  fade: 'fadeIn',
  'blur-in': 'blurIn',
  'slide-up': 'slideUp',
};

/**
 * Resolve a TextEffectConfig into streamdown's `animated` prop value.
 * Returns `false` when mode is 'none' (disables animation entirely).
 *
 * @param config - The text effect configuration to resolve
 */
export function resolveStreamdownAnimation(config: TextEffectConfig): false | AnimateOptions {
  const animation = MODE_TO_ANIMATION[config.mode];
  if (!animation) return false;
  return {
    animation,
    duration: config.duration ?? 150,
    easing: config.easing ?? 'ease-out',
    sep: config.sep ?? 'word',
  };
}

/**
 * Return a resolved text effect config that respects prefers-reduced-motion.
 * When reduced motion is preferred, returns mode 'none' regardless of input.
 *
 * @param preferred - The desired text effect config (defaults to DEFAULT_TEXT_EFFECT)
 */
export function useTextEffectConfig(
  preferred: TextEffectConfig = DEFAULT_TEXT_EFFECT
): TextEffectConfig {
  if (typeof window === 'undefined') return preferred;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reducedMotion) return { ...preferred, mode: 'none' };
  return preferred;
}
