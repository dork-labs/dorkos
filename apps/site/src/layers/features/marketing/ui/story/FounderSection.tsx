'use client';

import { motion } from 'motion/react';
import { REVEAL, STAGGER, VIEWPORT_REPEAT as VIEWPORT } from '../../lib/motion-variants';

interface FounderSectionProps {
  slideId?: string;
}

/** Who Dorian is — professional credibility + the personal reason he cares about saving time. */
export function FounderSection({ slideId = 'founder' }: FounderSectionProps) {
  return (
    <section
      className="bg-charcoal flex min-h-screen flex-col items-center justify-center px-8 py-16"
      data-slide={slideId}
    >
      <motion.div
        className="mx-auto w-full max-w-2xl"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        {/* Eyebrow */}
        <motion.div
          variants={REVEAL}
          className="text-brand-orange mb-6 font-mono text-[9px] tracking-[0.2em] uppercase"
        >
          Why I Built This
        </motion.div>

        {/* Credibility line */}
        <motion.div variants={REVEAL} className="mb-6 flex flex-wrap gap-x-6 gap-y-2">
          {[
            { value: '30M+', label: 'users' },
            { value: '1M+', label: 'paying users' },
            { value: '2', label: 'exits' },
          ].map(({ value, label }) => (
            <div key={label} className="flex items-baseline gap-1.5">
              <span className="text-cream-white font-mono text-[20px] font-bold">{value}</span>
              <span className="text-warm-gray font-mono text-[9px] tracking-[0.1em] uppercase">
                {label}
              </span>
            </div>
          ))}
        </motion.div>

        {/* Divider */}
        <motion.div
          variants={REVEAL}
          className="bg-brand-orange mb-6 h-px w-8"
          aria-hidden="true"
        />

        {/* The real reason */}
        <motion.p
          variants={REVEAL}
          className="text-cream-white mb-4 text-[clamp(20px,2.8vw,32px)] leading-[1.45] font-light"
        >
          I used to pull all-nighters.
          <br />I don&rsquo;t want to do that anymore.
        </motion.p>

        <motion.p
          variants={REVEAL}
          className="text-warm-gray text-[clamp(13px,1.6vw,16px)] leading-[1.8]"
        >
          I drive my son to school every morning. My sister lives nearby &mdash; there are nieces
          and nephews to show up for.
          <br />
          The work matters. So does the rest of it.
        </motion.p>
      </motion.div>
    </section>
  );
}
