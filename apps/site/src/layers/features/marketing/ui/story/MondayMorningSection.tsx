'use client'

import { motion } from 'motion/react'
import { REVEAL, STAGGER, SPRING, VIEWPORT_REPEAT as VIEWPORT } from '../../lib/motion-variants'
import { bootCards } from '../../lib/story-data'
import type { BootCard } from '../../lib/story-data'

interface MondayMorningSectionProps {
  slideId?: string
}

const BORDER_COLOR: Record<BootCard['color'], string> = {
  orange: 'border-brand-orange',
  blue: 'border-brand-blue',
  purple: 'border-brand-purple',
  green: 'border-brand-green',
  gray: 'border-warm-gray/20',
}

const LABEL_COLOR: Record<BootCard['color'], string> = {
  orange: 'text-brand-orange',
  blue: 'text-brand-blue',
  purple: 'text-brand-purple',
  green: 'text-brand-green',
  gray: 'text-warm-gray-light',
}

/** The "Monday Morning" boot dashboard -- 8 cards that appear before you touch anything. */
export function MondayMorningSection({ slideId = 'morning' }: MondayMorningSectionProps) {
  return (
    <section
      className="flex min-h-screen flex-col justify-center bg-[#0f0e0c] px-8 py-16"
      data-slide={slideId}
    >
      <div className="mx-auto w-full max-w-4xl">
        {/* Header */}
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
          variants={STAGGER}
          className="mb-8"
        >
          <motion.div
            variants={REVEAL}
            className="mb-3 font-mono text-[9px] tracking-[0.2em] text-brand-orange uppercase"
          >
            A Thursday Morning
          </motion.div>
          <motion.h2
            variants={REVEAL}
            className="mb-2 text-[clamp(22px,3vw,36px)] font-semibold tracking-tight text-cream-white"
          >
            Before you touched anything.
          </motion.h2>
          <motion.p variants={REVEAL} className="text-sm text-warm-gray">
            While you slept, the system ran.
          </motion.p>
        </motion.div>

        {/* Boot cards grid */}
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
          variants={STAGGER}
          className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4"
        >
          {bootCards.map((card, i) => (
            <motion.div
              key={card.id}
              variants={REVEAL}
              transition={{ delay: i * 0.08, ...SPRING }}
              className={`rounded-md border bg-charcoal p-3 ${BORDER_COLOR[card.color]}`}
            >
              <div className={`mb-1 font-mono text-[8px] tracking-[0.1em] uppercase ${LABEL_COLOR[card.color]}`}>
                {card.label}
              </div>
              <div className={`mb-1 font-mono text-[13px] font-medium ${card.urgent ? 'text-brand-orange' : 'text-cream-white'}`}>
                {card.value}
              </div>
              <div className="font-mono text-[8px] text-warm-gray-light">{card.detail}</div>
            </motion.div>
          ))}
        </motion.div>

        {/* Landing line */}
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
          variants={REVEAL}
          className="border-t border-warm-gray/10 pt-5 text-center"
        >
          <p className="text-[15px] font-semibold italic text-cream-white">
            &ldquo;This isn&apos;t ChatGPT. This is a personal operating system.&rdquo;
          </p>
        </motion.div>
      </div>
    </section>
  )
}
