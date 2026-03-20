'use client';

import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { motion } from 'motion/react';
import { REVEAL, STAGGER } from '@/layers/features/marketing/lib/motion-variants';

interface HeroProps {
  headline: string;
  subhead: string;
  ctaText: string;
  ctaHref: string;
}

// ─── Shared cell wrapper ──────────────────────────────────────────────────────

/**
 * Shared bento cell wrapper — cream background, warm border, spring lift on hover.
 */
function BentoCell({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      variants={REVEAL}
      whileHover={{ y: -2 }}
      transition={{ type: 'spring', stiffness: 300, damping: 25 }}
      className={`bg-cream-white overflow-hidden rounded-xl border border-[var(--border-warm)] ${className}`}
    >
      {children}
    </motion.div>
  );
}

// ─── Cell 1: Headline ─────────────────────────────────────────────────────────

function HeadlineCell({
  headline,
  subhead,
  ctaHref,
}: Pick<HeroProps, 'headline' | 'subhead' | 'ctaHref'>) {
  return (
    <BentoCell className="col-span-1 flex min-h-[280px] flex-col justify-between p-8 md:col-span-1 md:p-10 lg:col-span-2">
      <div>
        <span className="text-2xs text-warm-gray-light mb-6 block font-mono tracking-[0.2em] uppercase">
          Open Source · MIT Licensed
        </span>
        <h1
          className="text-charcoal mb-6 leading-[1.0] font-bold tracking-[-0.04em]"
          style={{ fontSize: 'clamp(32px, 4vw, 56px)' }}
        >
          {headline}
        </h1>
        <p className="text-warm-gray mb-8 max-w-[400px] text-sm leading-[1.75]">{subhead}</p>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Link
          href={ctaHref}
          target="_blank"
          rel="noopener noreferrer"
          className="bg-brand-orange text-cream-white text-button inline-flex items-center justify-center rounded-lg px-5 py-2.5 font-mono tracking-[0.08em] transition-colors hover:bg-[#C94E00]"
        >
          Get Started
        </Link>
        <Link
          href="/docs/getting-started/quickstart"
          className="text-warm-gray text-button hover:border-brand-orange hover:text-brand-orange inline-flex items-center justify-center rounded-lg border border-[var(--border-warm)] px-5 py-2.5 font-mono tracking-[0.08em] transition-colors"
        >
          Read the Docs →
        </Link>
      </div>
    </BentoCell>
  );
}

// ─── Cell 2: Phone mockup ─────────────────────────────────────────────────────

/** Simulated phone UI row shown inside the phone shell. */
function PhoneUiRow({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <div
      className={`flex items-center justify-between border-b border-[rgba(139,90,43,0.08)] py-1.5 last:border-0 ${dim ? 'opacity-40' : ''}`}
    >
      <span className="text-3xs text-warm-gray-light font-mono tracking-wider">{label}</span>
      <span className="text-3xs text-brand-orange font-mono">{value}</span>
    </div>
  );
}

function DeviceMockupCell() {
  return (
    <BentoCell className="flex min-h-[280px] flex-col items-center justify-center p-6">
      <span className="text-2xs text-warm-gray-light mb-4 font-mono tracking-[0.15em] uppercase">
        Mobile
      </span>
      {/* Phone shell */}
      <div
        className="border-charcoal bg-cream-secondary relative flex h-[220px] w-[120px] flex-col overflow-hidden rounded-[22px] border-[3px] shadow-lg"
        aria-hidden="true"
      >
        {/* Notch */}
        <div className="bg-charcoal absolute top-2 left-1/2 h-1.5 w-10 -translate-x-1/2 rounded-full" />
        {/* Screen content */}
        <div className="mt-6 flex flex-1 flex-col gap-0.5 px-2 pt-2">
          <PhoneUiRow label="SESSION" value="ACTIVE" />
          <PhoneUiRow label="AGENT" value="claude-3" />
          <PhoneUiRow label="TASKS" value="4 / 7" />
          <PhoneUiRow label="PULSE" value="ON" />
          <PhoneUiRow label="UPTIME" value="6h 12m" dim />
        </div>
        {/* Home bar */}
        <div className="flex h-4 items-center justify-center pb-1">
          <div className="bg-charcoal/30 h-0.5 w-8 rounded-full" />
        </div>
      </div>
      <p className="text-3xs text-warm-gray-light mt-4 text-center font-mono tracking-wider">
        Access from anywhere
      </p>
    </BentoCell>
  );
}

// ─── Cell 3: Stats ────────────────────────────────────────────────────────────

interface StatItem {
  value: string;
  label: string;
}

const STATS: StatItem[] = [
  { value: '6', label: 'Modules' },
  { value: 'MIT', label: 'Licensed' },
  { value: '100%', label: 'Open Source' },
  { value: '24/7', label: 'Always On' },
];

function StatBadge({ value, label }: StatItem) {
  return (
    <div className="bg-cream-secondary flex flex-col items-center justify-center gap-1 rounded-lg p-3">
      <span
        className="text-brand-orange font-mono leading-none font-bold tracking-[-0.02em]"
        style={{ fontSize: 'clamp(20px, 2.5vw, 28px)' }}
      >
        {value}
      </span>
      <span className="text-3xs text-warm-gray-light font-mono tracking-[0.12em] uppercase">
        {label}
      </span>
    </div>
  );
}

function StatsCell() {
  return (
    <BentoCell className="flex min-h-[280px] flex-col justify-between p-6">
      <span className="text-2xs text-warm-gray-light font-mono tracking-[0.15em] uppercase">
        By the numbers
      </span>
      <div className="mt-4 grid grid-cols-2 gap-2">
        {STATS.map((stat) => (
          <StatBadge key={stat.label} {...stat} />
        ))}
      </div>
    </BentoCell>
  );
}

// ─── Cell 4: Terminal install ─────────────────────────────────────────────────

function TerminalCell({ ctaText }: { ctaText: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    void navigator.clipboard.writeText(ctaText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <BentoCell className="flex min-h-[160px] flex-col justify-between p-6">
      {/* Terminal header bar */}
      <div className="mb-4 flex items-center gap-1.5">
        <div className="h-2.5 w-2.5 rounded-full bg-[#FF5F56]" />
        <div className="h-2.5 w-2.5 rounded-full bg-[#FFBD2E]" />
        <div className="h-2.5 w-2.5 rounded-full bg-[#27C93F]" />
        <span className="text-3xs text-warm-gray-light ml-2 font-mono tracking-wider">
          terminal
        </span>
      </div>
      {/* Command line */}
      <div className="bg-cream-secondary flex flex-1 items-center gap-2 rounded-lg px-4 py-3">
        <span className="text-button text-brand-orange font-mono select-none" aria-hidden="true">
          $
        </span>
        <span className="text-button text-charcoal flex-1 font-mono tracking-tight">{ctaText}</span>
      </div>
      {/* Copy button */}
      <button
        type="button"
        onClick={handleCopy}
        className="text-3xs text-warm-gray-light hover:text-brand-orange mt-3 cursor-pointer self-end font-mono tracking-[0.12em] uppercase transition-colors"
        aria-label="Copy install command"
      >
        {copied ? '✓ Copied' : 'Copy'}
      </button>
    </BentoCell>
  );
}

// ─── Cell 5: Product screenshot ───────────────────────────────────────────────

function ScreenshotCell() {
  return (
    <BentoCell className="col-span-1 overflow-hidden md:col-span-2 lg:col-span-3">
      <div className="bg-cream-secondary relative aspect-[16/10] w-full">
        <Image
          src="/images/dorkos-screenshot.png"
          alt="DorkOS console"
          width={1280}
          height={800}
          className="h-full w-full object-cover object-top"
          priority={false}
        />
        {/* Bottom label */}
        <div className="absolute bottom-3 left-4">
          <span className="text-3xs text-warm-gray-light bg-cream-white/80 rounded px-2 py-1 font-mono tracking-[0.15em] uppercase backdrop-blur-sm">
            DorkOS Console
          </span>
        </div>
      </div>
    </BentoCell>
  );
}

// ─── Root component ───────────────────────────────────────────────────────────

/**
 * HeroV5 — Bento grid hero with headline, device mockup, stats, terminal, and screenshot cells.
 *
 * Desktop: 4-column, 2-row grid.
 * Tablet:  2-column adaptive layout.
 * Mobile:  single column stack.
 */
export function HeroV5({ headline, subhead, ctaText, ctaHref }: HeroProps) {
  return (
    <section className="bg-cream-primary px-4 py-12 md:px-8 md:py-16">
      {/*
        Desktop grid (lg+): 4 columns, 2 explicit rows.
          Row 1: [headline (2col)] [phone (1col)] [stats (1col)]
          Row 2: [terminal (1col)] [screenshot (3col)]

        Tablet grid (md): 3 columns.
          Row 1: [headline (2col)] [phone (1col)]
          Row 2: [terminal (1col)] [stats (2col)]
          Row 3: [screenshot (3col)]

        Mobile: single column, natural order.
      */}
      <motion.div
        className="mx-auto grid max-w-7xl grid-cols-1 gap-3 md:grid-cols-3 lg:grid-cols-4"
        initial="hidden"
        animate="visible"
        variants={STAGGER}
      >
        {/* Cell 1 — Headline (2 cols on lg, 2 cols on md, full on mobile) */}
        <div className="col-span-1 md:col-span-2 lg:col-span-2">
          <HeadlineCell headline={headline} subhead={subhead} ctaHref={ctaHref} />
        </div>

        {/* Cell 2 — Phone mockup (1 col always) */}
        <div className="col-span-1">
          <DeviceMockupCell />
        </div>

        {/* Cell 3 — Stats (1 col on lg, full row on md via order trick, 1 col on mobile) */}
        <div className="col-span-1 md:col-span-1 lg:col-span-1">
          <StatsCell />
        </div>

        {/* Cell 4 — Terminal (1 col always) */}
        <div className="col-span-1">
          <TerminalCell ctaText={ctaText} />
        </div>

        {/* Cell 5 — Screenshot (3 cols on lg, full width on md, full on mobile) */}
        <div className="col-span-1 md:col-span-2 lg:col-span-3">
          <ScreenshotCell />
        </div>
      </motion.div>
    </section>
  );
}
