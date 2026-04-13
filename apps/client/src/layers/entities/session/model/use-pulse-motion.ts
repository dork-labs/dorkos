import { useMemo } from 'react';
import type { TargetAndTransition, Transition } from 'motion/react';

/** Build stable motion props for the border pulse animation. */
export function usePulseMotion(
  pulse: boolean,
  color: string,
  dimColor: string | undefined
): { animate: TargetAndTransition | undefined; transition: Transition | undefined } {
  return useMemo(() => {
    if (!pulse || !dimColor) return { animate: undefined, transition: undefined };
    return {
      animate: { borderLeftColor: [color, dimColor, color] },
      transition: {
        borderLeftColor: { duration: 2, repeat: Infinity, ease: 'easeInOut' as const },
      },
    };
  }, [pulse, color, dimColor]);
}
