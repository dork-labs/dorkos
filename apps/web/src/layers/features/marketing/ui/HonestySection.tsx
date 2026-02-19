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
    <section className="py-32 px-8 bg-cream-white">
      <motion.div
        className="max-w-[600px] mx-auto text-center relative"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        {/* Corner brackets with scale animation from their respective corners */}
        <motion.div variants={BRACKET} className="absolute -top-8 -left-8 w-6 h-6 border-l-2 border-t-2 border-warm-gray-light/30 origin-top-left" />
        <motion.div variants={BRACKET} className="absolute -top-8 -right-8 w-6 h-6 border-r-2 border-t-2 border-warm-gray-light/30 origin-top-right" />
        <motion.div variants={BRACKET} className="absolute -bottom-8 -left-8 w-6 h-6 border-l-2 border-b-2 border-warm-gray-light/30 origin-bottom-left" />
        <motion.div variants={BRACKET} className="absolute -bottom-8 -right-8 w-6 h-6 border-r-2 border-b-2 border-warm-gray-light/30 origin-bottom-right" />

        <motion.span variants={REVEAL} className="font-mono text-2xs tracking-[0.15em] uppercase text-brand-green block mb-10">
          Honest by Design
        </motion.span>

        <motion.p variants={REVEAL} className="text-warm-gray text-lg leading-[1.7] mb-6">
          Claude Code uses Anthropic&apos;s API for inference. Your code context
          is sent to their servers. DorkOS doesn&apos;t change that — and we
          won&apos;t pretend it does.
        </motion.p>

        <motion.p variants={REVEAL} className="text-charcoal font-semibold text-lg leading-[1.7] mb-6">
          Here&apos;s what DorkOS does control.
        </motion.p>

        <motion.p variants={REVEAL} className="text-warm-gray text-lg leading-[1.7]">
          The agent runs on your machine. Sessions are stored locally. Tools
          execute in your shell. The orchestration, the heartbeat, the wing —
          that&apos;s all yours. We believe in honest tools for serious builders.
        </motion.p>
      </motion.div>
    </section>
  )
}
