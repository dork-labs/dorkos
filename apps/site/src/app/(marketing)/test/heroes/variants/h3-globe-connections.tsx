'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { REVEAL, STAGGER } from '@/layers/features/marketing/lib/motion-variants';
import { GlobeVisual } from './h3-globe-visual';

// ─── Types ────────────────────────────────────────────────────────────────────

interface HeroProps {
  headline: string;
  subhead: string;
  ctaText: string;
  ctaHref: string;
}

// ─── Color ────────────────────────────────────────────────────────────────────

const ORANGE = '#E85D04';

// ─── Content Column ───────────────────────────────────────────────────────────

function ContentColumn({ headline, subhead, ctaText, ctaHref }: HeroProps) {
  return (
    <motion.div
      className="relative z-10 flex flex-col items-start gap-8"
      variants={STAGGER}
      initial="hidden"
      animate="visible"
    >
      {/* Eye-level badge */}
      <motion.div variants={REVEAL}>
        <span
          className="text-2xs inline-flex items-center gap-2 font-mono tracking-[0.15em] uppercase"
          style={{ color: ORANGE }}
        >
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: ORANGE }}
            aria-hidden="true"
          />
          Works on Desktop · Tablet · Mobile
        </span>
      </motion.div>

      {/* Headline */}
      <motion.h1
        className="text-charcoal leading-[1.0] font-semibold tracking-[-0.04em]"
        style={{ fontSize: 'clamp(36px, 5vw, 64px)' }}
        variants={REVEAL}
      >
        {headline}
      </motion.h1>

      {/* Subhead */}
      <motion.p
        className="text-warm-gray max-w-md leading-[1.7]"
        style={{ fontSize: 'clamp(15px, 1.5vw, 18px)' }}
        variants={REVEAL}
      >
        {subhead}
      </motion.p>

      {/* CTA group */}
      <motion.div className="flex flex-col gap-4 sm:flex-row" variants={REVEAL}>
        {/* Primary — terminal install command */}
        <a
          href={ctaHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-3 rounded-sm px-6 py-4"
          style={{
            background: ORANGE,
            fontFamily: 'var(--font-ibm-plex-mono), ui-monospace, monospace',
            fontSize: '13px',
            fontWeight: 500,
            letterSpacing: '0.04em',
            color: '#FFFEFB',
          }}
        >
          <span style={{ opacity: 0.65 }}>$</span>
          <span>{ctaText}</span>
          {/* Blinking cursor */}
          <span className="cursor-blink" aria-hidden="true" />
        </a>

        {/* Secondary — docs link */}
        <Link
          href="/docs"
          className="inline-flex items-center gap-1.5 rounded-sm border px-6 py-4"
          style={{
            borderColor: 'rgba(139, 90, 43, 0.2)',
            fontFamily: 'var(--font-ibm-plex-mono), ui-monospace, monospace',
            fontSize: '11px',
            fontWeight: 500,
            letterSpacing: '0.08em',
            color: 'var(--warm-gray)',
            textTransform: 'uppercase',
          }}
        >
          Read the docs
          <span aria-hidden="true" style={{ fontSize: '14px' }}>
            →
          </span>
        </Link>
      </motion.div>

      {/* Latitude coordinates — subtle flavour text */}
      <motion.p
        className="text-3xs font-mono tracking-[0.12em] uppercase"
        style={{ color: 'rgba(74, 70, 64, 0.4)', fontSize: '9px' }}
        variants={REVEAL}
      >
        Access from anywhere on Earth · 0°N 0°E to 90°S 180°W
      </motion.p>
    </motion.div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

/**
 * HeroV3 — Globe with Connection Arcs hero section.
 *
 * Desktop: split layout — content left, globe right.
 * Tablet: globe behind content at reduced opacity.
 * Mobile: globe below content at reduced opacity, then hidden at md+.
 */
export function HeroV3({ headline, subhead, ctaText, ctaHref }: HeroProps) {
  return (
    <section className="bg-cream-primary relative min-h-[85vh] overflow-hidden">
      {/* ── Desktop/Tablet globe — right half, absolutely positioned ── */}
      <div
        className="pointer-events-none absolute inset-y-0 right-0 flex w-full items-center justify-center opacity-30 md:w-3/5 md:opacity-60 lg:w-1/2 lg:opacity-100"
        aria-hidden="true"
      >
        {/* Fade mask on the left edge so globe blends into the cream */}
        <div
          className="pointer-events-none absolute inset-0 hidden md:block"
          style={{
            background: 'linear-gradient(to right, var(--cream-primary) 0%, transparent 30%)',
          }}
        />
        <div className="w-full max-w-[520px] p-8">
          <GlobeVisual />
        </div>
      </div>

      {/* ── Content — left column ── */}
      <div className="relative z-10 flex min-h-[85vh] max-w-2xl items-center px-8 py-24 md:px-12 lg:max-w-xl lg:px-16">
        <ContentColumn headline={headline} subhead={subhead} ctaText={ctaText} ctaHref={ctaHref} />
      </div>

      {/* ── Mobile globe — below content, centered, small ── */}
      <div
        className="pointer-events-none block px-8 pb-16 md:hidden"
        aria-hidden="true"
        style={{ opacity: 0.5 }}
      >
        <div className="mx-auto w-full max-w-[260px]">
          <GlobeVisual />
        </div>
      </div>
    </section>
  );
}
