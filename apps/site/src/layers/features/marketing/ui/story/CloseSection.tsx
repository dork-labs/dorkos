'use client';

import { motion } from 'motion/react';
import { REVEAL, STAGGER, VIEWPORT_REPEAT as VIEWPORT } from '../../lib/motion-variants';

interface CloseSectionProps {
  slideId?: string;
}

/** Minimal close. Breathing room. The line people leave with. */
export function CloseSection({ slideId = 'close' }: CloseSectionProps) {
  return (
    <section
      className="bg-charcoal flex min-h-screen flex-col items-center justify-center px-8 py-16 text-center"
      data-slide={slideId}
    >
      <motion.div
        className="mx-auto max-w-xl"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        <motion.p
          variants={REVEAL}
          className="text-warm-gray mb-8 text-[clamp(14px,1.8vw,18px)] leading-[1.7]"
        >
          This isn&rsquo;t about what I built.
        </motion.p>

        <motion.div
          variants={REVEAL}
          className="bg-brand-orange mx-auto mb-8 h-px w-8"
          aria-hidden="true"
        />

        <motion.p
          variants={REVEAL}
          className="text-cream-white mb-10 text-[clamp(18px,2.5vw,28px)] leading-[1.5] font-light"
        >
          You can build this.
          <br />
          Go get your time back.
        </motion.p>

        <motion.p
          variants={REVEAL}
          className="text-warm-gray-light font-mono text-[10px] tracking-[0.1em] uppercase"
        >
          No Edges &mdash; Austin TX &mdash; 2026
        </motion.p>
      </motion.div>
    </section>
  );
}
