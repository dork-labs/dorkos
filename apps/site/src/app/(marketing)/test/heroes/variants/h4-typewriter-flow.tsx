'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'
import { motion, AnimatePresence } from 'motion/react'
import { REVEAL } from '@/layers/features/marketing/lib/motion-variants'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeroProps {
  headline: string
  subhead: string
  ctaText: string
  ctaHref: string
}

// ---------------------------------------------------------------------------
// Terminal content definitions
// ---------------------------------------------------------------------------

const TERMINAL_LINES = [
  {
    prompt: '$ npm install -g dorkos',
    outputs: ['✓ installed'],
  },
  {
    prompt: '$ dorkos --dir ~/my-project',
    outputs: ['✓ Server running on :4242'],
  },
  {
    prompt: '$ # Your agents are now working...',
    outputs: [
      '→ Agent reviewed 12 PRs',
      '→ Agent committed 3 fixes',
      '→ Agent updated documentation',
    ],
  },
] as const

/** Minimum ms per character — randomness adds up to 40ms on top. */
const CHAR_DELAY_BASE = 40
const CHAR_DELAY_JITTER = 40

/** Delay between output lines appearing (ms). */
const OUTPUT_LINE_DELAY = 280

/** Pause after command before outputs appear (ms). */
const POST_COMMAND_DELAY = 220

/** Pause between terminal steps (ms). */
const INTER_STEP_DELAY = 400

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** A single prompt line with optional blinking cursor at the end. */
function TerminalPrompt({
  text,
  showCursor,
}: {
  text: string
  showCursor: boolean
}) {
  // Split on the `$` so we can color just the prompt symbol.
  const isComment = text.startsWith('$ #')
  const dollar = text.slice(0, 1)
  const rest = text.slice(1)

  return (
    <div className="flex items-start gap-0 leading-relaxed">
      <span
        className="select-none shrink-0"
        style={{ color: 'var(--brand-orange)' }}
      >
        {dollar}
      </span>
      <span
        className="ml-0 font-mono"
        style={{ color: isComment ? 'var(--warm-gray-light)' : 'var(--charcoal)' }}
      >
        {rest}
      </span>
      {showCursor && (
        <span className="cursor-blink" aria-hidden="true" />
      )}
    </div>
  )
}

/** A single output line — success (✓) or info (→). */
function TerminalOutputLine({ text }: { text: string }) {
  const isSuccess = text.startsWith('✓')
  const isArrow = text.startsWith('→')

  const color = isSuccess
    ? 'var(--brand-green)'
    : isArrow
      ? 'var(--warm-gray)'
      : 'var(--warm-gray-light)'

  return (
    <motion.div
      initial={{ opacity: 0, x: -4 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className="font-mono leading-relaxed pl-4"
      style={{ color }}
    >
      {text}
    </motion.div>
  )
}

/** The pulsing CTA button that appears after the sequence completes. */
function CtaButton({ text, href }: { text: string; href: string }) {
  return (
    <motion.div
      variants={REVEAL}
      initial="hidden"
      animate="visible"
      className="flex justify-center"
    >
      <Link
        href={href}
        className="marketing-btn inline-flex items-center gap-2 text-cream-white focus-ring"
        style={{ backgroundColor: 'var(--brand-orange)' }}
        target="_blank"
        rel="noopener noreferrer"
      >
        {text}
        <motion.span
          animate={{ x: [0, 4, 0] }}
          transition={{ repeat: Infinity, duration: 1.6, ease: 'easeInOut' }}
          aria-hidden="true"
        >
          →
        </motion.span>
      </Link>
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// Typing hook
// ---------------------------------------------------------------------------

/**
 * Drives the typewriter sequence using a `setTimeout` chain.
 * Returns all state needed to render the terminal.
 */
function useTypewriterSequence(headline: string) {
  const [typedHeadline, setTypedHeadline] = useState('')
  const [headlineDone, setHeadlineDone] = useState(false)
  const [terminalVisible, setTerminalVisible] = useState(false)
  const [commandTexts, setCommandTexts] = useState<string[]>(['', '', ''])
  const [commandsDone, setCommandsDone] = useState<boolean[]>([false, false, false])
  const [visibleOutputs, setVisibleOutputs] = useState<boolean[][]>([[], [], []])
  const [ctaVisible, setCtaVisible] = useState(false)

  // Track whether the component is still mounted to prevent stale closures
  // from firing after unmount.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const schedule = useCallback((fn: () => void, delay: number) => {
    const id = setTimeout(() => {
      if (mountedRef.current) fn()
    }, delay)
    return id
  }, [])

  /**
   * Types a string character by character, calling `onChar` after each
   * character and `onDone` when complete. Returns accumulated delay (ms).
   */
  const typeString = useCallback(
    (
      str: string,
      startDelay: number,
      onChar: (partial: string) => void,
      onDone: () => void,
    ): number => {
      let elapsed = startDelay

      for (let i = 0; i < str.length; i++) {
        const partial = str.slice(0, i + 1)
        const jitter = Math.random() * CHAR_DELAY_JITTER
        elapsed += CHAR_DELAY_BASE + jitter

        // Capture `partial` in closure
        const capturedPartial = partial
        schedule(() => onChar(capturedPartial), elapsed)
      }

      schedule(onDone, elapsed + 16)
      return elapsed + 16
    },
    [schedule],
  )

  useEffect(() => {
    let cursor = 0

    // Step 1 — type the headline
    cursor = typeString(
      headline,
      0,
      (p) => setTypedHeadline(p),
      () => setHeadlineDone(true),
    )

    // Step 2 — brief pause, then reveal terminal
    cursor += 500
    schedule(() => setTerminalVisible(true), cursor)

    // Step 3 — type each terminal command, then its outputs
    let lineDelay = cursor + 300

    TERMINAL_LINES.forEach((line, lineIndex) => {
      // Type the command
      const afterCommand = typeString(
        line.prompt,
        lineDelay,
        (p) =>
          setCommandTexts((prev) => {
            const next = [...prev]
            next[lineIndex] = p
            return next
          }),
        () =>
          setCommandsDone((prev) => {
            const next = [...prev]
            next[lineIndex] = true
            return next
          }),
      )

      // After command is done, reveal each output line in sequence
      let outputDelay = afterCommand + POST_COMMAND_DELAY

      line.outputs.forEach((_, outputIndex) => {
        outputDelay += OUTPUT_LINE_DELAY
        const capturedOutputDelay = outputDelay
        const capturedOutputIndex = outputIndex

        schedule(() => {
          setVisibleOutputs((prev) => {
            const next = prev.map((row) => [...row]) as boolean[][]
            next[lineIndex][capturedOutputIndex] = true
            return next
          })
        }, capturedOutputDelay)
      })

      // Next command starts after all outputs + inter-step gap
      lineDelay = outputDelay + INTER_STEP_DELAY
    })

    // Step 4 — CTA pulses in after everything
    schedule(() => setCtaVisible(true), lineDelay + 600)

    // `headline` is a static prop; `typeString` and `schedule` are stable (useCallback).
    // mountedRef guards against stale setState calls after unmount.
  }, [headline, typeString, schedule])

  return {
    typedHeadline,
    headlineDone,
    terminalVisible,
    commandTexts,
    commandsDone,
    visibleOutputs,
    ctaVisible,
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Hero variant 4 — Typewriter Command Flow.
 *
 * The headline types out dramatically, then a cream-palette terminal walks
 * through the DorkOS install → run → work sequence. The CTA pulses in as the
 * natural conclusion of watching the workflow unfold.
 */
export function HeroV4({ headline, subhead, ctaText, ctaHref }: HeroProps) {
  const {
    typedHeadline,
    headlineDone,
    terminalVisible,
    commandTexts,
    commandsDone,
    visibleOutputs,
    ctaVisible,
  } = useTypewriterSequence(headline)

  // Determine which line is actively being typed (shows cursor on prompt)
  const activeLineIndex = commandsDone.findLastIndex((done) => !done)

  return (
    <section
      className="relative min-h-[85vh] flex flex-col items-center justify-center px-6 py-20"
      style={{ backgroundColor: 'var(--cream-primary)' }}
    >
      {/* Subtle graph-paper grid in background */}
      <div
        aria-hidden="true"
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: `
            linear-gradient(to right, rgba(139, 90, 43, 0.06) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(139, 90, 43, 0.06) 1px, transparent 1px)
          `,
          backgroundSize: '24px 24px',
          maskImage:
            'linear-gradient(to bottom, transparent 0%, black 20%, black 80%, transparent 100%)',
          WebkitMaskImage:
            'linear-gradient(to bottom, transparent 0%, black 20%, black 80%, transparent 100%)',
        }}
      />

      {/* Content column */}
      <div className="relative z-10 w-full max-w-[600px] mx-auto flex flex-col items-center gap-10">

        {/* ------------------------------------------------------------------ */}
        {/* Headline — types out character by character                         */}
        {/* ------------------------------------------------------------------ */}
        <div className="text-center w-full">
          <h1
            className="font-bold tracking-[-0.04em] leading-[1.05] overflow-visible"
            style={{
              fontSize: 'clamp(40px, 7vw, 80px)',
              color: 'var(--charcoal)',
              minHeight: '1.05em',
            }}
          >
            <span>{typedHeadline}</span>
            {/* Blink cursor only while headline is typing; hide once done */}
            {!headlineDone && (
              <span className="cursor-blink" aria-hidden="true" />
            )}
          </h1>

          {/* Subhead fades in once headline finishes */}
          <AnimatePresence>
            {headlineDone && (
              <motion.p
                key="subhead"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, ease: 'easeOut', delay: 0.1 }}
                className="mt-4 text-base md:text-lg font-light leading-[1.7] max-w-[480px] mx-auto"
                style={{ color: 'var(--warm-gray)' }}
              >
                {subhead}
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        {/* ------------------------------------------------------------------ */}
        {/* Terminal window                                                     */}
        {/* ------------------------------------------------------------------ */}
        <AnimatePresence>
          {terminalVisible && (
            <motion.div
              key="terminal"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: 'easeOut' }}
              className="w-full rounded-xl border overflow-hidden shadow-elevated"
              style={{
                borderColor: 'var(--border-warm)',
                backgroundColor: 'var(--cream-white)',
              }}
            >
              {/* Window chrome — three dots */}
              <div
                className="flex items-center gap-1.5 px-4 py-3 border-b"
                style={{
                  borderColor: 'var(--border-warm)',
                  backgroundColor: 'var(--cream-secondary)',
                }}
              >
                <span
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: 'rgba(139,90,43,0.25)' }}
                />
                <span
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: 'rgba(139,90,43,0.15)' }}
                />
                <span
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: 'rgba(139,90,43,0.10)' }}
                />
                <span
                  className="ml-3 font-mono text-[10px] tracking-wide"
                  style={{ color: 'var(--warm-gray-light)' }}
                >
                  dorkos — bash
                </span>
              </div>

              {/* Terminal body */}
              <div className="p-5 space-y-3 font-mono text-[13px] md:text-[14px]">
                {TERMINAL_LINES.map((line, lineIndex) => {
                  const cmdText = commandTexts[lineIndex]
                  const cmdDone = commandsDone[lineIndex]
                  const lineOutputs = visibleOutputs[lineIndex] ?? []

                  // Render this line only once its text has started appearing.
                  if (!cmdText) return null

                  return (
                    <div key={lineIndex} className="space-y-1.5">
                      {/* Prompt line */}
                      {cmdText && (
                        <TerminalPrompt
                          text={cmdText}
                          showCursor={
                            !cmdDone &&
                            (activeLineIndex === lineIndex ||
                              activeLineIndex === -1)
                          }
                        />
                      )}

                      {/* Output lines */}
                      {line.outputs.map((outputText, outputIndex) =>
                        lineOutputs[outputIndex] ? (
                          <TerminalOutputLine
                            key={outputIndex}
                            text={outputText}
                          />
                        ) : null,
                      )}
                    </div>
                  )
                })}

                {/* Idle cursor after everything is done */}
                {commandsDone.every(Boolean) && (
                  <div className="flex items-center">
                    <span style={{ color: 'var(--brand-orange)' }}>$</span>
                    <span className="cursor-blink ml-1" aria-hidden="true" />
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ------------------------------------------------------------------ */}
        {/* CTA                                                                 */}
        {/* ------------------------------------------------------------------ */}
        <AnimatePresence>
          {ctaVisible && (
            <CtaButton text={ctaText} href={ctaHref} />
          )}
        </AnimatePresence>
      </div>
    </section>
  )
}
