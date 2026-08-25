'use client';

import { AnimatePresence, motion } from 'motion/react';
import type { Beat } from './beats';
import { BEATS } from './copy';
import { Eyebrow } from './Eyebrow';

/** The stage's headline, crossfading as the scroll moves between beats. */
export function BeatHeadline({ beat }: { beat: Beat }) {
  const copy = BEATS[beat];
  return (
    <div className="relative h-44 w-full">
      <AnimatePresence mode="wait">
        <motion.div
          key={beat}
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -18 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
          className="absolute inset-x-0 top-0 flex flex-col items-center text-center"
        >
          <Eyebrow>{copy.eyebrow}</Eyebrow>
          <h2 className="text-charcoal mt-3 text-[clamp(2rem,4.5vw,3.25rem)] leading-none font-semibold tracking-[-0.03em] text-balance">
            {copy.title}
          </h2>
          <p className="text-warm-gray mt-3 max-w-xl text-base text-pretty sm:text-lg">
            {copy.lede}
          </p>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
