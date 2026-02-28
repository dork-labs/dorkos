'use client'

import { Fragment, useRef } from 'react'
import { motion, useScroll, useTransform } from 'motion/react'
import { timelineEntries } from '../lib/timeline-entries'
import { REVEAL, STAGGER, VIEWPORT } from '../lib/motion-variants'

const MODULE_NAMES = ['PULSE', 'RELAY', 'MESH', 'CONSOLE', 'WING', 'LOOP', 'ENGINE']

/**
 * Deterministic star positions — no Math.random(), no hydration mismatch.
 * Each star has x% (0-100), y% (0-100), size (1-2px), and animation delay (0-6s).
 */
const STARS: Array<{ x: number; y: number; size: number; delay: number; duration: number }> = Array.from(
  { length: 40 },
  (_, i) => ({
    x: ((i * 37 + 13) % 97) + 1,
    y: ((i * 53 + 7) % 93) + 2,
    size: (i % 3 === 0) ? 2 : 1,
    delay: (i * 0.73) % 6,
    duration: 2 + (i % 5) * 0.8,
  })
)

/** Render text with [MODULE] references highlighted in brand orange monospace. */
function renderWithModules(text: string) {
  const parts = text.split(/(\[[A-Z]+\])/)
  return parts.map((part, i) => {
    const match = part.match(/^\[([A-Z]+)\]$/)
    if (match && MODULE_NAMES.includes(match[1])) {
      return (
        <span key={i} className="font-mono text-brand-orange">
          {match[1]}
        </span>
      )
    }
    return <Fragment key={i}>{part}</Fragment>
  })
}

/** "A Night with DorkOS" — vertical timeline showing the product through story. */
export function TimelineSection() {
  const sectionRef = useRef<HTMLElement>(null)
  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ['start end', 'end start'],
  })

  /* Orange beam draws from 0% to 100% height as user scrolls through the section */
  const beamHeight = useTransform(scrollYProgress, [0.1, 0.9], ['0%', '100%'])

  return (
    <section
      ref={sectionRef}
      className="px-8 py-16 md:py-32 relative"
      style={{
        background: 'linear-gradient(to bottom, #FAF7F0 0%, #FFFEFB 100%)',
      }}
    >
      {/* Subtle star field — tiny dots that pulse like distant stars, fading at dawn (bottom) */}
      <div
        className="absolute inset-0 pointer-events-none hidden md:block"
        aria-hidden="true"
        style={{
          maskImage: 'linear-gradient(to bottom, black 0%, black 60%, transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, black 0%, black 60%, transparent 100%)',
        }}
      >
        {STARS.map((star, i) => (
          <div
            key={i}
            className="absolute rounded-full"
            style={{
              left: `${star.x}%`,
              top: `${star.y}%`,
              width: star.size,
              height: star.size,
              background: 'rgba(139, 90, 43, 0.15)',
              animation: `star-twinkle ${star.duration}s ease-in-out ${star.delay}s infinite`,
            }}
          />
        ))}
      </div>

      <motion.div
        className="mx-auto max-w-3xl relative z-10"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        <motion.div variants={REVEAL} className="mb-20">
          <span className="text-2xs font-mono tracking-[0.2em] uppercase text-brand-orange mb-6 block text-center">
            A Night with DorkOS
          </span>
        </motion.div>

        <div className="relative">
          {/* Static gray track line */}
          <div
            className="absolute top-0 bottom-0 left-[72px] hidden w-px md:block"
            style={{ background: 'rgba(139, 90, 43, 0.12)' }}
          />

          {/* Scroll-scrubbed orange beam */}
          <motion.div
            className="absolute top-0 left-[72px] hidden w-px md:block"
            style={{
              height: beamHeight,
              background: '#E85D04',
              opacity: 0.6,
            }}
          />

          <motion.div variants={STAGGER} className="space-y-12">
            {timelineEntries.map((entry) => (
              <motion.div
                key={entry.id}
                variants={REVEAL}
                className="flex flex-col gap-4 md:flex-row md:gap-8"
              >
                <div className="shrink-0 md:w-[72px] md:text-right">
                  <span className="font-mono text-xs tracking-[0.04em]" style={{ color: '#7A756A' }}>
                    {entry.time}
                  </span>
                </div>

                <div className="hidden items-start pt-1.5 md:flex">
                  <div className="h-2 w-2 shrink-0 rounded-full" style={{ background: '#E85D04' }} />
                </div>

                <div className="flex-1 space-y-3">
                  <p className="text-charcoal text-[16px] md:text-[17px] font-semibold leading-[1.5] tracking-[-0.01em]">
                    {entry.headline}
                  </p>
                  {entry.paragraphs.map((p, i) => (
                    <p key={i} className="text-warm-gray text-[15px] leading-[1.75]">
                      {renderWithModules(p)}
                    </p>
                  ))}
                </div>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </motion.div>
    </section>
  )
}
