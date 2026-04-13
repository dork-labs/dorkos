import { useMemo } from 'react';
import type { TargetAndTransition, Transition } from 'motion/react';

/**
 * Build stable motion props for a pulse animation on a single CSS property.
 *
 * @param pulse - Whether to animate at all
 * @param color - Primary color value
 * @param dimColor - Faded target for the tween
 * @param property - CSS property to animate (defaults to `borderLeftColor`)
 */
export function usePulseMotion(
  pulse: boolean,
  color: string,
  dimColor: string | undefined,
  property: string = 'borderLeftColor'
): { animate: TargetAndTransition | undefined; transition: Transition | undefined } {
  return useMemo(() => {
    if (!pulse || !dimColor) return { animate: undefined, transition: undefined };
    return {
      animate: { [property]: [color, dimColor, color] },
      transition: {
        [property]: { duration: 2, repeat: Infinity, ease: 'easeInOut' as const },
      },
    };
  }, [pulse, color, dimColor, property]);
}
