'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'
import { motion, useInView, useReducedMotion } from 'motion/react'
import { Copy, Check } from 'lucide-react'
import { REVEAL, STAGGER, VIEWPORT } from '../lib/motion-variants'

const SCRAMBLE_CHARS = '!@#$%&*_+-=<>?~'

const INSTALL_METHODS = [
  {
    id: 'curl',
    label: 'One-liner',
    command: 'curl -fsSL https://dorkos.ai/install | bash',
    description: 'Checks Node.js, installs via npm, offers setup wizard.',
    recommended: true,
  },
  {
    id: 'npm',
    label: 'npm',
    command: 'npm install -g dorkos',
    description: 'Requires Node.js 18+.',
    recommended: false,
  },
  {
    id: 'brew',
    label: 'Homebrew',
    command: 'brew install dorkos-ai/tap/dorkos',
    description: 'macOS and Linux. Updates via brew upgrade.',
    recommended: false,
  },
] as const

/**
 * Scramble/decode effect — each position cycles through random characters
 * before settling on the real character. Creates a "system booting" feel.
 */
function useTextScramble(text: string, isActive: boolean) {
  const reducedMotion = useReducedMotion()
  const [display, setDisplay] = useState(text)
  const hasRun = useRef(false)

  const scramble = useCallback(() => {
    if (hasRun.current) return
    hasRun.current = true

    const chars = text.split('')
    const settled = new Array(chars.length).fill(false)
    let frame = 0

    const interval = setInterval(() => {
      frame++
      const result = chars.map((char, i) => {
        if (char === ' ') return ' '
        const settleAt = (i + 1) * 3
        if (frame >= settleAt) {
          settled[i] = true
          return char
        }
        return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)]
      })

      setDisplay(result.join(''))

      if (settled.every(Boolean)) {
        clearInterval(interval)
      }
    }, 30)

    return () => clearInterval(interval)
  }, [text])

  useEffect(() => {
    if (!isActive || reducedMotion) return
    return scramble()
  }, [isActive, reducedMotion, scramble])

  return display
}

/** Combined install + close section — "Ready." headline with tabbed install in a terminal mockup. */
export function InstallMoment() {
  const ref = useRef<HTMLDivElement>(null)
  const isInView = useInView(ref, { once: true, amount: 0.3 })
  const [activeTab, setActiveTab] = useState('curl')
  const [copied, setCopied] = useState(false)

  const activeMethod = INSTALL_METHODS.find((m) => m.id === activeTab)!
  const displayText = useTextScramble(INSTALL_METHODS[0].command, isInView && activeTab === 'curl')

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(activeMethod.command)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [activeMethod.command])

  return (
    <section id="install" ref={ref} className="py-14 md:py-24 px-8 bg-cream-primary relative">
      {/* Graph-paper background */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: `
            linear-gradient(to right, rgba(139, 90, 43, 0.07) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(139, 90, 43, 0.07) 1px, transparent 1px)
          `,
          backgroundSize: '32px 32px',
          maskImage: 'linear-gradient(to bottom, transparent 0%, black 30%, black 70%, transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 30%, black 70%, transparent 100%)',
        }}
      />

      <motion.div
        className="max-w-xl mx-auto text-center relative z-10"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        {/* Headline */}
        <motion.p
          variants={REVEAL}
          className="text-warm-gray text-lg md:text-xl leading-[1.5] mb-6"
        >
          Your agents are ready. Give them the night.
        </motion.p>

        <motion.p
          variants={REVEAL}
          className="font-mono text-[48px] md:text-[72px] font-bold text-brand-orange leading-none tracking-[-0.03em] mb-10"
        >
          Get started<span className="cursor-blink" aria-hidden="true" />.
        </motion.p>

        {/* Tab bar */}
        <motion.div variants={REVEAL} className="flex items-center justify-center gap-1 mb-4">
          {INSTALL_METHODS.map((method) => (
            <button
              key={method.id}
              onClick={() => {
                setActiveTab(method.id)
                setCopied(false)
              }}
              className={`font-mono text-xs tracking-[0.06em] px-3 py-1.5 rounded-md transition-all inline-flex items-center gap-1.5 ${
                activeTab === method.id
                  ? 'bg-charcoal text-cream'
                  : 'text-warm-gray-light hover:text-charcoal'
              }`}
            >
              {method.label}
              {method.recommended && (
                <span
                  className="text-[8px] tracking-[0.1em] uppercase px-1 py-px rounded-sm"
                  style={{
                    background: activeTab === method.id ? 'rgba(255,255,255,0.15)' : 'rgba(232, 93, 4, 0.1)',
                    color: activeTab === method.id ? '#FFFEFB' : '#E85D04',
                  }}
                >
                  recommended
                </span>
              )}
            </button>
          ))}
        </motion.div>

        {/* Terminal mockup */}
        <motion.div variants={REVEAL} className="mb-3">
          <div
            className="rounded-lg overflow-hidden mx-auto max-w-lg"
            style={{
              border: '1px solid rgba(139, 90, 43, 0.12)',
              background: '#1A1814',
              boxShadow: '0 1px 3px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.12)',
            }}
          >
            {/* Terminal title bar */}
            <div
              className="flex items-center justify-between px-3 py-2"
              style={{ background: '#252220', borderBottom: '1px solid rgba(255,255,255,0.06)' }}
            >
              <div className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 rounded-full" style={{ background: '#E85D04', opacity: 0.5 }} />
                <div className="w-2.5 h-2.5 rounded-full" style={{ background: '#7A756A', opacity: 0.3 }} />
                <div className="w-2.5 h-2.5 rounded-full" style={{ background: '#7A756A', opacity: 0.3 }} />
              </div>
              <span className="font-mono text-[10px] tracking-[0.06em]" style={{ color: '#7A756A' }}>
                Terminal
              </span>
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors hover:bg-white/10"
                aria-label="Copy command"
              >
                {copied ? (
                  <Check size={12} style={{ color: '#228B22' }} />
                ) : (
                  <Copy size={12} style={{ color: '#7A756A' }} />
                )}
                <span className="font-mono text-[10px]" style={{ color: copied ? '#228B22' : '#7A756A' }}>
                  {copied ? 'copied' : 'copy'}
                </span>
              </button>
            </div>

            {/* Terminal body */}
            <div className="px-4 py-4">
              <p className="font-mono text-sm md:text-base text-left" style={{ color: '#F5F0E6' }}>
                <span style={{ color: '#E85D04' }}>~ </span>
                <span style={{ color: '#7A756A' }}>$ </span>
                {activeTab === 'curl' ? displayText : activeMethod.command}
                <span className="cursor-blink" aria-hidden="true" />
              </p>
            </div>
          </div>
        </motion.div>

        {/* "Run in terminal" hint + description */}
        <motion.div variants={REVEAL} className="mb-10">
          <p className="text-warm-gray-light text-xs font-mono mb-1 tracking-[0.04em]">
            Run in your terminal
          </p>
          <p className="text-warm-gray-light text-sm font-mono">
            {activeMethod.description}
          </p>
        </motion.div>

        {/* Badges */}
        <motion.div
          variants={REVEAL}
          className="flex flex-wrap items-center justify-center gap-2 mb-6"
        >
          {['Open Source', 'MIT Licensed', 'Runs on Your Machine'].map((badge) => (
            <span
              key={badge}
              className="font-mono text-[9px] tracking-[0.08em] uppercase px-2 py-0.5 rounded-[3px]"
              style={{
                background: 'rgba(232, 93, 4, 0.06)',
                color: '#7A756A',
                border: '1px solid rgba(232, 93, 4, 0.12)',
              }}
            >
              {badge}
            </span>
          ))}
        </motion.div>

        <motion.p variants={REVEAL} className="text-charcoal text-lg font-medium mb-2">
          One person. Ten agents. Ship around the clock.
        </motion.p>

        <motion.div variants={REVEAL} className="flex items-center justify-center gap-6 mt-8">
          <Link
            href="/docs/getting-started/quickstart"
            className="font-mono text-button tracking-[0.08em] text-warm-gray-light hover:text-brand-orange transition-smooth"
          >
            Read the docs
          </Link>
        </motion.div>
      </motion.div>
    </section>
  )
}
