'use client'

import dynamic from 'next/dynamic'
import { motion } from 'motion/react'
import { subsystems } from '../lib/subsystems'
import { REVEAL, SPRING, STAGGER, VIEWPORT } from '../lib/motion-variants'

// Lazy-load topology graph — only loads when section enters viewport (~150kB)
const SubsystemTopology = dynamic(() => import('./SubsystemTopology').then((m) => ({ default: m.SubsystemTopology })), {
  ssr: false,
  loading: () => <div className="h-[300px]" />,
})

// ─── Animated SVG Icons ──────────────────────────────────────────────────────

/** Draw path variant — pathLength animates from 0 to 1. */
const DRAW = {
  hidden: { pathLength: 0, opacity: 0 },
  visible: { pathLength: 1, opacity: 1, transition: { duration: 1.2, ease: 'easeInOut' as const } },
}

/** Scale-in variant for SVG circles/nodes. */
const NODE_IN = {
  hidden: { scale: 0, opacity: 0 },
  visible: { scale: 1, opacity: 1, transition: SPRING },
}

/** Bar grow variant — height animates from 0. */
const barGrow = (height: number, delay: number) => ({
  hidden: { height: 0, opacity: 0 },
  visible: { height, opacity: 1, transition: { ...SPRING, delay: delay * 0.08 } },
})

/** Slide-in variant for wing layers. */
const slideIn = (delay: number) => ({
  hidden: { x: -10, opacity: 0 },
  visible: { x: 0, opacity: 1, transition: { ...SPRING, delay: delay * 0.1 } },
})

/** Animated SVG icons per subsystem — each element draws/grows on viewport entry. */
const SUBSYSTEM_ICONS: Record<string, React.ReactNode> = {
  pulse: (
    <motion.svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true"
      initial="hidden" whileInView="visible" viewport={VIEWPORT}
    >
      {/* Timing bars grow from bottom — staggered heights */}
      {[
        { x: 2, h: 8, opacity: 0.7, i: 0 },
        { x: 7, h: 14, opacity: 0.85, i: 1 },
        { x: 12, h: 10, opacity: 0.6, i: 2 },
        { x: 17, h: 16, opacity: 0.9, i: 3 },
        { x: 22, h: 12, opacity: 0.75, i: 4 },
      ].map(({ x, h, opacity, i }) => (
        <motion.rect
          key={x}
          x={x} y={24 - h} width="3" rx="1"
          fill="#E85D04" opacity={opacity}
          variants={barGrow(h, i)}
        />
      ))}
    </motion.svg>
  ),
  relay: (
    <motion.svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true"
      initial="hidden" whileInView="visible" viewport={VIEWPORT}
    >
      <motion.circle cx="4" cy="14" r="3" fill="#E85D04" opacity={0.8} variants={NODE_IN} />
      <motion.path d="M7 14 L14 8 L21 14" stroke="#E85D04" strokeWidth="1.5" opacity={0.5} fill="none" variants={DRAW} />
      <motion.circle cx="24" cy="14" r="3" fill="#E85D04" opacity={0.8} variants={NODE_IN} />
    </motion.svg>
  ),
  mesh: (
    <motion.svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true"
      initial="hidden" whileInView="visible" viewport={VIEWPORT}
    >
      <motion.line x1="14" y1="5" x2="5" y2="22" stroke="#E85D04" strokeWidth="1.2" opacity={0.4} variants={DRAW} />
      <motion.line x1="14" y1="5" x2="23" y2="22" stroke="#E85D04" strokeWidth="1.2" opacity={0.4} variants={DRAW} />
      <motion.line x1="5" y1="22" x2="23" y2="22" stroke="#E85D04" strokeWidth="1.2" opacity={0.4} variants={DRAW} />
      <motion.circle cx="14" cy="5" r="3" fill="#E85D04" opacity={0.8} variants={NODE_IN} />
      <motion.circle cx="5" cy="22" r="3" fill="#E85D04" opacity={0.8} variants={NODE_IN} />
      <motion.circle cx="23" cy="22" r="3" fill="#E85D04" opacity={0.8} variants={NODE_IN} />
    </motion.svg>
  ),
  wing: (
    <motion.svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true"
      initial="hidden" whileInView="visible" viewport={VIEWPORT}
    >
      <motion.rect x="4" y="6" width="20" height="4" rx="1.5" fill="#E85D04" opacity={0.4} variants={slideIn(0)} />
      <motion.rect x="4" y="12" width="20" height="4" rx="1.5" fill="#E85D04" opacity={0.6} variants={slideIn(1)} />
      <motion.rect x="4" y="18" width="20" height="4" rx="1.5" fill="#E85D04" opacity={0.8} variants={slideIn(2)} />
    </motion.svg>
  ),
  console: (
    <motion.svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true"
      initial="hidden" whileInView="visible" viewport={VIEWPORT}
    >
      <motion.path d="M5 10 L11 14 L5 18" stroke="#E85D04" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity={0.8} fill="none" variants={DRAW} />
      <motion.line x1="14" y1="18" x2="23" y2="18" stroke="#E85D04" strokeWidth="2" strokeLinecap="round" opacity={0.5} variants={DRAW} />
    </motion.svg>
  ),
  loop: (
    <motion.svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true"
      initial="hidden" whileInView="visible" viewport={VIEWPORT}
    >
      <motion.path d="M14 4 A10 10 0 1 1 4 14" stroke="#E85D04" strokeWidth="1.5" fill="none" opacity={0.6} variants={DRAW} />
      <motion.polygon points="14,2 14,6 10,4" fill="#E85D04" opacity={0.8} variants={NODE_IN} />
    </motion.svg>
  ),
}

// ─── Main export ─────────────────────────────────────────────────────────────

/** Compact subsystems reference — benefit on the left, module fix on the right. */
export function SubsystemsSection() {
  return (
    <section className="bg-cream-primary px-8 py-20">
      <motion.div
        className="mx-auto max-w-[720px]"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        <motion.span
          variants={REVEAL}
          className="text-2xs font-mono tracking-[0.2em] text-brand-orange mb-6 block text-center uppercase"
        >
          Subsystems
        </motion.span>

        <motion.p
          variants={REVEAL}
          className="text-[24px] md:text-[28px] font-medium text-charcoal tracking-[-0.02em] leading-[1.3] text-center mb-12"
        >
          Six reasons they run while you sleep.
        </motion.p>

        <motion.div variants={STAGGER} className="space-y-0">
          {subsystems.map((sub) => (
            <motion.div
              key={sub.id}
              variants={REVEAL}
              className="flex items-center gap-5 py-4"
              style={{ borderBottom: '1px solid rgba(139, 90, 43, 0.08)' }}
            >
              <span className="text-2xs text-warm-gray-light w-auto md:w-[120px] shrink-0 md:text-right font-mono tracking-[0.06em] hidden md:block">
                {sub.benefit}
              </span>
              <div className="shrink-0 w-7 h-7 flex items-center justify-center">
                {SUBSYSTEM_ICONS[sub.id]}
              </div>
              <div className="flex-1">
                <span className="block text-2xs text-warm-gray-light font-mono tracking-[0.06em] mb-0.5 md:hidden">
                  {sub.benefit}
                </span>
                <span className="text-brand-orange font-mono text-sm">{sub.name}</span>
                {sub.status === 'coming-soon' && (
                  <span className="text-2xs text-warm-gray-light ml-2 font-mono">In development</span>
                )}
                <span className="text-warm-gray text-sm"> &mdash; {sub.description}</span>
              </div>
            </motion.div>
          ))}
        </motion.div>

        {/* Topology visualization — shows how modules connect */}
        <motion.div variants={REVEAL} className="mt-16">
          <div
            className="rounded-lg overflow-hidden hidden md:block"
            style={{
              border: '1px solid rgba(139, 90, 43, 0.1)',
              background: '#FFFEFB',
            }}
          >
            {/* Browser frame chrome */}
            <div
              className="flex items-center gap-1.5 px-3 py-2"
              style={{ background: '#F5F0E6', borderBottom: '1px solid rgba(139, 90, 43, 0.08)' }}
            >
              <div className="w-2 h-2 rounded-full" style={{ background: 'rgba(122, 117, 106, 0.2)' }} />
              <div className="w-2 h-2 rounded-full" style={{ background: 'rgba(122, 117, 106, 0.2)' }} />
              <div className="w-2 h-2 rounded-full" style={{ background: 'rgba(122, 117, 106, 0.2)' }} />
              <span className="ml-2 font-mono text-[9px] tracking-[0.08em] uppercase text-warm-gray-light">
                How they connect
              </span>
            </div>
            <div className="h-[300px]">
              <SubsystemTopology />
            </div>
          </div>
        </motion.div>
      </motion.div>
    </section>
  )
}
