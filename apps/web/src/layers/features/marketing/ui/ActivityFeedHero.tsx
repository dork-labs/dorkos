'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { motion } from 'motion/react'
import { REVEAL, STAGGER } from '../lib/motion-variants'
import { ConsoleMockup } from './ConsoleMockup'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ActivityFeedHeroProps {
  ctaText: string
  ctaHref: string
  /** GitHub repo URL — used as secondary mobile CTA. */
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
  { module: 'pulse', text: 'Pulse finished task 4 of 12 on your to-do list' },
  { module: 'agent', text: 'Agent reviewed code change #47 \u2014 approved with suggestions' },
  { module: 'wing', text: 'Wing saved your latest project notes for next time' },
  { module: 'agent', text: 'Agent deployed v2.1.3 to staging' },
  { module: 'mesh', text: 'Mesh got 3 agents working together on billing cleanup' },
  { module: 'agent', text: 'Agent wrote 14 tests \u2014 all passing' },
  { module: 'agent', text: 'Agent resolved 2 merge conflicts automatically' },
  { module: 'agent', text: 'Agent cleaned up the login code \u2014 removed 340 lines of dead code' },
  { module: 'pulse', text: 'Pulse sorted through 12 GitHub issues while you were asleep' },
  // Business & money
  { module: 'relay', text: 'Sent you a Telegram: \u201CDeploy finished, all good.\u201D' },
  { module: 'agent', text: 'Agent drafted Q2 investor update \u2014 ready for review' },
  { module: 'relay', text: 'Received a webhook from GitHub \u2014 routed to the right agent' },
  { module: 'agent', text: 'Agent found $2,400/yr in unused AWS resources \u2014 cleanup ready' },
  { module: 'wing', text: 'Wing pulled together a competitive analysis from 14 sources' },
  { module: 'pulse', text: 'Pulse generated your monthly revenue report \u2014 MRR up 23%' },
  // Life automation
  { module: 'relay', text: 'Sent your support team a reply via Telegram' },
  { module: 'agent', text: 'Agent booked dentist appointment for Thursday 2pm' },
  { module: 'relay', text: 'Sent you a Telegram: \u201COrder confirmed.\u201D' },
  { module: 'wing', text: 'Wing organized 2,847 photos by date, location, and who\u2019s in them' },
  { module: 'agent', text: 'Agent meal-prepped grocery list for the week \u2014 ordered via Instacart' },
  { module: 'pulse', text: 'Pulse filed your quarterly taxes 3 days before the deadline' },
  // Coordination & connectivity
  { module: 'mesh', text: 'Mesh assembled 7 agents for Operation Birthday Surprise' },
  { module: 'pulse', text: 'Pulse kicked off the next round of tasks' },
  { module: 'relay', text: 'Telegram adapter connected \u2014 listening for messages' },
  { module: 'wing', text: 'Wing has your full context \u2014 ask me anything' },
  // Improvement loop
  { module: 'loop', text: 'Loop spotted 8 things worth checking \u2014 3 look promising' },
  { module: 'loop', text: 'Loop tested a fix \u2014 conversion up 2.1%' },
  { module: 'loop', text: 'Loop queued the next priority task for Pulse' },
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
  // Start at MAX_VISIBLE so new entries get unique ids after the initial 0..MAX_VISIBLE-1
  const counterRef = useRef(MAX_VISIBLE)
  const poolIndexRef = useRef(0)

  const [entries, setEntries] = useState<FeedEntry[]>(() => {
    const snapshot: FeedEntry[] = []
    const startIndex = ACTIVITY_POOL.length - MAX_VISIBLE
    for (let i = 0; i < MAX_VISIBLE; i++) {
      const poolItem = ACTIVITY_POOL[(startIndex + i) % ACTIVITY_POOL.length]
      snapshot.push({
        id: i, // sequential 0..MAX_VISIBLE-1; counterRef continues from MAX_VISIBLE
        module: poolItem.module,
        text: poolItem.text,
        secondsAgo: INITIAL_SECONDS[MAX_VISIBLE - 1 - i] ?? (i + 1) * 5,
      })
    }
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
          This is what your morning looks like with DorkOS.
        </p>
      </div>
    </div>
  )
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Activity Feed hero — stacked layout with a live-updating agent feed.
 *
 * Full-width headline and tagline on top, a subordinate simulated
 * real-time activity feed in the center, and CTA buttons at the bottom.
 */
export function ActivityFeedHero({ ctaText, ctaHref, githubHref }: ActivityFeedHeroProps) {
  return (
    <section className="relative min-h-0 md:min-h-[85vh] bg-cream-primary flex flex-col items-center justify-center px-6 pt-28 pb-16 overflow-hidden film-grain">
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
        className="relative z-10 w-full max-w-6xl mx-auto text-center"
        initial="hidden"
        animate="visible"
        variants={STAGGER}
      >
        {/* Headline — full width */}
        <motion.div variants={REVEAL} className="mb-6">
          <h1
            className="font-bold text-charcoal tracking-[-0.04em] text-balance"
            style={{ fontSize: 'clamp(32px, 5.5vw, 64px)', lineHeight: 1.06 }}
          >
            Your agents are brilliant.
            <br />
            They just can&apos;t do anything when you leave.
          </h1>
        </motion.div>

        {/* Tagline */}
        <motion.p
          variants={REVEAL}
          className="text-charcoal font-medium text-lg md:text-xl tracking-[-0.01em] mb-12"
        >
          You slept. They shipped.
        </motion.p>

        {/* Activity feed — full width, subordinate */}
        <motion.div
          className="w-full max-w-lg mx-auto mb-10"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
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

        {/* CTA group */}
        <motion.div
          variants={REVEAL}
          className="flex flex-col sm:flex-row items-center justify-center gap-5"
        >
          {/* Desktop: npm install button */}
          <Link
            href={ctaHref}
            target="_blank"
            rel="noopener noreferrer"
            className="marketing-btn hidden lg:inline-flex items-center gap-2"
            style={{ background: '#E85D04', color: '#FFFEFB' }}
          >
            {ctaText}
            <span className="cursor-blink" aria-hidden="true" />
          </Link>

          {/* Mobile: docs as primary action */}
          <Link
            href="/docs/getting-started/quickstart"
            className="marketing-btn inline-flex lg:hidden items-center gap-2"
            style={{ background: '#E85D04', color: '#FFFEFB' }}
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
      </motion.div>
    </section>
  )
}
