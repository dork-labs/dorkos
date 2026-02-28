'use client'

import { motion } from 'motion/react'
import { REVEAL, STAGGER, SPRING, DRAW_PATH, SCALE_IN, VIEWPORT } from '../lib/motion-variants'

/** Word stagger variant — each word fades in 100ms apart. */
const WORD_STAGGER = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.1 },
  },
}

const WORD_REVEAL = {
  hidden: { opacity: 0, y: 8 },
  visible: {
    opacity: 1,
    y: 0,
    transition: SPRING,
  },
}

/** OS metaphor icons — hand-drawn style SVGs mapping physical objects to modules. */
const OS_ICONS: Array<{ label: string; icon: React.ReactNode }> = [
  {
    label: 'Pulse',
    icon: (
      <motion.svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true"
        initial="hidden" whileInView="visible" viewport={VIEWPORT}
      >
        {/* Alarm clock — circle + bells + hands */}
        <motion.circle cx="20" cy="22" r="12" stroke="#E85D04" strokeWidth="1.5" fill="none" variants={DRAW_PATH} />
        <motion.line x1="20" y1="22" x2="20" y2="15" stroke="#E85D04" strokeWidth="1.5" strokeLinecap="round" variants={DRAW_PATH} />
        <motion.line x1="20" y1="22" x2="25" y2="22" stroke="#E85D04" strokeWidth="1.5" strokeLinecap="round" variants={DRAW_PATH} />
        {/* Bell bumps */}
        <motion.path d="M11 12 Q8 8 12 8" stroke="#E85D04" strokeWidth="1.2" strokeLinecap="round" fill="none" variants={DRAW_PATH} />
        <motion.path d="M29 12 Q32 8 28 8" stroke="#E85D04" strokeWidth="1.2" strokeLinecap="round" fill="none" variants={DRAW_PATH} />
      </motion.svg>
    ),
  },
  {
    label: 'Relay',
    icon: (
      <motion.svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true"
        initial="hidden" whileInView="visible" viewport={VIEWPORT}
      >
        {/* Phone handset */}
        <motion.path
          d="M10 14 C10 10, 14 8, 16 10 L18 13 C18 14, 17 15, 16 15 L14 15 C13 15, 12 17, 12 20 C12 23, 13 25, 14 25 L16 25 C17 25, 18 26, 18 27 L16 30 C14 32, 10 30, 10 26"
          stroke="#E85D04" strokeWidth="1.5" strokeLinecap="round" fill="none" variants={DRAW_PATH}
        />
        {/* Signal waves */}
        <motion.path d="M24 16 Q28 20 24 24" stroke="#E85D04" strokeWidth="1.2" strokeLinecap="round" fill="none" opacity={0.5} variants={DRAW_PATH} />
        <motion.path d="M28 13 Q34 20 28 27" stroke="#E85D04" strokeWidth="1" strokeLinecap="round" fill="none" opacity={0.3} variants={DRAW_PATH} />
      </motion.svg>
    ),
  },
  {
    label: 'Mesh',
    icon: (
      <motion.svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true"
        initial="hidden" whileInView="visible" viewport={VIEWPORT}
      >
        {/* Address book — rectangular book with tabs */}
        <motion.rect x="8" y="6" width="24" height="28" rx="2" stroke="#E85D04" strokeWidth="1.5" fill="none" variants={DRAW_PATH} />
        <motion.line x1="14" y1="6" x2="14" y2="34" stroke="#E85D04" strokeWidth="1.2" opacity={0.4} variants={DRAW_PATH} />
        {/* Tab marks */}
        <motion.line x1="8" y1="14" x2="11" y2="14" stroke="#E85D04" strokeWidth="1.5" strokeLinecap="round" variants={DRAW_PATH} />
        <motion.line x1="8" y1="22" x2="11" y2="22" stroke="#E85D04" strokeWidth="1.5" strokeLinecap="round" variants={DRAW_PATH} />
        <motion.line x1="8" y1="30" x2="11" y2="30" stroke="#E85D04" strokeWidth="1.5" strokeLinecap="round" variants={DRAW_PATH} />
        {/* Lines for entries */}
        <motion.line x1="18" y1="14" x2="28" y2="14" stroke="#E85D04" strokeWidth="1" strokeLinecap="round" opacity={0.3} variants={DRAW_PATH} />
        <motion.line x1="18" y1="18" x2="26" y2="18" stroke="#E85D04" strokeWidth="1" strokeLinecap="round" opacity={0.3} variants={DRAW_PATH} />
      </motion.svg>
    ),
  },
  {
    label: 'Wing',
    icon: (
      <motion.svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true"
        initial="hidden" whileInView="visible" viewport={VIEWPORT}
      >
        {/* Filing cabinet — stacked drawers */}
        <motion.rect x="8" y="6" width="24" height="28" rx="1.5" stroke="#E85D04" strokeWidth="1.5" fill="none" variants={DRAW_PATH} />
        <motion.line x1="8" y1="15" x2="32" y2="15" stroke="#E85D04" strokeWidth="1.2" variants={DRAW_PATH} />
        <motion.line x1="8" y1="24" x2="32" y2="24" stroke="#E85D04" strokeWidth="1.2" variants={DRAW_PATH} />
        {/* Drawer handles */}
        <motion.line x1="18" y1="10" x2="22" y2="10" stroke="#E85D04" strokeWidth="1.5" strokeLinecap="round" variants={DRAW_PATH} />
        <motion.line x1="18" y1="19" x2="22" y2="19" stroke="#E85D04" strokeWidth="1.5" strokeLinecap="round" variants={DRAW_PATH} />
        <motion.line x1="18" y1="28" x2="22" y2="28" stroke="#E85D04" strokeWidth="1.5" strokeLinecap="round" variants={DRAW_PATH} />
      </motion.svg>
    ),
  },
]

/** The OS metaphor reframe — makes "operating system" feel inevitable, not claimed. */
export function PivotSection() {
  const closingWords = 'So we built them one.'.split(' ')

  return (
    <section className="py-16 md:py-28 px-8 bg-cream-secondary">
      <motion.div
        className="max-w-2xl mx-auto text-center"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        <motion.p
          variants={REVEAL}
          className="text-charcoal text-[24px] md:text-[28px] font-medium tracking-[-0.02em] leading-[1.4] mb-10"
        >
          We solved this exact problem fifty years ago.
        </motion.p>

        <motion.div variants={STAGGER} className="space-y-3 mb-10">
          {[
            'Apps needed to run on a timer. We gave them alarm clocks.',
            'Apps needed to talk to each other. We gave them a phone line.',
            'Apps needed to find each other. We gave them an address book.',
            'Apps needed to remember things. We gave them a filing cabinet.',
          ].map((line) => (
            <motion.p
              key={line}
              variants={REVEAL}
              className="text-warm-gray text-[15px] md:text-base leading-[1.7]"
            >
              {line}
            </motion.p>
          ))}
        </motion.div>

        {/* OS metaphor icons — visual bridge from metaphor to product */}
        <motion.div
          variants={STAGGER}
          className="grid grid-cols-4 gap-6 max-w-sm mx-auto mb-10"
        >
          {OS_ICONS.map(({ label, icon }) => (
            <motion.div key={label} variants={REVEAL} className="flex flex-col items-center gap-2">
              {icon}
              <span className="font-mono text-[9px] tracking-[0.1em] uppercase text-brand-orange">
                {label}
              </span>
            </motion.div>
          ))}
        </motion.div>

        <motion.p
          variants={REVEAL}
          className="text-charcoal text-[24px] md:text-[28px] font-medium tracking-[-0.02em] leading-[1.4] mb-4"
        >
          We called it an operating system.
        </motion.p>

        <motion.p
          variants={REVEAL}
          className="text-warm-gray text-[18px] md:text-[20px] leading-[1.6] mt-6 mb-2"
        >
          Your AI agents have the same problems.
        </motion.p>

        {/* Word-by-word stagger on the closing line */}
        <motion.p
          variants={WORD_STAGGER}
          className="font-mono text-[24px] md:text-[32px] font-bold tracking-[-0.02em] leading-[1.2] mt-8"
          style={{ color: '#E85D04' }}
        >
          {closingWords.map((word, i) => (
            <motion.span
              key={i}
              variants={WORD_REVEAL}
              className="inline-block mr-[0.3em] last:mr-0"
            >
              {word}
            </motion.span>
          ))}
        </motion.p>
      </motion.div>
    </section>
  )
}
