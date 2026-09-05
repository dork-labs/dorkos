import { useMemo } from 'react';
import { useReducedMotion, type TargetAndTransition, type Transition } from 'motion/react';

/** What {@link usePulseMotion} hands back. */
export interface PulseMotion {
  /** The `animate` prop, or `undefined` when nothing should pulse. */
  animate: TargetAndTransition | undefined;
  /** The `transition` prop, or `undefined` when nothing should pulse. */
  transition: Transition | undefined;
  /**
   * Whether a pulse is actually running.
   *
   * Stamp it on the element as a `data-` attribute: no motion prop is
   * assertable in jsdom (the test harness strips them all), so this boolean is
   * the only way a browser check can see what the hook decided.
   */
  pulsing: boolean;
}

/**
 * Whether a pulse may actually run.
 *
 * Pure, so the rule can be tested at full strength and the boolean a row
 * reports as `data-pulsing` cannot drift from the boolean the animation uses.
 *
 * @param pulse - What the caller's state says: this row deserves a pulse.
 * @param dimColor - The faded end of the tween; without one there is no pulse.
 * @param reducedMotion - The reader asked for less motion.
 */
export function shouldPulse(
  pulse: boolean,
  dimColor: string | undefined,
  reducedMotion: boolean
): boolean {
  return pulse && dimColor !== undefined && !reducedMotion;
}

/**
 * Build stable motion props for a pulse animation on a single CSS property.
 *
 * **The reduced-motion gate lives here, not at the call site.** This animates a
 * colour, and neither `MotionConfig reducedMotion="user"` nor the CSS reset
 * reaches colour — so a `repeat: Infinity` colour tween keeps running for a
 * reader who asked for no motion unless something branches off explicitly.
 * Every caller used to have to remember that, and the hook is exported from the
 * entity barrel where the next caller would not know to.
 *
 * @param pulse - Whether the caller's state wants a pulse at all
 * @param color - Primary color value
 * @param dimColor - Faded target for the tween
 * @param property - CSS property to animate (defaults to `borderLeftColor`)
 */
export function usePulseMotion(
  pulse: boolean,
  color: string,
  dimColor: string | undefined,
  property: string = 'borderLeftColor'
): PulseMotion {
  const reducedMotion = useReducedMotion() ?? false;
  const pulsing = shouldPulse(pulse, dimColor, reducedMotion);

  return useMemo(() => {
    if (!pulsing || !dimColor) return { animate: undefined, transition: undefined, pulsing: false };
    return {
      animate: { [property]: [color, dimColor, color] },
      transition: {
        [property]: { duration: 2, repeat: Infinity, ease: 'easeInOut' as const },
      },
      pulsing: true,
    };
  }, [pulsing, color, dimColor, property]);
}
