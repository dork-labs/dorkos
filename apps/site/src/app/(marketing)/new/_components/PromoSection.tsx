'use client';

import { motion } from 'motion/react';
import { REVEAL, STAGGER, VIEWPORT } from '@/layers/features/marketing';
import { PROMO } from './copy';
import { Eyebrow } from './Eyebrow';
import { PromoPlayer } from './PromoPlayer';

/**
 * The promo, sitting between the animation and the close.
 *
 * Two lines and a play button. The film makes its own case in under a minute,
 * so the copy stays out of its way.
 */
export function PromoSection() {
  return (
    <section className="mx-auto max-w-5xl px-6 pt-24 sm:pt-32">
      <motion.div
        variants={STAGGER}
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        className="flex flex-col items-center text-center"
      >
        <motion.div variants={REVEAL}>
          <Eyebrow>{PROMO.eyebrow}</Eyebrow>
        </motion.div>
        <motion.h2
          variants={REVEAL}
          className="mt-3 text-[clamp(2rem,4.5vw,3.25rem)] leading-none font-semibold tracking-[-0.03em] text-balance text-(--cream)"
        >
          {PROMO.title}
        </motion.h2>
        <motion.p variants={REVEAL} className="mt-3 text-base text-(--cream-dim) sm:text-lg">
          {PROMO.lede}
        </motion.p>
        <motion.div variants={REVEAL} className="mt-10 w-full">
          <PromoPlayer />
        </motion.div>
      </motion.div>
    </section>
  );
}
