'use client';

import { motion } from 'motion/react';
import { REVEAL, STAGGER, SPRING, VIEWPORT_REPEAT as VIEWPORT } from '../../lib/motion-variants';
import { equationItems } from '../../lib/story-data';

interface JustPromptsSectionProps {
  slideId?: string;
}

/** Equation reveal: strips away the magic and shows what LifeOS actually is. */
export function JustPromptsSection({ slideId = 'prompts' }: JustPromptsSectionProps) {
  return (
    <section
      className="film-grain bg-charcoal flex min-h-screen flex-col justify-center px-8 py-16 text-center"
      data-slide={slideId}
    >
      <div className="mx-auto w-full max-w-xl">
        {/* Header */}
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
          variants={STAGGER}
          className="mb-10"
        >
          <motion.div
            variants={REVEAL}
            className="text-brand-orange mb-4 font-mono text-[9px] tracking-[0.2em] uppercase"
          >
            Here&apos;s the Thing
          </motion.div>
          <motion.h2
            variants={REVEAL}
            className="text-cream-white mb-2 text-[clamp(22px,3vw,36px)] font-bold tracking-tight"
          >
            Platforms will just be prompts.
          </motion.h2>
          <motion.p variants={REVEAL} className="text-warm-gray text-[13px]">
            All open source. Here&apos;s what it actually is.
          </motion.p>
        </motion.div>

        {/* Equation items */}
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
          variants={STAGGER}
          className="mb-8 flex flex-col gap-4"
        >
          {equationItems.map((item, i) => (
            <motion.div
              key={item.lhs}
              variants={REVEAL}
              transition={{ delay: i * 0.15, ...SPRING }}
              className="flex items-center justify-center gap-4"
            >
              <span className="text-cream-white min-w-[160px] text-right font-mono text-[14px] font-medium">
                {item.lhs}
              </span>
              <span className="text-brand-orange text-[20px] font-light">=</span>
              <span className="text-warm-gray min-w-[160px] text-left font-mono text-[14px]">
                {item.rhs}
              </span>
            </motion.div>
          ))}
        </motion.div>

        {/* Landing moment */}
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
          variants={STAGGER}
          className="border-warm-gray/10 border-t pt-7"
        >
          <motion.p variants={REVEAL} className="text-cream-white mb-2 text-[16px] font-medium">
            Platforms will just be prompts.
          </motion.p>
          <motion.p variants={REVEAL} className="text-warm-gray text-[14px] leading-relaxed">
            Code isn&apos;t the scarce thing anymore. Knowing what to ask &mdash;&mdash; and what to
            remember &mdash;&mdash; is.
          </motion.p>
        </motion.div>
      </div>
    </section>
  );
}
