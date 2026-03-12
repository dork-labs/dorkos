'use client'

import { motion } from 'motion/react'
import { REVEAL, STAGGER, VIEWPORT } from '../../lib/motion-variants'

interface StoryHeroProps {
  /** data-slide value used by PresentationShell for keyboard navigation. */
  slideId?: string
}

/** Opening title card. Sets the "Thursday afternoon" frame for the whole page. */
export function StoryHero({ slideId = 'hero' }: StoryHeroProps) {
  return (
    <section
      className="relative flex min-h-[80vh] flex-col items-center justify-center bg-charcoal px-8 py-20 text-center"
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
          className="mb-6 font-mono text-[9px] tracking-[0.2em] text-brand-orange uppercase"
        >
          Origin Story
        </motion.div>

        <motion.p
          variants={REVEAL}
          className="mb-6 text-[clamp(22px,3.5vw,40px)] font-light leading-[1.4] text-cream-white"
        >
          What if the most powerful thing you could do with AI was get Thursday afternoon back?
        </motion.p>

        <motion.div
          variants={REVEAL}
          className="mx-auto mb-8 h-px w-8 bg-brand-orange"
          aria-hidden="true"
        />

        <motion.p
          variants={REVEAL}
          className="font-mono text-[10px] tracking-[0.1em] text-warm-gray-light uppercase"
        >
          Dorian Collier &mdash; 144 Studio &mdash; Austin TX
        </motion.p>
      </motion.div>
    </section>
  )
}
