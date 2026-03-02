'use client'

import { Fragment, useEffect, useId, useRef, useState } from 'react'
import { type MotionValue, motion, useScroll, useSpring, useTransform, useVelocity } from 'motion/react'
import { timelineEntries } from '../lib/timeline-entries'
import { REVEAL, STAGGER, VIEWPORT } from '../lib/motion-variants'

const MODULE_NAMES = ['PULSE', 'RELAY', 'MESH', 'CONSOLE', 'WING', 'LOOP', 'ENGINE']

/**
 * Scroll progress range where the beam travels from top to bottom.
 * With offset ['start end', 'end start'], content is viewable roughly in the 0.15–0.7 range.
 * Beam completes within this window so all dots activate while visible.
 */
const BEAM_START = 0.12
const BEAM_END = 0.65
const BEAM_SPAN = BEAM_END - BEAM_START

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
  const timelineRef = useRef<HTMLDivElement>(null)
  const [svgHeight, setSvgHeight] = useState(0)
  const gradientId = useId()

  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ['start end', 'end start'],
  })

  /* Measure timeline content height, re-measure on resize */
  useEffect(() => {
    const el = timelineRef.current
    if (!el) return

    const measure = () => setSvgHeight(el.offsetHeight)
    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  /* y1 = leading edge (bright tip). y2 = trailing edge (far behind, creates long tail).
     Gradient goes from y1 (bottom, leading) to y2 (top, trailing) — offset 0% is at the tip. */
  const y1 = useSpring(
    useTransform(scrollYProgress, [BEAM_START, BEAM_END], [0, svgHeight]),
    { stiffness: 400, damping: 90 }
  )
  const y2 = useSpring(
    useTransform(scrollYProgress, [BEAM_START, BEAM_END + 0.2], [-svgHeight * 0.4, svgHeight]),
    { stiffness: 200, damping: 90 }
  )

  /* Scroll velocity drives beam glow intensity */
  const scrollVelocity = useVelocity(scrollYProgress)
  const velocityGlow = useSpring(
    useTransform(scrollVelocity, [-0.5, 0, 0.5], [0.4, 0, 0.4]),
    { stiffness: 300, damping: 40 }
  )

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

        <div className="relative" ref={timelineRef}>
          {/* SVG tracing beam — gradient travels down the track as user scrolls.
              108px = 72px time-col + 32px gap + 4px dot-center */}
          {svgHeight > 0 && (
            <div className="absolute top-0 bottom-0 left-[108px] hidden -translate-x-1/2 md:block" aria-hidden="true">
              <svg
                viewBox={`0 0 20 ${svgHeight}`}
                width="20"
                height={svgHeight}
                className="block"
              >
                {/* SVG blur filter for velocity glow */}
                <defs>
                  <filter id={`${gradientId}-glow`}>
                    <feGaussianBlur stdDeviation="2" />
                  </filter>
                  <motion.linearGradient
                    id={gradientId}
                    gradientUnits="userSpaceOnUse"
                    x1="0"
                    x2="0"
                    y1={y1}
                    y2={y2}
                  >
                    <stop offset="0" stopColor="#E85D04" stopOpacity="0" />
                    <stop offset="0.03" stopColor="#E85D04" stopOpacity="0.9" />
                    <stop offset="0.1" stopColor="#F48C06" />
                    <stop offset="0.4" stopColor="#E85D04" stopOpacity="0.15" />
                    <stop offset="1" stopColor="#E85D04" stopOpacity="0" />
                  </motion.linearGradient>
                </defs>

                {/* Static background track */}
                <path
                  d={`M 10 0 V ${svgHeight}`}
                  fill="none"
                  stroke="rgba(139, 90, 43, 0.12)"
                  strokeWidth="1"
                />
                {/* Animated gradient beam */}
                <motion.path
                  d={`M 10 0 V ${svgHeight}`}
                  fill="none"
                  stroke={`url(#${gradientId})`}
                  strokeWidth="2"
                  className="motion-reduce:hidden"
                />
                {/* Velocity-driven glow layer — uses SVG filter for proper blur */}
                <motion.path
                  d={`M 10 0 V ${svgHeight}`}
                  fill="none"
                  stroke={`url(#${gradientId})`}
                  strokeWidth="6"
                  filter={`url(#${gradientId}-glow)`}
                  style={{ opacity: velocityGlow }}
                  className="motion-reduce:hidden"
                />
              </svg>
            </div>
          )}

          <motion.div variants={STAGGER} className="space-y-12">
            {timelineEntries.map((entry, entryIndex) => (
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
                  <TimelineDot
                    scrollYProgress={scrollYProgress}
                    index={entryIndex}
                    count={timelineEntries.length}
                  />
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

/** Timeline dot that glows as the beam reaches it. */
function TimelineDot({
  scrollYProgress,
  index,
  count,
}: {
  scrollYProgress: MotionValue<number>
  index: number
  count: number
}) {
  /* Derived from BEAM_START/BEAM_SPAN so dot activation stays in sync with beam position */
  const activateAt = BEAM_START + BEAM_SPAN * index / Math.max(count - 1, 1)
  const progress = useTransform(scrollYProgress, [activateAt - 0.02, activateAt + 0.02], [0, 1])
  const scale = useTransform(progress, [0, 1], [1, 1.4])
  const opacity = useTransform(progress, [0, 1], [0.4, 1])

  return (
    <motion.div
      className="relative h-2 w-2 shrink-0 rounded-full motion-reduce:opacity-100 motion-reduce:scale-100"
      style={{
        background: '#E85D04',
        scale,
        opacity,
      }}
    >
      <motion.div
        className="absolute -inset-1 -z-10 rounded-full motion-reduce:hidden"
        style={{
          background: 'radial-gradient(circle, rgba(232, 93, 4, 0.5) 0%, transparent 70%)',
          opacity: progress,
        }}
      />
    </motion.div>
  )
}
