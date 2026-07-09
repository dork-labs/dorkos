'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';
import { REVEAL, STAGGER } from '../lib/motion-variants';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ActivityFeedHeroProps {
  ctaText: string;
  ctaHref: string;
  /** GitHub repo URL — used as secondary mobile CTA. */
  githubHref?: string;
}

type ModuleId = 'engine' | 'tasks' | 'mesh' | 'relay' | 'agent';

interface FeedEntry {
  /** Unique key — never reused. */
  id: number;
  module: ModuleId;
  text: string;
  /** Seconds elapsed since this action occurred (display only). */
  secondsAgo: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** How many entries are visible in the feed at one time. */
const MAX_VISIBLE = 6;

/** Interval between new entries appearing, in ms. */
const FEED_INTERVAL_MS = 5500;

/** Module dot colors matching brand palette. */
const MODULE_COLORS: Record<ModuleId, string> = {
  engine: '#E85D04',
  tasks: '#CF722B',
  mesh: '#4A90A4',
  relay: '#8B7BA4',
  agent: '#7A756A',
};

/** Module label for the badge. */
const MODULE_LABELS: Record<ModuleId, string> = {
  engine: 'Engine',
  tasks: 'Tasks',
  mesh: 'Mesh',
  relay: 'Relay',
  agent: 'Agent',
};

/** The full activity pool — cycled through in order, looping back. */
const ACTIVITY_POOL: Array<Omit<FeedEntry, 'id' | 'secondsAgo'>> = [
  // Coding & DevOps
  { module: 'agent', text: 'Agent committed 3 files to feature/auth-flow' },
  { module: 'tasks', text: 'Tasks finished task 4 of 12 on your to-do list' },
  { module: 'agent', text: 'Agent reviewed code change #47 \u2014 approved with suggestions' },
  { module: 'mesh', text: 'Mesh routed the failing build to the agent that owns it' },
  { module: 'agent', text: 'Agent deployed v2.1.3 to staging' },
  { module: 'mesh', text: 'Mesh got 3 agents working together on billing cleanup' },
  { module: 'agent', text: 'Agent wrote 14 tests \u2014 all passing' },
  { module: 'agent', text: 'Agent resolved 2 merge conflicts automatically' },
  {
    module: 'agent',
    text: 'Agent cleaned up the login code \u2014 removed 340 lines of dead code',
  },
  { module: 'tasks', text: 'Tasks sorted through 12 GitHub issues while you were asleep' },
  // Business & money
  { module: 'relay', text: 'Sent you a Telegram: \u201CDeploy finished, all good.\u201D' },
  { module: 'agent', text: 'Agent drafted Q2 investor update \u2014 ready for review' },
  { module: 'relay', text: 'Received a webhook from GitHub \u2014 routed to the right agent' },
  { module: 'agent', text: 'Agent found $2,400/yr in unused AWS resources \u2014 cleanup ready' },
  { module: 'agent', text: 'Agent pulled together a competitive analysis from 14 sources' },
  { module: 'tasks', text: 'Tasks generated your monthly revenue report \u2014 MRR up 23%' },
  // Life automation
  { module: 'relay', text: 'Sent your support team a reply via Telegram' },
  { module: 'agent', text: 'Agent booked dentist appointment for Thursday 2pm' },
  { module: 'relay', text: 'Sent you a Telegram: \u201COrder confirmed.\u201D' },
  {
    module: 'agent',
    text: 'Agent organized 2,847 photos by date, location, and who\u2019s in them',
  },
  {
    module: 'agent',
    text: 'Agent meal-prepped grocery list for the week \u2014 ordered via Instacart',
  },
  { module: 'tasks', text: 'Tasks filed your quarterly taxes 3 days before the deadline' },
  // Coordination & connectivity
  { module: 'mesh', text: 'Mesh assembled 7 agents for Operation Birthday Surprise' },
  { module: 'tasks', text: 'Tasks kicked off the next round of tasks' },
  { module: 'relay', text: 'Telegram adapter connected \u2014 listening for messages' },
  { module: 'mesh', text: 'Mesh registered a new agent \u2014 8 now online' },
  // Follow-through
  { module: 'agent', text: 'Agent spotted 8 things worth checking \u2014 3 look promising' },
  { module: 'agent', text: 'Agent tested a fix \u2014 conversion up 2.1%' },
  { module: 'tasks', text: 'Tasks queued the next priority run for tonight' },
];

/** Seconds-ago values used for the initial snapshot display. */
const INITIAL_SECONDS = [31, 28, 25, 22, 18, 15];

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
  const counterRef = useRef(MAX_VISIBLE);
  const poolIndexRef = useRef(0);

  const [entries, setEntries] = useState<FeedEntry[]>(() => {
    const snapshot: FeedEntry[] = [];
    const startIndex = ACTIVITY_POOL.length - MAX_VISIBLE;
    for (let i = 0; i < MAX_VISIBLE; i++) {
      const poolItem = ACTIVITY_POOL[(startIndex + i) % ACTIVITY_POOL.length];
      snapshot.push({
        id: i, // sequential 0..MAX_VISIBLE-1; counterRef continues from MAX_VISIBLE
        module: poolItem.module,
        text: poolItem.text,
        secondsAgo: INITIAL_SECONDS[MAX_VISIBLE - 1 - i] ?? (i + 1) * 5,
      });
    }
    return snapshot;
  });

  useEffect(() => {
    const interval = setInterval(() => {
      const poolItem = ACTIVITY_POOL[poolIndexRef.current % ACTIVITY_POOL.length];
      poolIndexRef.current++;

      setEntries((prev) => {
        const newEntry: FeedEntry = {
          id: counterRef.current++,
          module: poolItem.module,
          text: poolItem.text,
          secondsAgo: 0,
        };
        return [newEntry, ...prev].slice(0, MAX_VISIBLE);
      });
    }, FEED_INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);

  return entries;
}

// ─── FeedDot ──────────────────────────────────────────────────────────────────

function FeedDot({ module }: { module: ModuleId }) {
  const color = MODULE_COLORS[module];
  return (
    <span
      className="mt-0.5 inline-flex h-2 w-2 shrink-0 rounded-full"
      style={{ background: color }}
      aria-hidden="true"
    />
  );
}

// ─── FeedBadge ────────────────────────────────────────────────────────────────

function FeedBadge({ module }: { module: ModuleId }) {
  const color = MODULE_COLORS[module];
  return (
    <span
      className="shrink-0 rounded-[3px] px-1.5 py-0.5 font-mono text-[9px] leading-none tracking-[0.1em] uppercase"
      style={{
        background: `${color}18`,
        color,
        border: `1px solid ${color}30`,
      }}
    >
      {MODULE_LABELS[module]}
    </span>
  );
}

// ─── FeedItem ─────────────────────────────────────────────────────────────────

function FeedItem({ entry, index }: { entry: FeedEntry; index: number }) {
  const targetOpacity = index === 0 ? 1 : Math.max(0.3, 1 - index * 0.13);

  const timestamp = entry.secondsAgo === 0 ? 'just now' : `${entry.secondsAgo}s ago`;

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
      className="flex items-start gap-2.5 rounded-[6px] px-3 py-2.5"
      style={{
        background: index === 0 ? 'rgba(232, 93, 4, 0.04)' : 'transparent',
        borderLeft: index === 0 ? '2px solid rgba(232, 93, 4, 0.25)' : '2px solid transparent',
      }}
    >
      <FeedDot module={entry.module} />

      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'relative -top-1 text-left font-mono text-sm',
            index === 0 ? 'text-[#1A1814]' : 'text-[#4A4640]'
          )}
        >
          {entry.text}
        </p>
        <div className="mt-1 flex items-center gap-2">
          <FeedBadge module={entry.module} />
          <span className="font-mono text-[9px] tracking-[0.06em]" style={{ color: '#7A756A' }}>
            {timestamp}
          </span>
        </div>
      </div>
    </motion.div>
  );
}

// ─── ActivityFeedPanel ────────────────────────────────────────────────────────

function ActivityFeedPanel() {
  const entries = useActivityFeed();

  return (
    <div
      className="shadow-floating flex flex-col overflow-hidden rounded-lg"
      style={{
        background: '#FFFEFB',
        border: '1px solid rgba(139, 90, 43, 0.12)',
      }}
    >
      {/* Panel header */}
      <div
        className="flex shrink-0 items-center justify-between px-4 py-3"
        style={{
          background: '#F5F0E6',
          borderBottom: '1px solid rgba(139, 90, 43, 0.1)',
        }}
      >
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span
              className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
              style={{ background: '#228B22' }}
            />
            <span
              className="relative inline-flex h-2 w-2 rounded-full"
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
          className="rounded-[3px] px-2 py-0.5 font-mono text-[9px] tracking-[0.08em] uppercase"
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
          className="pointer-events-none absolute top-0 right-0 left-0 z-10"
          style={{
            height: '20px',
            background: 'linear-gradient(to bottom, #FFFEFB 0%, transparent 100%)',
          }}
        />
        <div
          className="pointer-events-none absolute right-0 bottom-0 left-0 z-10"
          style={{
            height: '32px',
            background: 'linear-gradient(to top, #FFFEFB 0%, transparent 100%)',
          }}
        />

        {/* Feed area — fixed height prevents layout shift */}
        <div className="space-y-3 px-2 py-3" style={{ height: 370, overflow: 'hidden' }}>
          {entries.map((entry, index) => (
            <FeedItem key={entry.id} entry={entry} index={index} />
          ))}
        </div>
      </div>

      {/* Panel footer */}
      <div
        className="shrink-0 px-4 py-2.5"
        style={{
          borderTop: '1px solid rgba(139, 90, 43, 0.08)',
          background: '#F5F0E6',
        }}
      >
        <p
          className="text-center font-mono text-[9px] tracking-[0.06em]"
          style={{ color: '#7A756A' }}
        >
          This is your fleet, reporting back.
        </p>
      </div>
    </div>
  );
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
    <section className="bg-cream-primary film-grain relative flex min-h-0 flex-col items-center justify-center overflow-hidden px-6 pt-28 pb-16 md:min-h-[85vh]">
      {/* Subtle graph-paper background */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: `
            linear-gradient(to right, rgba(139, 90, 43, 0.05) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(139, 90, 43, 0.05) 1px, transparent 1px)
          `,
          backgroundSize: '32px 32px',
          maskImage:
            'linear-gradient(to bottom, transparent 0%, black 15%, black 85%, transparent 100%)',
          WebkitMaskImage:
            'linear-gradient(to bottom, transparent 0%, black 15%, black 85%, transparent 100%)',
        }}
      />

      {/* Content wrapper */}
      <motion.div
        className="relative z-10 mx-auto w-full max-w-6xl text-center"
        initial="hidden"
        animate="visible"
        variants={STAGGER}
      >
        {/* Headline — full width */}
        <motion.div variants={REVEAL} className="mb-6">
          <h1
            className="text-charcoal font-bold tracking-[-0.04em] text-balance"
            style={{ fontSize: 'clamp(40px, 7vw, 84px)', lineHeight: 1.02 }}
          >
            You, multiplied.
          </h1>
        </motion.div>

        {/* Tagline */}
        <motion.div variants={REVEAL} className="mb-12">
          <p className="text-charcoal mx-auto max-w-2xl text-lg font-medium tracking-[-0.01em] text-balance md:text-xl">
            Every coding agent you run &mdash; Claude Code, Codex, OpenCode &mdash; in one cockpit.
            Your fleet, scheduled, connected, and reporting back to you.
          </p>
          <p className="text-warm-gray mx-auto mt-4 max-w-2xl text-base text-balance md:text-lg">
            You&apos;ve always had more ideas than hours. That ratio just changed.
          </p>
        </motion.div>

        {/* Activity feed — full width, subordinate */}
        <motion.div
          className="mx-auto mb-10 w-full max-w-lg"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.25, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="mb-3 flex items-center gap-2">
            <span
              className="text-2xs font-mono tracking-[0.12em] uppercase"
              style={{ color: '#7A756A' }}
            >
              Right now, somewhere
            </span>
            <div className="h-px flex-1" style={{ background: 'rgba(139,90,43,0.15)' }} />
          </div>

          <ActivityFeedPanel />

          <p
            className="mt-3 text-center font-mono text-[10px] leading-[1.6] tracking-[0.04em]"
            style={{ color: '#7A756A' }}
          >
            Simulated. Real agents log every action, in real time.
          </p>
        </motion.div>

        {/* CTA group */}
        <motion.div
          variants={REVEAL}
          className="flex flex-col items-center justify-center gap-5 sm:flex-row"
        >
          <a
            href={ctaHref}
            className="marketing-btn inline-flex items-center gap-2"
            style={{ background: '#E85D04', color: '#FFFEFB' }}
          >
            {ctaText}
          </a>

          {/* Desktop: docs as secondary */}
          <Link
            href="/docs/getting-started/quickstart"
            className="text-button text-warm-gray-light hover:text-brand-orange transition-smooth hidden items-center gap-1.5 font-mono tracking-[0.08em] lg:inline-flex"
          >
            Read the docs
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path
                d="M2.5 6h7M6.5 3l3 3-3 3"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>

          {/* Mobile: GitHub as secondary */}
          {githubHref && (
            <Link
              href={githubHref}
              target="_blank"
              rel="noopener noreferrer"
              className="text-button text-warm-gray-light hover:text-brand-orange transition-smooth inline-flex items-center gap-1.5 font-mono tracking-[0.08em] lg:hidden"
            >
              View on GitHub
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path
                  d="M2.5 6h7M6.5 3l3 3-3 3"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Link>
          )}
        </motion.div>
      </motion.div>
    </section>
  );
}
