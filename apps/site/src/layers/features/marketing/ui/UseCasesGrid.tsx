'use client';

import { motion } from 'motion/react';
import type { UseCase } from '../lib/use-cases';
import { REVEAL, STAGGER, VIEWPORT } from '../lib/motion-variants';

interface UseCasesGridProps {
  useCases: UseCase[];
}

/** "What This Unlocks" section showing what people can do with DorkOS. */
export function UseCasesGrid({ useCases }: UseCasesGridProps) {
  return (
    <section id="features" className="bg-cream-primary px-8 py-40">
      <motion.div initial="hidden" whileInView="visible" viewport={VIEWPORT} variants={STAGGER}>
        <motion.span
          variants={REVEAL}
          className="text-2xs text-brand-orange mb-6 block text-center font-mono tracking-[0.15em] uppercase"
        >
          What This Unlocks
        </motion.span>

        <motion.p
          variants={REVEAL}
          className="text-charcoal mx-auto mb-16 max-w-2xl text-center text-[28px] leading-[1.3] font-medium tracking-[-0.02em] md:text-[32px]"
        >
          Not features. Capabilities.
        </motion.p>

        <motion.div
          variants={STAGGER}
          className="mx-auto grid max-w-5xl grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-3"
        >
          {useCases.map((uc) => (
            <motion.article key={uc.id} variants={REVEAL} className="text-left">
              <h3 className="text-charcoal mb-2 text-lg font-semibold tracking-[-0.01em]">
                {uc.title}
              </h3>
              <p className="text-warm-gray text-sm leading-relaxed">{uc.description}</p>
            </motion.article>
          ))}
        </motion.div>
      </motion.div>
    </section>
  );
}
