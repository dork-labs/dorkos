'use client';

import type { ReactNode } from 'react';
import { motion, type MotionValue } from 'motion/react';
import { SHELL } from './theme';

interface LaptopFrameProps {
  /** Scale applied to the whole assembly as it shrinks into the laptop. */
  scale: MotionValue<number> | number;
  /** Opacity of the bezel and base — the laptop materializing. */
  shellOpacity: MotionValue<number> | number;
  /** The screen content (the live chat). */
  children: ReactNode;
}

/**
 * The laptop that forms around whatever it wraps. Nothing is swapped in or
 * out: the bezel and base simply fade up around the live chat as it shrinks,
 * so the thing the visitor watched the whole time lands on their computer.
 */
export function LaptopFrame({ scale, shellOpacity, children }: LaptopFrameProps) {
  return (
    <motion.div style={{ scale }} className="flex w-full origin-center flex-col items-center">
      <div className="relative w-full max-w-xl">
        <motion.div
          style={{ opacity: shellOpacity, backgroundColor: SHELL.bezel }}
          className="absolute -inset-3 rounded-[26px]"
          aria-hidden="true"
        />
        <div className="relative">{children}</div>
      </div>
      <motion.div
        style={{ opacity: shellOpacity }}
        className="flex flex-col items-center"
        aria-hidden="true"
      >
        <div
          className="h-4 w-[min(44rem,94vw)] rounded-b-2xl"
          style={{ backgroundImage: `linear-gradient(${SHELL.baseTop}, ${SHELL.baseBottom})` }}
        />
        <div
          className="h-1.5 w-28 -translate-y-4 rounded-b-lg"
          style={{ backgroundColor: SHELL.foot }}
        />
      </motion.div>
    </motion.div>
  );
}
