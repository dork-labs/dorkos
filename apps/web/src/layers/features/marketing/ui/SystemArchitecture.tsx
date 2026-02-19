'use client'

import { useState, useCallback, useRef } from 'react'
import { motion } from 'motion/react'
import type { SystemModule } from '../lib/modules'
import { REVEAL, STAGGER, SCALE_IN, DRAW_PATH, VIEWPORT } from '../lib/motion-variants'

interface SystemArchitectureProps {
  modules: SystemModule[]
}

const nodes = [
  { x: 100, y: 50, label: 'Console' },
  { x: 300, y: 50, label: 'Core' },
  { x: 500, y: 50, label: 'Wing' },
  { x: 100, y: 160, label: 'Pulse' },
  { x: 300, y: 160, label: 'Mesh' },
  { x: 500, y: 160, label: 'Channels' },
] as const

const connections = [
  { d: 'M150,50 L250,50', delay: 0 },
  { d: 'M350,50 L450,50', delay: 0.15 },
  { d: 'M300,75 L300,135', delay: 0.3 },
  { d: 'M150,160 L250,160', delay: 0.45 },
  { d: 'M350,160 L450,160', delay: 0.6 },
] as const

/** Interactive architecture diagram showing the 6 DorkOS modules as a connected system. */
export function SystemArchitecture({ modules }: SystemArchitectureProps) {
  const [revealComplete, setRevealComplete] = useState(false)

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
            Six modules. One operating layer.
          </motion.p>

          <motion.p
            variants={REVEAL}
            className="text-warm-gray text-base leading-[1.7] text-center max-w-xl mx-auto mb-16"
          >
            DorkOS isn&apos;t a chat UI. It&apos;s an autonomous agent system with
            a heartbeat, a life layer, and an agent mesh.
          </motion.p>
        </motion.div>

        {/* Architecture diagram - SVG connections */}
        <div className="hidden md:block mb-16">
          <motion.svg
            viewBox="0 0 600 200"
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

        {/* Module cards grid with spotlight + lift hover */}
        <motion.div
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-4xl mx-auto"
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
          variants={STAGGER}
        >
          {modules.map((mod) => (
            <ModuleCard key={mod.id} mod={mod} />
          ))}
        </motion.div>
      </div>
    </section>
  )
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

  return (
    <motion.div
      ref={cardRef}
      variants={REVEAL}
      whileHover={{ y: -4 }}
      transition={{ type: 'spring', stiffness: 300, damping: 25 }}
      onMouseMove={handleMouseMove}
      className="relative bg-cream-white rounded-lg p-6 border border-[var(--border-warm)] group overflow-hidden"
    >
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
            {mod.status === 'available' ? 'Available' : 'Coming Soon'}
          </span>
        </div>
        <p className="font-mono text-3xs text-warm-gray-light tracking-[0.05em] uppercase mb-2">
          {mod.label}
        </p>
        <p className="text-warm-gray text-sm leading-relaxed">{mod.description}</p>
      </div>
    </motion.div>
  )
}
