'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { motion } from 'motion/react'
import { REVEAL, STAGGER } from '../lib/motion-variants'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ActivityFeedHeroProps {
  headline: string
  subhead: string
  ctaText: string
  ctaHref: string
  /** GitHub repo URL — used as primary mobile CTA. */
  githubHref?: string
}

type ModuleId = 'engine' | 'pulse' | 'wing' | 'mesh' | 'relay' | 'agent' | 'loop'

interface FeedEntry {
  /** Unique key — never reused. */
  id: number
  module: ModuleId
  text: string
  /** Seconds elapsed since this action occurred (display only). */
  secondsAgo: number
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** How many entries are visible in the feed at one time. */
const MAX_VISIBLE = 6

/** Interval between new entries appearing, in ms. */
const FEED_INTERVAL_MS = 2400

/** Module dot colors matching brand palette. */
const MODULE_COLORS: Record<ModuleId, string> = {
  engine: '#E85D04',
  pulse: '#CF722B',
  wing: '#228B22',
  mesh: '#4A90A4',
  relay: '#8B7BA4',
  agent: '#7A756A',
  loop: '#B8860B',
}

/** Module label for the badge. */
const MODULE_LABELS: Record<ModuleId, string> = {
  engine: 'Engine',
  pulse: 'Pulse',
  wing: 'Wing',
  mesh: 'Mesh',
  relay: 'Relay',
  agent: 'Agent',
  loop: 'Loop',
}

/** The full activity pool — cycled through in order, looping back. */
const ACTIVITY_POOL: Array<Omit<FeedEntry, 'id' | 'secondsAgo'>> = [
  // Coding & DevOps
  { module: 'agent', text: 'Agent committed 3 files to feature/auth-flow' },
  { module: 'pulse', text: 'Pulse executed roadmap step 4 of 12' },
  { module: 'agent', text: 'Agent reviewed PR #47 — approved with suggestions' },
  { module: 'wing', text: 'Wing updated your context with new project patterns' },
  { module: 'agent', text: 'Agent deployed v2.1.3 to staging' },
  { module: 'mesh', text: 'Mesh coordinated 3 agents on billing refactor' },
  { module: 'agent', text: 'Agent wrote 14 unit tests — all passing' },
  { module: 'agent', text: 'Agent resolved 2 merge conflicts automatically' },
  { module: 'agent', text: 'Agent refactored auth module — removed 340 lines of dead code' },
  { module: 'pulse', text: 'Pulse triaged 12 GitHub issues while you were asleep' },
  // Business & money
  { module: 'relay', text: 'Delivered deployment notification to relay.human.telegram.ops' },
  { module: 'agent', text: 'Agent drafted Q2 investor update — ready for review' },
  { module: 'relay', text: 'Processed inbound webhook from relay.webhook.github' },
  { module: 'agent', text: 'Agent found $2,400/yr in unused AWS resources — PR open to delete' },
  { module: 'wing', text: 'Wing compiled competitive analysis from 14 sources' },
  { module: 'pulse', text: 'Pulse generated monthly revenue report — MRR up 23%' },
  // Life automation
  { module: 'relay', text: 'Routed agent response to relay.human.telegram.group.support' },
  { module: 'agent', text: 'Agent booked dentist appointment for Thursday 2pm' },
  { module: 'relay', text: 'Sent order confirmation to relay.human.telegram.12345' },
  { module: 'wing', text: 'Wing organized 2,847 photos by date, location, and who\u2019s in them' },
  { module: 'agent', text: 'Agent meal-prepped grocery list for the week — ordered via Instacart' },
  { module: 'pulse', text: 'Pulse filed your quarterly taxes 3 days before the deadline' },
  // Ambitious / funny
  { module: 'mesh', text: 'Mesh assembled 7 agents for Operation Birthday Surprise' },
  { module: 'agent', text: 'Agent wrote a passive income bot — estimated $300/mo on autopilot' },
  { module: 'pulse', text: 'Pulse started next iteration cycle' },
  { module: 'relay', text: 'Adapter telegram-main connected — polling active' },
  { module: 'wing', text: 'Wing has your full context — ask me anything' },
  { module: 'mesh', text: 'Mesh coordinating world domination — ETA 47 minutes' },
  { module: 'agent', text: 'Agent applied to 30 jobs on your behalf — 4 interviews booked' },
  { module: 'pulse', text: 'Pulse optimized your portfolio — up 12% since last rebalance' },
  // Improvement loop
  { module: 'loop', text: 'Loop triaged 8 signals — 3 became hypotheses' },
  { module: 'loop', text: 'Loop validated hypothesis — conversion up 2.1% after fix' },
  { module: 'loop', text: 'Loop dispatched next priority task to Pulse' },
]

/** Seconds-ago values used for the initial snapshot display. */
const INITIAL_SECONDS = [31, 28, 25, 22, 18, 15]

// ─── useActivityFeed hook ─────────────────────────────────────────────────────

/**
 * Manages the live activity feed state.
 *
 * Starts with a static snapshot of recent activity and appends a new
 * entry every `FEED_INTERVAL_MS` milliseconds. Cycles through ACTIVITY_POOL
 * indefinitely. Only keeps the most recent MAX_VISIBLE entries.
 */
function useActivityFeed(): FeedEntry[] {
  const counterRef = useRef(0)
  const poolIndexRef = useRef(0)

  const [entries, setEntries] = useState<FeedEntry[]>(() => {
    const snapshot: FeedEntry[] = []
    const startIndex = ACTIVITY_POOL.length - MAX_VISIBLE
    for (let i = 0; i < MAX_VISIBLE; i++) {
      const poolItem = ACTIVITY_POOL[(startIndex + i) % ACTIVITY_POOL.length]
      snapshot.push({
        id: counterRef.current++,
        module: poolItem.module,
        text: poolItem.text,
        secondsAgo: INITIAL_SECONDS[MAX_VISIBLE - 1 - i] ?? (i + 1) * 5,
      })
    }
    poolIndexRef.current = 0
    return snapshot
  })

  useEffect(() => {
    const interval = setInterval(() => {
      const poolItem = ACTIVITY_POOL[poolIndexRef.current % ACTIVITY_POOL.length]
      poolIndexRef.current++

      setEntries((prev) => {
        const newEntry: FeedEntry = {
          id: counterRef.current++,
          module: poolItem.module,
          text: poolItem.text,
          secondsAgo: 0,
        }
        return [newEntry, ...prev].slice(0, MAX_VISIBLE)
      })
    }, FEED_INTERVAL_MS)

    return () => clearInterval(interval)
  }, [])

  return entries
}

// ─── FeedDot ──────────────────────────────────────────────────────────────────

function FeedDot({ module }: { module: ModuleId }) {
  const color = MODULE_COLORS[module]
  return (
    <span
      className="inline-flex w-2 h-2 rounded-full shrink-0 mt-0.5"
      style={{ background: color }}
      aria-hidden="true"
    />
  )
}

// ─── FeedBadge ────────────────────────────────────────────────────────────────

function FeedBadge({ module }: { module: ModuleId }) {
  const color = MODULE_COLORS[module]
  return (
    <span
      className="font-mono text-[9px] tracking-[0.1em] uppercase px-1.5 py-0.5 rounded-[3px] leading-none shrink-0"
      style={{
        background: `${color}18`,
        color,
        border: `1px solid ${color}30`,
      }}
    >
      {MODULE_LABELS[module]}
    </span>
  )
}

// ─── FeedItem ─────────────────────────────────────────────────────────────────

function FeedItem({ entry, index }: { entry: FeedEntry; index: number }) {
  const targetOpacity = index === 0 ? 1 : Math.max(0.3, 1 - index * 0.13)

  const timestamp =
    entry.secondsAgo === 0
      ? 'just now'
      : `${entry.secondsAgo}s ago`

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -50 }}
      animate={{ opacity: targetOpacity, y: 0 }}
      transition={{
        layout: { type: 'spring', stiffness: 400, damping: 35, mass: 0.8 },
        opacity: { duration: 0.25 },
        y: { type: 'spring', stiffness: 400, damping: 35, mass: 0.8 },
      }}
      className="flex items-start gap-2.5 px-3 py-2.5 rounded-[6px]"
      style={{
        background: index === 0
          ? 'rgba(232, 93, 4, 0.04)'
          : 'transparent',
        borderLeft: index === 0
          ? '2px solid rgba(232, 93, 4, 0.25)'
          : '2px solid transparent',
      }}
    >
      <FeedDot module={entry.module} />

      <div className="flex-1 min-w-0">
        <p
          className="font-mono text-[11px] leading-[1.5] text-charcoal"
          style={{ color: index === 0 ? '#1A1814' : '#4A4640' }}
        >
          {entry.text}
        </p>
        <div className="flex items-center gap-2 mt-1">
          <FeedBadge module={entry.module} />
          <span
            className="font-mono text-[9px] tracking-[0.06em]"
            style={{ color: '#7A756A' }}
          >
            {timestamp}
          </span>
        </div>
      </div>
    </motion.div>
  )
}

// ─── ActivityFeedPanel ────────────────────────────────────────────────────────

function ActivityFeedPanel() {
  const entries = useActivityFeed()

  return (
    <div
      className="rounded-lg overflow-hidden shadow-floating flex flex-col"
      style={{
        background: '#FFFEFB',
        border: '1px solid rgba(139, 90, 43, 0.12)',
      }}
    >
      {/* Panel header */}
      <div
        className="flex items-center justify-between px-4 py-3 shrink-0"
        style={{
          background: '#F5F0E6',
          borderBottom: '1px solid rgba(139, 90, 43, 0.1)',
        }}
      >
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span
              className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60"
              style={{ background: '#228B22' }}
            />
            <span
              className="relative inline-flex rounded-full h-2 w-2"
              style={{ background: '#228B22' }}
            />
          </span>
          <span
            className="font-mono text-[10px] tracking-[0.1em] uppercase"
            style={{ color: '#1A1814' }}
          >
            Agent Activity
          </span>
        </div>
        <span
          className="font-mono text-[9px] tracking-[0.08em] uppercase px-2 py-0.5 rounded-[3px]"
          style={{
            background: 'rgba(34, 139, 34, 0.1)',
            color: '#228B22',
            border: '1px solid rgba(34, 139, 34, 0.2)',
          }}
        >
          Live
        </span>
      </div>

      {/* Feed container with gradient mask */}
      <div className="relative flex-1 overflow-hidden">
        <div
          className="absolute top-0 left-0 right-0 z-10 pointer-events-none"
          style={{
            height: '48px',
            background: 'linear-gradient(to bottom, #FFFEFB 0%, transparent 100%)',
          }}
        />
        <div
          className="absolute bottom-0 left-0 right-0 z-10 pointer-events-none"
          style={{
            height: '32px',
            background: 'linear-gradient(to top, #FFFEFB 0%, transparent 100%)',
          }}
        />

        {/* Feed area — fixed height prevents layout shift */}
        <div className="px-2 py-3 space-y-0.5" style={{ height: 370, overflow: 'hidden' }}>
          {entries.map((entry, index) => (
            <FeedItem key={entry.id} entry={entry} index={index} />
          ))}
        </div>
      </div>

      {/* Panel footer */}
      <div
        className="px-4 py-2.5 shrink-0"
        style={{
          borderTop: '1px solid rgba(139, 90, 43, 0.08)',
          background: '#F5F0E6',
        }}
      >
        <p
          className="font-mono text-[9px] tracking-[0.06em] text-center"
          style={{ color: '#7A756A' }}
        >
          While you read this, your agents could be doing all of this.
        </p>
      </div>
    </div>
  )
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Activity Feed hero — split-panel layout with a live-updating agent feed.
 *
 * Headline and CTA on the left, a simulated real-time activity feed on
 * the right showing agents committing code, managing tasks, automating
 * life, and occasionally plotting world domination.
 */
export function ActivityFeedHero({ headline, subhead, ctaText, ctaHref, githubHref }: ActivityFeedHeroProps) {
  return (
    <section className="relative min-h-[85vh] bg-cream-primary flex flex-col items-center justify-center px-6 py-16 overflow-hidden">
      {/* Subtle graph-paper background */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: `
            linear-gradient(to right, rgba(139, 90, 43, 0.05) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(139, 90, 43, 0.05) 1px, transparent 1px)
          `,
          backgroundSize: '32px 32px',
          maskImage: 'linear-gradient(to bottom, transparent 0%, black 15%, black 85%, transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 15%, black 85%, transparent 100%)',
        }}
      />

      {/* Content wrapper */}
      <motion.div
        className="relative z-10 w-full max-w-6xl mx-auto"
        initial="hidden"
        animate="visible"
        variants={STAGGER}
      >
        {/* Eyebrow label */}
        <motion.div variants={REVEAL} className="mb-6">
          <p className="font-mono text-2xs tracking-[0.2em] uppercase text-brand-orange">
            Autonomous by default
          </p>
        </motion.div>

        {/*
          Grid layout — 3 logical sections, interleaved on mobile.
          Mobile (single column): prose → feed → CTA (natural document order).
          Desktop (2-col): left column = prose + CTA, right column = feed spanning both rows.
        */}
        <div className="grid grid-cols-1 lg:grid-cols-[55%_1fr] gap-y-8 lg:gap-x-16 items-start">

          {/* ── Prose (headline + subhead) ── */}
          <div className="flex flex-col gap-8">
            {/* Headline */}
            <motion.div variants={REVEAL}>
              <h1
                className="font-bold text-charcoal tracking-[-0.04em] text-balance"
                style={{ fontSize: 'clamp(32px, 5.5vw, 64px)', lineHeight: 1.06 }}
              >
                {headline}
              </h1>
            </motion.div>

            {/* Subhead */}
            <motion.p
              variants={REVEAL}
              className="text-warm-gray font-light leading-[1.75] max-w-[480px]"
              style={{ fontSize: 'clamp(15px, 1.5vw, 18px)' }}
            >
              {subhead}
            </motion.p>
          </div>

          {/* ── Activity feed — between prose and CTA on mobile, right column on desktop ── */}
          <motion.div
            className="w-full lg:row-span-2 lg:col-start-2 lg:row-start-1"
            initial={{ opacity: 0, x: 32 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.55, delay: 0.25, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="flex items-center gap-2 mb-3">
              <span
                className="font-mono text-2xs tracking-[0.12em] uppercase"
                style={{ color: '#7A756A' }}
              >
                Right now, somewhere
              </span>
              <div className="h-px flex-1" style={{ background: 'rgba(139,90,43,0.15)' }} />
            </div>

            <ActivityFeedPanel />

            <p
              className="font-mono text-[10px] tracking-[0.04em] text-center mt-3 leading-[1.6]"
              style={{ color: '#7A756A' }}
            >
              Simulated. Real agents log every action, in real time.
            </p>
          </motion.div>

          {/* ── CTA group — below feed on mobile, continues in left column on desktop ── */}
          <div className="flex flex-col gap-5">
            <motion.div
              variants={REVEAL}
              className="flex flex-col sm:flex-row items-start sm:items-center gap-5 pt-2"
            >
              {/* Desktop: npm install button */}
              <Link
                href={ctaHref}
                target="_blank"
                rel="noopener noreferrer"
                className="marketing-btn hidden lg:inline-flex items-center gap-2"
                style={{
                  background: '#E85D04',
                  color: '#FFFEFB',
                }}
              >
                {ctaText}
                <span className="cursor-blink" aria-hidden="true" />
              </Link>

              {/* Mobile: docs as primary action */}
              <Link
                href="/docs/getting-started/quickstart"
                className="marketing-btn inline-flex lg:hidden items-center gap-2"
                style={{
                  background: '#E85D04',
                  color: '#FFFEFB',
                }}
              >
                Get started
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M2.5 6h7M6.5 3l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </Link>

              {/* Desktop: docs as secondary */}
              <Link
                href="/docs/getting-started/quickstart"
                className="hidden lg:inline-flex items-center gap-1.5 font-mono text-button tracking-[0.08em] text-warm-gray-light hover:text-brand-orange transition-smooth"
              >
                Read the docs
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M2.5 6h7M6.5 3l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </Link>

              {/* Mobile: GitHub as secondary */}
              {githubHref && (
                <Link
                  href={githubHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex lg:hidden items-center gap-1.5 font-mono text-button tracking-[0.08em] text-warm-gray-light hover:text-brand-orange transition-smooth"
                >
                  View on GitHub
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M2.5 6h7M6.5 3l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </Link>
              )}
            </motion.div>

            {/* Install hint — desktop: actionable, mobile: informational */}
            <motion.p
              variants={REVEAL}
              className="font-mono text-2xs tracking-[0.06em]"
              style={{ color: '#7A756A' }}
            >
              <span className="hidden lg:inline">npm install -g dorkos &mdash; free to start, no card required</span>
              <span className="lg:hidden">Install on desktop: <code className="text-charcoal">npm install -g dorkos</code></span>
            </motion.p>
          </div>
        </div>
      </motion.div>
    </section>
  )
}
