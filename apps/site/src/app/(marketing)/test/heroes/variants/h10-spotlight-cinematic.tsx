'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { motion } from 'motion/react';
import { REVEAL, STAGGER } from '@/layers/features/marketing/lib/motion-variants';

// ─── Types ────────────────────────────────────────────────────────────────────

interface HeroProps {
  headline: string;
  subhead: string;
  ctaText: string;
  ctaHref: string;
}

interface SpotlightPosition {
  x: number;
  y: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Spotlight radial gradient radius in px. */
const SPOTLIGHT_RADIUS = 600;

/** Orange at very low opacity for the spotlight warm glow. */
const SPOTLIGHT_COLOR = 'rgba(232,93,4,0.06)';

/** Shadow stack for the showcase frame — layered depth. */
const SHOWCASE_SHADOW =
  '0 1px 2px rgba(26,24,20,0.04), 0 4px 8px rgba(26,24,20,0.06), 0 12px 24px rgba(26,24,20,0.08), 0 32px 64px rgba(26,24,20,0.12), 0 64px 96px rgba(26,24,20,0.06)';

/** Word-by-word headline spring — tighter than the default SPRING. */
const HEADLINE_WORD_TRANSITION = {
  type: 'spring' as const,
  stiffness: 120,
  damping: 22,
  mass: 0.9,
};

// ─── Spotlight hook ───────────────────────────────────────────────────────────

/**
 * Tracks cursor position relative to a section element, throttled via rAF.
 * Falls back to section center on mobile (no pointermove events).
 *
 * @param sectionRef - Ref to the section element to track within
 */
function useSpotlight(sectionRef: React.RefObject<HTMLElement | null>): SpotlightPosition {
  const [pos, setPos] = useState<SpotlightPosition>({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);
  const initializedRef = useRef(false);

  // Set initial center position once the section mounts
  useEffect(() => {
    const el = sectionRef.current;
    if (!el || initializedRef.current) return;
    const rect = el.getBoundingClientRect();
    setPos({ x: rect.width / 2, y: rect.height * 0.35 });
    initializedRef.current = true;
  }, [sectionRef]);

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const el = sectionRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        setPos({
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        });
      });
    },
    [sectionRef]
  );

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    el.addEventListener('pointermove', handlePointerMove);
    return () => {
      el.removeEventListener('pointermove', handlePointerMove);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [handlePointerMove, sectionRef]);

  return pos;
}

// ─── Spotlight layer ──────────────────────────────────────────────────────────

/** Renders the cursor-tracking radial gradient spotlight overlay. */
function SpotlightLayer({ pos }: { pos: SpotlightPosition }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 transition-none"
      style={{
        background: `radial-gradient(${SPOTLIGHT_RADIUS}px circle at ${pos.x}px ${pos.y}px, ${SPOTLIGHT_COLOR}, transparent 70%)`,
        zIndex: 1,
      }}
    />
  );
}

// ─── Graph-paper grid ─────────────────────────────────────────────────────────

/** Subtle warm grid lines — same motif used across hero variants. */
function GraphPaperGrid() {
  const GRID_MASK =
    'linear-gradient(to bottom, transparent 0%, black 15%, black 85%, transparent 100%)';
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0"
      style={{
        backgroundImage:
          'linear-gradient(to right, rgba(139,90,43,0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(139,90,43,0.06) 1px, transparent 1px), linear-gradient(to right, rgba(139,90,43,0.10) 1px, transparent 1px), linear-gradient(to bottom, rgba(139,90,43,0.10) 1px, transparent 1px)',
        backgroundSize: '24px 24px, 24px 24px, 120px 120px, 120px 120px',
        maskImage: GRID_MASK,
        WebkitMaskImage: GRID_MASK,
        zIndex: 0,
      }}
    />
  );
}

// ─── Headline ─────────────────────────────────────────────────────────────────

/** Splits headline into words, staggering each with a spring entrance. */
function CinematicHeadline({ headline }: { headline: string }) {
  const words = headline.split(' ');

  /** Per-word variant — springs in from slightly below with a glow. */
  const wordVariant = {
    hidden: { opacity: 0, y: 28, filter: 'blur(4px)' },
    visible: {
      opacity: 1,
      y: 0,
      filter: 'blur(0px)',
      transition: HEADLINE_WORD_TRANSITION,
    },
  };

  return (
    <h1
      aria-label={headline}
      className="flex flex-wrap justify-center gap-x-[0.25em] gap-y-1 leading-[1.0] font-bold tracking-[-0.04em]"
      style={{
        fontSize: 'clamp(48px, 7vw, 88px)',
        color: 'var(--brand-orange)',
        textShadow: '0 0 40px rgba(232,93,4,0.12), 0 0 80px rgba(232,93,4,0.06)',
      }}
    >
      {words.map((word, i) => (
        <motion.span
          key={`${word}-${i}`}
          variants={wordVariant}
          style={{ display: 'inline-block' }}
        >
          {word}
        </motion.span>
      ))}
    </h1>
  );
}

// ─── Browser frame mockup ─────────────────────────────────────────────────────

/** Browser chrome — tab bar with traffic-light dots and address bar. */
function BrowserChrome() {
  return (
    <div
      className="flex flex-shrink-0 items-center gap-3 border-b px-4"
      style={{
        height: 44,
        background: 'var(--cream-secondary)',
        borderColor: 'var(--border-warm)',
      }}
    >
      {/* Traffic lights */}
      <div className="flex items-center gap-1.5" aria-hidden="true">
        <span className="h-3 w-3 rounded-full" style={{ background: 'rgba(232,93,4,0.5)' }} />
        <span className="h-3 w-3 rounded-full" style={{ background: 'rgba(139,90,43,0.25)' }} />
        <span className="h-3 w-3 rounded-full" style={{ background: 'rgba(34,139,34,0.4)' }} />
      </div>

      {/* Address bar */}
      <div
        className="flex flex-1 items-center rounded px-3 font-mono"
        style={{
          height: 26,
          background: 'var(--cream-tertiary)',
          border: '1px solid var(--border-warm)',
          fontSize: 11,
          color: 'var(--warm-gray-light)',
          maxWidth: 320,
          margin: '0 auto',
        }}
      >
        <span style={{ color: 'var(--brand-green)', marginRight: 4, fontSize: 10 }}>●</span>
        localhost:4242
      </div>
    </div>
  );
}

// ─── Product showcase ─────────────────────────────────────────────────────────

/**
 * Browser-framed product screenshot with 3-D perspective tilt.
 * The frame has its own hover spotlight glow and layered shadows.
 */
function ProductShowcase() {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <motion.div variants={REVEAL} className="relative w-full" style={{ perspective: '1200px' }}>
      {/* Ground glow — intensifies on hover */}
      <div
        aria-hidden="true"
        className="absolute inset-x-8 -bottom-6 rounded-full transition-all duration-500"
        style={{
          height: 40,
          background: isHovered ? 'rgba(232,93,4,0.18)' : 'rgba(26,24,20,0.12)',
          filter: 'blur(20px)',
          zIndex: 0,
        }}
      />

      <motion.div
        onHoverStart={() => setIsHovered(true)}
        onHoverEnd={() => setIsHovered(false)}
        animate={{
          rotateX: isHovered ? 0 : 2,
          scale: isHovered ? 1.012 : 1,
        }}
        transition={{ type: 'spring', stiffness: 100, damping: 20 }}
        className="relative overflow-hidden rounded-xl"
        style={{
          transformOrigin: 'center bottom',
          boxShadow: isHovered
            ? [
                '0 1px 2px rgba(26,24,20,0.04)',
                '0 4px 8px rgba(26,24,20,0.06)',
                '0 16px 32px rgba(26,24,20,0.10)',
                '0 40px 80px rgba(26,24,20,0.14)',
                '0 0 0 1px rgba(232,93,4,0.08)',
              ].join(', ')
            : SHOWCASE_SHADOW,
          border: '1px solid var(--border-warm)',
          zIndex: 1,
          transition: 'box-shadow 0.4s ease',
        }}
      >
        <BrowserChrome />

        {/* Screenshot area */}
        <div className="relative overflow-hidden" style={{ background: 'var(--cream-primary)' }}>
          <Image
            src="/images/dorkos-screenshot.png"
            alt="DorkOS console — chat interface with Claude Code agent sessions"
            width={1280}
            height={800}
            priority
            className="block h-auto w-full"
            style={{ display: 'block' }}
          />

          {/* Hover spotlight overlay on the screenshot */}
          {isHovered && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  'radial-gradient(50% 60% at 50% 40%, rgba(232,93,4,0.04), transparent 100%)',
              }}
            />
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─── Supporting badges ────────────────────────────────────────────────────────

interface BadgeProps {
  icon: React.ReactNode;
  label: string;
}

/** A single supporting badge with mono font and warm border. */
function SupportingBadge({ icon, label }: BadgeProps) {
  return (
    <motion.div
      variants={REVEAL}
      className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 font-mono text-xs tracking-[0.08em]"
      style={{
        background: 'var(--cream-white)',
        borderColor: 'rgba(139,90,43,0.15)',
        color: 'var(--warm-gray)',
        boxShadow: '0 1px 3px rgba(26,24,20,0.04)',
      }}
    >
      <span aria-hidden="true" style={{ color: 'var(--brand-orange)' }}>
        {icon}
      </span>
      {label}
    </motion.div>
  );
}

// Badge SVG paths — defined outside render to avoid re-allocation.
const BADGE_SVG_PROPS = {
  width: 13,
  height: 13,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true as const,
};

/** The three informational badges rendered below the showcase. */
function BadgeRow() {
  const badges: BadgeProps[] = [
    {
      icon: (
        <svg {...BADGE_SVG_PROPS}>
          <rect x="5" y="2" width="14" height="20" rx="2" />
          <rect x="2" y="7" width="6" height="10" rx="1" />
        </svg>
      ),
      label: 'Desktop + Mobile',
    },
    {
      icon: (
        <svg {...BADGE_SVG_PROPS}>
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      ),
      label: 'Open Source · MIT',
    },
    {
      icon: (
        <svg {...BADGE_SVG_PROPS}>
          <path d="M12 2a10 10 0 1 0 10 10H12V2z" />
          <path d="M12 2a10 10 0 0 1 10 10" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      ),
      label: 'Built on Claude',
    },
  ];

  return (
    <motion.div variants={STAGGER} className="flex flex-wrap justify-center gap-3">
      {badges.map((badge) => (
        <SupportingBadge key={badge.label} {...badge} />
      ))}
    </motion.div>
  );
}

// ─── CTA ──────────────────────────────────────────────────────────────────────

interface CtaProps {
  ctaText: string;
  ctaHref: string;
}

/** Primary CTA button — brand orange, with arrow animation. */
function CtaButton({ ctaText, ctaHref }: CtaProps) {
  return (
    <motion.div variants={REVEAL} className="flex justify-center">
      <Link
        href={ctaHref}
        className="group inline-flex items-center gap-3 rounded-lg px-7 py-3.5 font-mono text-sm tracking-[0.06em] transition-all duration-200 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        style={{
          background: 'var(--brand-orange)',
          color: 'var(--cream-white)',
          boxShadow:
            '0 1px 2px rgba(232,93,4,0.2), 0 4px 12px rgba(232,93,4,0.25), 0 12px 24px rgba(232,93,4,0.15)',
        }}
      >
        {ctaText}
        <motion.span
          aria-hidden="true"
          animate={{ x: [0, 3, 0] }}
          transition={{ repeat: Infinity, duration: 1.8, ease: 'easeInOut' }}
          style={{ display: 'inline-block' }}
        >
          →
        </motion.span>
      </Link>
    </motion.div>
  );
}

// ─── Root component ───────────────────────────────────────────────────────────

/**
 * Hero variant H10 — Spotlight Cinematic.
 *
 * A theatrical product-launch hero: a cursor-tracked warm spotlight follows
 * the visitor across a cream background, illuminating the brand-orange headline
 * and large browser-framed product screenshot. Each headline word springs in
 * independently, Apple-keynote style.
 */
export function HeroV10({ headline, subhead, ctaText, ctaHref }: HeroProps) {
  const sectionRef = useRef<HTMLElement>(null);
  const spotlightPos = useSpotlight(sectionRef);

  return (
    <section
      ref={sectionRef}
      className="relative flex min-h-[90vh] flex-col overflow-hidden"
      style={{ backgroundColor: 'var(--cream-primary)' }}
    >
      <GraphPaperGrid />
      <SpotlightLayer pos={spotlightPos} />
      <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 pt-20 pb-16 md:pt-24 md:pb-20">
        <div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-8 md:gap-10">
          <motion.p
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
            className="font-mono text-xs tracking-[0.2em] uppercase"
            style={{ color: 'var(--warm-gray-light)' }}
          >
            Product reveal
          </motion.p>

          <motion.div initial="hidden" animate="visible" variants={STAGGER} className="text-center">
            <CinematicHeadline headline={headline} />
          </motion.div>

          <motion.p
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, ease: 'easeOut', delay: 0.35 }}
            className="max-w-[520px] text-center text-base leading-[1.75] font-light md:text-lg"
            style={{ color: 'var(--warm-gray)' }}
          >
            {subhead}
          </motion.p>

          <motion.div
            initial="hidden"
            animate="visible"
            variants={STAGGER}
            className="flex flex-col items-center gap-4"
          >
            <CtaButton ctaText={ctaText} ctaHref={ctaHref} />

            <motion.div variants={REVEAL}>
              <Link
                href="/docs/getting-started/quickstart"
                className="font-mono text-xs tracking-[0.14em] uppercase transition-colors duration-150"
                style={{ color: 'var(--warm-gray-light)' }}
              >
                View docs →
              </Link>
            </motion.div>
          </motion.div>

          <motion.div
            initial="hidden"
            animate="visible"
            variants={{
              hidden: { opacity: 0, y: 40 },
              visible: {
                opacity: 1,
                y: 0,
                transition: {
                  type: 'spring',
                  stiffness: 80,
                  damping: 20,
                  delay: 0.45,
                },
              },
            }}
            className="w-full max-w-4xl"
          >
            <ProductShowcase />
          </motion.div>

          <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, amount: 0.3 }}
            variants={STAGGER}
            className="flex w-full justify-center"
          >
            <BadgeRow />
          </motion.div>
        </div>
      </div>
    </section>
  );
}
