'use client'

import { useState, useCallback, useRef } from 'react'
import { motion } from 'motion/react'
import type { SystemModule } from '../lib/modules'
import { REVEAL, STAGGER, SCALE_IN, DRAW_PATH, VIEWPORT } from '../lib/motion-variants'

interface SystemArchitectureProps {
  modules: SystemModule[]
}

const nodes = [
  { x: 150, y: 40, label: 'Console' },
  { x: 350, y: 40, label: 'Engine' },
  { x: 100, y: 140, label: 'Pulse' },
  { x: 300, y: 140, label: 'Mesh' },
  { x: 500, y: 140, label: 'Relay' },
  { x: 150, y: 240, label: 'Wing' },
  { x: 350, y: 240, label: 'Loop' },
] as const

const connections = [
  { d: 'M200,40 L300,40', delay: 0 },
  { d: 'M340,65 L140,115', delay: 0.15 },
  { d: 'M350,65 L300,115', delay: 0.3 },
  { d: 'M360,65 L460,115', delay: 0.45 },
] as const

const GROUP_LABELS: Record<string, string> = {
  platform: 'The Platform',
  'engine-capability': 'Composable Modules',
  extension: 'Extensions',
}

const GROUP_ORDER: Array<SystemModule['group']> = ['platform', 'engine-capability', 'extension']

const GROUP_COLS: Record<string, string> = {
  platform: 'grid-cols-1 md:grid-cols-2',
  'engine-capability': 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3',
  extension: 'grid-cols-1 md:grid-cols-2',
}

/** Interactive architecture diagram showing the 7 DorkOS modules as a connected system. */
export function SystemArchitecture({ modules }: SystemArchitectureProps) {
  const [revealComplete, setRevealComplete] = useState(false)

  const grouped = GROUP_ORDER.map((group) => ({
    group,
    label: GROUP_LABELS[group],
    modules: modules.filter((m) => m.group === group),
  }))

  return (
    <section id="system" className="py-32 px-8 bg-cream-tertiary">
      <div className="max-w-5xl mx-auto">
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
          variants={STAGGER}
        >
          <motion.span
            variants={REVEAL}
            className="font-mono text-2xs tracking-[0.15em] uppercase text-brand-orange text-center block mb-6"
          >
            The System
          </motion.span>

          <motion.p
            variants={REVEAL}
            className="text-charcoal text-[28px] md:text-[32px] font-medium tracking-[-0.02em] leading-[1.3] text-center max-w-2xl mx-auto mb-6"
          >
            Platform. Modules. Extensions.
          </motion.p>

          <motion.p
            variants={REVEAL}
            className="text-warm-gray text-base leading-[1.7] text-center max-w-xl mx-auto mb-16"
          >
            DorkOS isn&apos;t a chat UI. It&apos;s an autonomous agent operating
            system — an engine, a life layer, and a mesh of coordinating agents.
          </motion.p>
        </motion.div>

        {/* Architecture diagram - SVG connections */}
        <div className="hidden md:block mb-16">
          <motion.svg
            viewBox="0 0 600 280"
            className="w-full max-w-2xl mx-auto h-auto architecture-particles"
            preserveAspectRatio="xMidYMid meet"
            aria-hidden="true"
            initial="hidden"
            whileInView="visible"
            viewport={VIEWPORT}
            variants={STAGGER}
            onAnimationComplete={() => setRevealComplete(true)}
          >
            {/* Layer 1 + 2: Connection paths with draw-in and post-reveal dashes */}
            {connections.map((conn, i) => (
              <g key={conn.d}>
                <motion.path
                  d={conn.d}
                  variants={DRAW_PATH}
                  fill="none"
                  stroke="var(--color-brand-orange)"
                  strokeWidth="1.5"
                  strokeOpacity="0.6"
                  className={revealComplete ? 'architecture-dashes' : ''}
                  style={revealComplete ? { animationDelay: `${i * 0.3}s` } : undefined}
                />

                {/* Layer 3: SMIL traveling particle */}
                <circle r="2" fill="var(--color-brand-orange)" opacity="0.6">
                  <animateMotion
                    path={conn.d}
                    dur={`${2.5 + i * 0.5}s`}
                    repeatCount="indefinite"
                    begin="1.5s"
                  />
                </circle>
              </g>
            ))}

            {/* Nodes with scale-in */}
            {nodes.map((node) => (
              <motion.g key={node.label} variants={SCALE_IN}>
                <circle
                  cx={node.x}
                  cy={node.y}
                  r="6"
                  fill="var(--color-brand-orange)"
                  opacity="0.8"
                />
                <text
                  x={node.x}
                  y={node.y + 22}
                  textAnchor="middle"
                  className="fill-charcoal text-[11px] font-mono"
                >
                  {node.label}
                </text>
              </motion.g>
            ))}
          </motion.svg>
        </div>

        {/* Module cards grouped by type */}
        {grouped.map(({ group, label, modules: groupModules }) => (
          <div key={group} className="mb-10 last:mb-0">
            <motion.p
              initial="hidden"
              whileInView="visible"
              viewport={VIEWPORT}
              variants={REVEAL}
              className="font-mono text-2xs tracking-[0.12em] uppercase text-warm-gray-light mb-4 max-w-4xl mx-auto"
            >
              {label}
            </motion.p>
            <motion.div
              className={`grid ${GROUP_COLS[group]} gap-6 max-w-4xl mx-auto`}
              initial="hidden"
              whileInView="visible"
              viewport={VIEWPORT}
              variants={STAGGER}
            >
              {groupModules.map((mod) => (
                <ModuleCard key={mod.id} mod={mod} />
              ))}
            </motion.div>
          </div>
        ))}
      </div>
    </section>
  )
}

/** Resolve display label for a module's status badge. */
function getStatusLabel(mod: SystemModule): string {
  if (mod.url) return 'Live'
  return mod.status === 'available' ? 'Available' : 'Coming Soon'
}

/** Module card with spotlight cursor-tracking and spring lift hover. */
function ModuleCard({ mod }: { mod: SystemModule }) {
  const cardRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number>(0)

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      const card = cardRef.current
      if (!card) return
      const rect = card.getBoundingClientRect()
      card.style.setProperty('--mouse-x', `${e.clientX - rect.left}px`)
      card.style.setProperty('--mouse-y', `${e.clientY - rect.top}px`)
    })
  }, [])

  const inner = (
    <>
      {/* Spotlight overlay - desktop only */}
      <div
        className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none hidden [@media(hover:hover)]:block"
        style={{
          background:
            'radial-gradient(250px circle at var(--mouse-x) var(--mouse-y), rgba(207, 114, 43, 0.06), transparent 80%)',
        }}
      />

      <div className="relative z-10">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-charcoal text-lg">{mod.name}</h3>
          <span
            className={`font-mono text-3xs tracking-[0.1em] uppercase px-2 py-0.5 rounded ${
              mod.status === 'available'
                ? 'bg-brand-green/10 text-brand-green'
                : 'bg-warm-gray-light/10 text-warm-gray-light'
            }`}
          >
            {getStatusLabel(mod)}
          </span>
        </div>
        <p className="font-mono text-3xs text-warm-gray-light tracking-[0.05em] uppercase mb-2">
          {mod.label}
        </p>
        <p className="text-warm-gray text-sm leading-relaxed">{mod.description}</p>
      </div>
    </>
  )

  return (
    <motion.div
      ref={cardRef}
      variants={REVEAL}
      whileHover={{ y: -4 }}
      transition={{ type: 'spring', stiffness: 300, damping: 25 }}
      onMouseMove={handleMouseMove}
      className="relative bg-cream-white rounded-lg p-6 border border-[var(--border-warm)] group overflow-hidden"
    >
      {mod.url ? (
        <a href={mod.url} target="_blank" rel="noopener noreferrer" className="block">
          {inner}
        </a>
      ) : (
        inner
      )}
    </motion.div>
  )
}
