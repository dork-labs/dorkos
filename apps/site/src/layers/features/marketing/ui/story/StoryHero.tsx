'use client';

import { motion } from 'motion/react';
import { REVEAL, STAGGER, VIEWPORT_REPEAT as VIEWPORT } from '../../lib/motion-variants';

interface StoryHeroProps {
  /** data-slide value used by PresentationShell for keyboard navigation. */
  slideId?: string;
}

/** Opening title card. Sets the "Thursday afternoon" frame for the whole page. */
export function StoryHero({ slideId = 'hero' }: StoryHeroProps) {
  return (
    <section
      className="bg-charcoal relative flex min-h-[80vh] flex-col items-center justify-center px-8 py-20 text-center"
      data-slide={slideId}
    >
      <motion.div
        className="mx-auto max-w-2xl"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        <motion.div
          variants={REVEAL}
          className="text-brand-orange mb-6 font-mono text-[9px] tracking-[0.2em] uppercase"
        >
          What If...
        </motion.div>

        <motion.p
          variants={REVEAL}
          className="text-cream-white mb-6 text-[clamp(22px,3.5vw,40px)] leading-[1.4] font-light"
        >
          What if AI gave you Thursday afternoon back?
        </motion.p>

        <motion.div
          variants={REVEAL}
          className="bg-brand-orange mx-auto mb-8 h-px w-8"
          aria-hidden="true"
        />

        <motion.p
          variants={REVEAL}
          className="text-warm-gray-light font-mono text-[10px] tracking-[0.1em] uppercase"
        >
          Dorian Collier &mdash; No Edges &mdash; Austin TX
        </motion.p>
      </motion.div>
    </section>
  );
}
