'use client'

import { motion } from 'motion/react'
import { REVEAL, STAGGER, VIEWPORT } from '../../lib/motion-variants'

interface CloseSectionProps {
  slideId?: string
}

/** Minimal close. Breathing room. The line people leave with. */
export function CloseSection({ slideId = 'close' }: CloseSectionProps) {
  return (
    <section
      className="flex min-h-screen flex-col items-center justify-center bg-charcoal px-8 py-16 text-center"
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
          className="mb-8 text-[clamp(14px,1.8vw,18px)] leading-[1.7] text-warm-gray"
        >
          Anyone has access to the same AI. Not everyone has thought hard about what they actually
          want.
        </motion.p>

        <motion.div
          variants={REVEAL}
          className="mx-auto mb-8 h-px w-8 bg-brand-orange"
          aria-hidden="true"
        />

        <motion.p
          variants={REVEAL}
          className="mb-10 text-[clamp(18px,2.5vw,28px)] font-light leading-[1.5] text-cream-white"
        >
          I built this so the machine could handle the obligations.
          <br />
          So I could focus on the parts that are irreplaceable.
        </motion.p>

        <motion.p
          variants={REVEAL}
          className="font-mono text-[10px] tracking-[0.1em] text-warm-gray-light uppercase"
        >
          Fundamentals First &mdash; 2026
        </motion.p>
      </motion.div>
    </section>
  )
}
