'use client';

import { motion } from 'motion/react';
import { BRAND_COLORS } from '@dorkos/icons/brand';
import { SUBSYSTEMS } from '@dorkos/icons/subsystems';
import { subsystems } from '../lib/subsystems';
import { REVEAL, STAGGER, REVEAL_TRANSITION, VIEWPORT } from '../lib/motion-variants';

/** The four subsystems joined with their canonical icons — the payoff grid's data. */
const GRID_ITEMS = subsystems.map((sub) => ({
  ...sub,
  icon: SUBSYSTEMS.find((def) => def.id === sub.id)?.icon,
}));

/** Word stagger variant — each word fades in 100ms apart. */
const WORD_STAGGER = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.1 },
  },
};

const WORD_REVEAL = {
  hidden: { opacity: 0, y: 8 },
  visible: {
    opacity: 1,
    y: 0,
    transition: REVEAL_TRANSITION,
  },
};

/**
 * The grid waits out the "So we built it." word stagger (4 words × 100ms +
 * 300ms reveal), holds a beat of silence, then deals the four cards.
 */
const GRID_STAGGER = {
  hidden: {},
  visible: {
    transition: { delayChildren: 0.55, staggerChildren: 0.09 },
  },
};

const CARD_REVEAL = {
  hidden: { opacity: 0, y: 16 },
  visible: {
    opacity: 1,
    y: 0,
    transition: REVEAL_TRANSITION,
  },
};

/**
 * Thesis, turn, and reveal — "So we built it." answered by the four
 * subsystems, each icon meeting the reader exactly once, with its meaning.
 */
export function PivotSection() {
  const closingWords = 'So we built it.'.split(' ');

  return (
    <section className="bg-cream-secondary px-8 py-16 md:py-28">
      <motion.div
        className="mx-auto max-w-3xl text-center"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        {/* Thesis — the line people remember */}
        <motion.p
          variants={REVEAL}
          className="text-charcoal mx-auto mb-6 max-w-2xl text-[24px] leading-[1.4] font-semibold tracking-[-0.02em] md:text-[28px]"
        >
          Intelligence doesn&apos;t scale. Coordination does.
        </motion.p>

        {/* Proof — history earns the claim */}
        <motion.p
          variants={REVEAL}
          className="text-warm-gray mx-auto mb-10 max-w-2xl text-[15px] leading-[1.7] md:text-base"
        >
          That&apos;s how every great team works. The wins never came from smarter people. They came
          from giving smart people better systems.
        </motion.p>

        {/* The agent turn */}
        <motion.p
          variants={REVEAL}
          className="text-warm-gray mx-auto max-w-2xl text-[18px] leading-[1.6] md:text-[20px]"
        >
          Your agents have the smarts. They&apos;ve just never had a system.
        </motion.p>

        {/* Word-by-word stagger on the closing line */}
        <motion.p
          variants={WORD_STAGGER}
          className="mt-8 font-mono text-[24px] leading-[1.2] font-bold tracking-[-0.02em] md:text-[32px]"
          style={{ color: BRAND_COLORS.orange }}
        >
          {closingWords.map((word, i) => (
            <motion.span
              key={i}
              variants={WORD_REVEAL}
              className="mr-[0.3em] inline-block last:mr-0"
            >
              {word}
            </motion.span>
          ))}
        </motion.p>

        {/* The reveal — what "it" is: the four subsystems */}
        <motion.div
          variants={GRID_STAGGER}
          className="mt-12 grid grid-cols-2 gap-3 md:mt-14 md:grid-cols-4 md:gap-4"
        >
          {GRID_ITEMS.map((sub) => {
            const Icon = sub.icon;
            return (
              <motion.div
                key={sub.id}
                variants={CARD_REVEAL}
                className="flex flex-col items-center rounded-lg px-4 py-6"
                style={{
                  background: '#FFFEFB',
                  boxShadow: '0 1px 2px rgba(139, 90, 43, 0.04), 0 2px 8px rgba(139, 90, 43, 0.06)',
                }}
              >
                {Icon && <Icon size={28} color={BRAND_COLORS.orange} strokeWidth={1.5} />}
                <span className="text-brand-orange mt-3 font-mono text-[11px] font-medium tracking-[0.12em] uppercase">
                  {sub.name}
                </span>
                <p className="text-warm-gray mt-1.5 text-[13px] leading-[1.6] text-balance">
                  {sub.benefit}
                </p>
              </motion.div>
            );
          })}
        </motion.div>
      </motion.div>
    </section>
  );
}
