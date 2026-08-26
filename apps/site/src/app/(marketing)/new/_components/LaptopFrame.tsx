'use client';

import type { ReactNode } from 'react';
import { motion, type MotionValue } from 'motion/react';
import { SHELL } from './theme';

/**
 * The screen's shape, and it is not negotiable: 16:10, the proportion every
 * MacBook has shipped in for a decade.
 *
 * This used to be whatever shape the chat card happened to be — roughly 4:3,
 * which is a 2003 ThinkPad. The whole point of the beat is that the thing the
 * visitor has been watching turns out to be running on their own computer, and
 * a screen with 2003 proportions quietly argues the opposite. So the frame
 * declares the ratio and the chat fits itself into it, rather than the frame
 * stretching to whatever the chat wants to be.
 */
const SCREEN_ASPECT = 'aspect-[16/10]';

/**
 * `min-h-0`, and it is the whole reason the ratio above holds.
 *
 * The screen is a flex item, and a flex item's default `min-height: auto` is a
 * content-based floor that outranks `aspect-ratio`. Without this the box was
 * 16:10 while the chat was short and then silently grew taller as messages
 * arrived — measured at 390px wide, an eleven-message stack stretched a
 * 318x199 screen to 318x943. The ratio test passes either way, because the
 * class is still there; only a browser can see this one.
 */
const SCREEN_FLOOR = 'min-h-0';

/**
 * How wide the screen is allowed to get, in one expression, because three
 * different limits bind on three different screens.
 *
 * `42rem` is the size it wants to be. `calc(100% - 1.5rem)` keeps the bezel
 * inside the stage's padding on a phone, where the viewport is what binds.
 * `calc(52vh * 1.6)` is the one that stops a 16:10 box from growing taller
 * than the pinned stage can hold on a short, wide window — the failure a
 * width-only clamp cannot see, because at 1440x700 the width is fine and the
 * height it implies is not.
 */
const SCREEN_WIDTH = 'min(42rem, calc(100% - 1.5rem), calc(52vh * 1.6))';

/** The base is the lid plus its bezel plus a small lip either side. */
const BASE_WIDTH = `calc(${SCREEN_WIDTH} + 2rem)`;

interface LaptopFrameProps {
  /** Scale applied to the whole assembly as it shrinks into the laptop. */
  scale: MotionValue<number> | number;
  /** Opacity of the bezel and base — the laptop materializing. */
  shellOpacity: MotionValue<number> | number;
  /** The screen content (the live chat), which fills the screen box. */
  children: ReactNode;
}

/**
 * The laptop that forms around whatever it wraps. Nothing is swapped in or
 * out: the bezel and base simply fade up around the live chat as it shrinks,
 * so the thing the visitor watched the whole time lands on their computer.
 *
 * The frame owns the screen's size and shape at every beat, not just the last
 * one. That is why the chat is inside it from the first frame even while the
 * shell is still fully transparent: if the box changed shape when the bezel
 * appeared, the laptop would not be materializing around the chat, it would be
 * replacing it.
 */
export function LaptopFrame({ scale, shellOpacity, children }: LaptopFrameProps) {
  return (
    <motion.div style={{ scale }} className="flex w-full origin-center flex-col items-center">
      <div className={`relative ${SCREEN_ASPECT} ${SCREEN_FLOOR}`} style={{ width: SCREEN_WIDTH }}>
        <motion.div
          style={{ opacity: shellOpacity, backgroundColor: SHELL.bezel }}
          className="absolute -inset-3 rounded-[26px]"
          aria-hidden="true"
        />
        <div className="relative h-full">{children}</div>
      </div>
      <motion.div
        style={{ opacity: shellOpacity, width: BASE_WIDTH }}
        className="flex flex-col items-center"
        aria-hidden="true"
      >
        <div
          className="h-4 w-full rounded-b-2xl"
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
