'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { motion } from 'motion/react'
import { REVEAL, STAGGER } from '@/layers/features/marketing/lib/motion-variants'

// ─── Types ────────────────────────────────────────────────────────────────────

interface HeroProps {
  headline: string
  subhead: string
  ctaText: string
  ctaHref: string
}

type ModuleId = 'core' | 'pulse' | 'wing' | 'mesh' | 'channels' | 'agent'

interface FeedEntry {
  /** Unique key for AnimatePresence — never reused. */
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
  core: '#E85D04',
  pulse: '#F07D2A',
  wing: '#228B22',
  mesh: '#4A90A4',
  channels: '#8B7BA4',
  agent: '#7A756A',
}

/** Module label for the badge. */
const MODULE_LABELS: Record<ModuleId, string> = {
  core: 'Core',
  pulse: 'Pulse',
  wing: 'Wing',
  mesh: 'Mesh',
  channels: 'Channels',
  agent: 'Agent',
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
  { module: 'channels', text: 'Channels sent deployment notification to Slack' },
  { module: 'agent', text: 'Agent drafted Q2 investor update — ready for review' },
  { module: 'channels', text: 'Channels replied to 6 support emails with context from Wing' },
  { module: 'agent', text: 'Agent found $2,400/yr in unused AWS resources — PR open to delete' },
  { module: 'wing', text: 'Wing compiled competitive analysis from 14 sources' },
  { module: 'pulse', text: 'Pulse generated monthly revenue report — MRR up 23%' },
  // Life automation
  { module: 'channels', text: 'Channels ordered anniversary flowers — delivery confirmed for Friday' },
  { module: 'agent', text: 'Agent booked dentist appointment for Thursday 2pm' },
  { module: 'channels', text: 'Channels negotiated internet bill down $40/mo — new rate locked in' },
  { module: 'wing', text: 'Wing organized 2,847 photos by date, location, and who\u2019s in them' },
  { module: 'agent', text: 'Agent meal-prepped grocery list for the week — ordered via Instacart' },
  { module: 'pulse', text: 'Pulse filed your quarterly taxes 3 days before the deadline' },
  // Ambitious / funny
  { module: 'mesh', text: 'Mesh assembled 7 agents for Operation Birthday Surprise' },
  { module: 'agent', text: 'Agent wrote a passive income bot — estimated $300/mo on autopilot' },
  { module: 'pulse', text: 'Pulse started next iteration cycle' },
  { module: 'channels', text: 'Channels sent "thinking of you" text to mom — she loved it' },
  { module: 'wing', text: 'Wing has your full context — ask me anything' },
  { module: 'mesh', text: 'Mesh coordinating world domination — ETA 47 minutes' },
  { module: 'agent', text: 'Agent applied to 30 jobs on your behalf — 4 interviews booked' },
  { module: 'pulse', text: 'Pulse optimized your portfolio — up 12% since last rebalance' },
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

  // Build the initial snapshot — start mid-pool so the first "live" entry
  // picks up naturally from where the snapshot left off.
  const [entries, setEntries] = useState<FeedEntry[]>(() => {
    const snapshot: FeedEntry[] = []
    // Show the last MAX_VISIBLE entries from the pool as the "already happened" state
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
    // Next live entry continues from here
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
        // Prepend new entry and trim to MAX_VISIBLE
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
  // Items deeper in the list fade out gradually — creates the "scrolling log" feel
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
        // Layout: smooth slide-down for existing items being pushed
        layout: { type: 'spring', stiffness: 400, damping: 35, mass: 0.8 },
        // Enter: quick fade + slide from top
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
          {/* Live indicator */}
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
        {/* Top fade mask */}
        <div
          className="absolute top-0 left-0 right-0 z-10 pointer-events-none"
          style={{
            height: '48px',
            background: 'linear-gradient(to bottom, #FFFEFB 0%, transparent 100%)',
          }}
        />
        {/* Bottom fade mask */}
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

// ─── StatBadge ────────────────────────────────────────────────────────────────

function StatBadge({ value, label }: { value: string; label: string }) {
  return (
    <div
      className="flex flex-col items-start px-3 py-2 rounded-[6px]"
      style={{
        background: 'rgba(232, 93, 4, 0.06)',
        border: '1px solid rgba(232, 93, 4, 0.15)',
      }}
    >
      <span
        className="font-mono text-lg font-bold leading-none tracking-[-0.03em]"
        style={{ color: '#E85D04' }}
      >
        {value}
      </span>
      <span
        className="font-mono text-[9px] tracking-[0.08em] uppercase mt-0.5"
        style={{ color: '#7A756A' }}
      >
        {label}
      </span>
    </div>
  )
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * HeroV9 — Activity Feed hero.
 *
 * Split-panel layout: headline + CTA on the left, a live-updating agent
 * activity feed on the right. New entries slide in from the bottom every
 * 2.4 seconds, creating FOMO by surfacing the autonomous work agents do
 * while a user is simply reading the page.
 */
export function HeroV9({ headline, subhead, ctaText, ctaHref }: HeroProps) {
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

        {/* Main layout — left prose + right feed */}
        <div className="flex flex-col lg:flex-row gap-10 lg:gap-16 items-start">

          {/* ── Left column ── */}
          <div className="flex-[0_0_55%] max-w-[55%] max-lg:max-w-full flex flex-col gap-8">

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

            {/* Stats row */}
            <motion.div
              variants={REVEAL}
              className="flex flex-wrap gap-3"
            >
              <StatBadge value="10x" label="Agent throughput" />
              <StatBadge value="24/7" label="Autonomous ops" />
              <StatBadge value="∞" label="Parallel tasks" />
            </motion.div>

            {/* CTA group */}
            <motion.div
              variants={REVEAL}
              className="flex flex-col sm:flex-row items-start sm:items-center gap-5 pt-2"
            >
              {/* Primary CTA */}
              <Link
                href={ctaHref}
                target="_blank"
                rel="noopener noreferrer"
                className="marketing-btn inline-flex items-center gap-2"
                style={{
                  background: '#E85D04',
                  color: '#FFFEFB',
                }}
              >
                {ctaText}
                <span className="cursor-blink" aria-hidden="true" />
              </Link>

              {/* Secondary CTA */}
              <Link
                href="/docs/getting-started/quickstart"
                className="inline-flex items-center gap-1.5 font-mono text-button tracking-[0.08em] text-warm-gray-light hover:text-brand-orange transition-smooth"
              >
                Read the docs
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M2.5 6h7M6.5 3l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </Link>
            </motion.div>

            {/* Social proof */}
            <motion.p
              variants={REVEAL}
              className="font-mono text-2xs tracking-[0.06em]"
              style={{ color: '#7A756A' }}
            >
              npm install -g dorkos &mdash; free to start, no card required
            </motion.p>
          </div>

          {/* ── Right column — Activity feed ── */}
          <motion.div
            className="flex-[0_0_45%] max-w-[45%] max-lg:max-w-full w-full"
            initial={{ opacity: 0, x: 32 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.55, delay: 0.25, ease: [0.22, 1, 0.36, 1] }}
          >
            {/* Feed label */}
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

            {/* Attribution beneath feed */}
            <p
              className="font-mono text-[10px] tracking-[0.04em] text-center mt-3 leading-[1.6]"
              style={{ color: '#7A756A' }}
            >
              Simulated. Real agents log every action, in real time.
            </p>
          </motion.div>
        </div>
      </motion.div>
    </section>
  )
}
