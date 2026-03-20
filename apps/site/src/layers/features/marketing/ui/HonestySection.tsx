'use client';

import { motion } from 'motion/react';
import { REVEAL, STAGGER, SPRING, VIEWPORT } from '../lib/motion-variants';

/** Corner bracket scale-in variant. */
const BRACKET = {
  hidden: { opacity: 0, scale: 0.5 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: SPRING,
  },
};

/** Radical transparency section — honest about architecture and tradeoffs. */
export function HonestySection() {
  return (
    <section className="bg-charcoal film-grain px-8 py-14 md:py-24">
      <motion.div
        className="relative mx-auto max-w-[600px] text-center"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        {/* Corner brackets with scale animation from their respective corners */}
        <motion.div
          variants={BRACKET}
          className="border-cream-tertiary/20 absolute -top-8 -left-8 h-6 w-6 origin-top-left border-t-2 border-l-2"
        />
        <motion.div
          variants={BRACKET}
          className="border-cream-tertiary/20 absolute -top-8 -right-8 h-6 w-6 origin-top-right border-t-2 border-r-2"
        />
        <motion.div
          variants={BRACKET}
          className="border-cream-tertiary/20 absolute -bottom-8 -left-8 h-6 w-6 origin-bottom-left border-b-2 border-l-2"
        />
        <motion.div
          variants={BRACKET}
          className="border-cream-tertiary/20 absolute -right-8 -bottom-8 h-6 w-6 origin-bottom-right border-r-2 border-b-2"
        />

        <motion.span
          variants={REVEAL}
          className="text-2xs text-brand-green mb-10 block font-mono tracking-[0.15em] uppercase"
        >
          Open by Default
        </motion.span>

        <motion.p
          variants={REVEAL}
          className="text-cream-white mb-6 text-lg leading-[1.7] font-semibold"
        >
          DorkOS is open source, MIT licensed, and runs wherever you put it &mdash; your laptop, a
          VPS, a Raspberry Pi. Every line of code is readable. Every decision is documented. Nothing
          phones home.
        </motion.p>

        <motion.p variants={REVEAL} className="text-cream-tertiary/70 text-lg leading-[1.7]">
          It coordinates your agents. The thinking is theirs. The system is yours.
        </motion.p>
      </motion.div>
    </section>
  );
}
