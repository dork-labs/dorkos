'use client'

import { motion } from 'motion/react'
import { REVEAL, STAGGER, SPRING, VIEWPORT } from '../lib/motion-variants'

/** Corner bracket scale-in variant. */
const BRACKET = {
  hidden: { opacity: 0, scale: 0.5 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: SPRING,
  },
}

/** Radical transparency section — honest about architecture and tradeoffs. */
export function HonestySection() {
  return (
    <section className="py-14 md:py-24 px-8 bg-charcoal film-grain">
      <motion.div
        className="max-w-[600px] mx-auto text-center relative"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        {/* Corner brackets with scale animation from their respective corners */}
        <motion.div variants={BRACKET} className="absolute -top-8 -left-8 w-6 h-6 border-l-2 border-t-2 border-cream-tertiary/20 origin-top-left" />
        <motion.div variants={BRACKET} className="absolute -top-8 -right-8 w-6 h-6 border-r-2 border-t-2 border-cream-tertiary/20 origin-top-right" />
        <motion.div variants={BRACKET} className="absolute -bottom-8 -left-8 w-6 h-6 border-l-2 border-b-2 border-cream-tertiary/20 origin-bottom-left" />
        <motion.div variants={BRACKET} className="absolute -bottom-8 -right-8 w-6 h-6 border-r-2 border-b-2 border-cream-tertiary/20 origin-bottom-right" />

        <motion.span variants={REVEAL} className="font-mono text-2xs tracking-[0.15em] uppercase text-brand-green block mb-10">
          Open by Default
        </motion.span>

        <motion.p variants={REVEAL} className="text-cream-white font-semibold text-lg leading-[1.7] mb-6">
          DorkOS is open source, MIT licensed, and runs wherever you put
          it &mdash; your laptop, a VPS, a Raspberry Pi. Every line of code is
          readable. Every decision is documented. Nothing phones home.
        </motion.p>

        <motion.p variants={REVEAL} className="text-cream-tertiary/70 text-lg leading-[1.7]">
          It coordinates your agents. The thinking is theirs. The system is yours.
        </motion.p>
      </motion.div>
    </section>
  )
}
