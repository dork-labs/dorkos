'use client';

import { motion } from 'motion/react';
import { REVEAL, STAGGER, VIEWPORT_REPEAT as VIEWPORT } from '../../lib/motion-variants';

interface DemoSectionProps {
  slideId?: string;
}

/** Live demo cue slide — presenter prompt only, not shown on the public page. */
export function DemoSection({ slideId = 'demo' }: DemoSectionProps) {
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
        <motion.div
          variants={REVEAL}
          className="text-brand-orange mb-6 font-mono text-[9px] tracking-[0.2em] uppercase"
        >
          Live Demo
        </motion.div>

        <motion.p
          variants={REVEAL}
          className="text-cream-white text-[clamp(22px,3vw,36px)] leading-[1.4] font-light"
        >
          Let me show you...
        </motion.p>
      </motion.div>
    </section>
  );
}
