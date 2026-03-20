'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { motion } from 'motion/react';
import { REVEAL, STAGGER, VIEWPORT } from '@/layers/features/marketing/lib/motion-variants';
import { LaptopMockup, TabletMockup, PhoneMockup, type ParallaxOffset } from './h1-device-mockups';

// ─── Types ────────────────────────────────────────────────────────────────────

interface HeroProps {
  headline: string;
  subhead: string;
  ctaText: string;
  ctaHref: string;
}

// ─── Animation constants ──────────────────────────────────────────────────────

const DEVICE_ENTRANCE = {
  hidden: { opacity: 0, x: 60 },
  visible: {
    opacity: 1,
    x: 0,
    transition: {
      type: 'spring' as const,
      stiffness: 80,
      damping: 18,
      mass: 1,
      delay: 0.35,
    },
  },
};

const FLOAT_LAPTOP = { duration: 5.5, repeat: Infinity, ease: 'easeInOut' as const, delay: 0 };
const FLOAT_PHONE = { duration: 4.2, repeat: Infinity, ease: 'easeInOut' as const, delay: 0.8 };
const FLOAT_TABLET = { duration: 3.8, repeat: Infinity, ease: 'easeInOut' as const, delay: 1.4 };

// ─── Mouse parallax hook ──────────────────────────────────────────────────────

function useMouseParallax(sectionRef: React.RefObject<HTMLElement | null>): ParallaxOffset {
  const [offset, setOffset] = useState<ParallaxOffset>({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const el = sectionRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const dx = (e.clientX - (rect.left + rect.width / 2)) / rect.width;
        const dy = (e.clientY - (rect.top + rect.height / 2)) / rect.height;
        setOffset({ x: dx * 18, y: dy * 12 });
      });
    },
    [sectionRef]
  );

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    el.addEventListener('mousemove', handleMouseMove);
    return () => {
      el.removeEventListener('mousemove', handleMouseMove);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [handleMouseMove, sectionRef]);

  return offset;
}

// ─── Device arrangements ──────────────────────────────────────────────────────

/** Desktop: cascading perspective stack, parallax-enabled. */
function DeviceCluster({ offset }: { offset: ParallaxOffset }) {
  return (
    <div
      className="relative flex items-center justify-center"
      style={{ height: 320, minWidth: 340 }}
    >
      <motion.div
        className="absolute"
        style={{ left: 0, top: 60 }}
        animate={{ y: [0, -6, 0] }}
        transition={FLOAT_PHONE}
      >
        <PhoneMockup offset={offset} />
      </motion.div>
      <motion.div
        className="absolute"
        style={{ left: 40, top: 20, zIndex: 10 }}
        animate={{ y: [0, -8, 0] }}
        transition={FLOAT_LAPTOP}
      >
        <LaptopMockup offset={offset} />
      </motion.div>
      <motion.div
        className="absolute"
        style={{ right: 0, top: 50 }}
        animate={{ y: [0, -5, 0] }}
        transition={FLOAT_TABLET}
      >
        <TabletMockup offset={offset} />
      </motion.div>
    </div>
  );
}

/** Tablet breakpoint: horizontal row, no parallax. */
function DeviceRow() {
  const still: ParallaxOffset = { x: 0, y: 0 };
  return (
    <div className="mt-12 flex items-end justify-center gap-8">
      <motion.div animate={{ y: [0, -6, 0] }} transition={FLOAT_PHONE}>
        <PhoneMockup offset={still} />
      </motion.div>
      <motion.div animate={{ y: [0, -8, 0] }} transition={FLOAT_LAPTOP}>
        <LaptopMockup offset={still} />
      </motion.div>
      <motion.div animate={{ y: [0, -5, 0] }} transition={FLOAT_TABLET}>
        <TabletMockup offset={still} />
      </motion.div>
    </div>
  );
}

/** Mobile: phone first (most relatable), then laptop, then tablet. */
function DeviceStack() {
  const still: ParallaxOffset = { x: 0, y: 0 };
  return (
    <div className="mt-10 flex flex-col items-center gap-8">
      <motion.div animate={{ y: [0, -5, 0] }} transition={{ ...FLOAT_PHONE, duration: 4 }}>
        <PhoneMockup offset={still} />
      </motion.div>
      <motion.div
        animate={{ y: [0, -7, 0] }}
        transition={{ ...FLOAT_LAPTOP, duration: 5, delay: 0.6 }}
      >
        <LaptopMockup offset={still} />
      </motion.div>
      <motion.div
        animate={{ y: [0, -4, 0] }}
        transition={{ ...FLOAT_TABLET, duration: 3.5, delay: 1.2 }}
      >
        <TabletMockup offset={still} />
      </motion.div>
    </div>
  );
}

// ─── CTA block ────────────────────────────────────────────────────────────────

function CtaBlock({ ctaText, ctaHref }: { ctaText: string; ctaHref: string }) {
  return (
    <div className="mt-8 flex flex-col gap-4 md:mt-10">
      <motion.div variants={REVEAL}>
        <a
          href={ctaHref}
          target="_blank"
          rel="noopener noreferrer"
          className="group transition-smooth inline-flex items-center gap-2 rounded px-5 py-3 font-mono text-sm tracking-[0.06em]"
          style={{
            background: 'var(--charcoal)',
            color: 'var(--cream-white)',
            boxShadow: '0 4px 16px rgba(26,24,20,0.18)',
          }}
        >
          <span style={{ color: 'var(--brand-orange)' }}>$</span>
          <span>{ctaText}</span>
          <span className="cursor-blink" aria-hidden="true" />
        </a>
      </motion.div>
      <motion.div variants={REVEAL}>
        <Link
          href="/docs/getting-started/quickstart"
          className="text-2xs transition-smooth inline-flex items-center font-mono tracking-[0.12em] uppercase"
          style={{ color: 'var(--warm-gray-light)' }}
        >
          Read the docs &rarr;
        </Link>
      </motion.div>
    </div>
  );
}

// ─── Section label + headline + subhead (shared across breakpoints) ───────────

function HeroCopy({
  headline,
  subhead,
  centered = false,
}: {
  headline: string;
  subhead: string;
  centered?: boolean;
}) {
  const align = centered ? 'text-center' : 'text-left';
  const maxW = centered ? 'max-w-xl mx-auto' : 'max-w-[420px]';
  return (
    <>
      <motion.p
        variants={REVEAL}
        className={`text-2xs mb-6 font-mono tracking-[0.18em] uppercase ${align}`}
        style={{ color: 'var(--brand-orange)' }}
      >
        Access from anywhere
      </motion.p>
      <motion.h1
        variants={REVEAL}
        className={`text-charcoal mb-6 leading-[1.0] font-bold tracking-[-0.04em] ${align}`}
        style={{ fontSize: 'clamp(36px, 5vw, 68px)' }}
      >
        {headline}
      </motion.h1>
      <motion.p
        variants={REVEAL}
        className={`text-warm-gray text-base leading-[1.75] font-light ${maxW} ${align}`}
      >
        {subhead}
      </motion.p>
    </>
  );
}

// ─── Background decoration ────────────────────────────────────────────────────

function GridBackground() {
  return (
    <div
      className="pointer-events-none absolute inset-0"
      style={{
        backgroundImage: `
          linear-gradient(to right, rgba(139,90,43,0.07) 1px, transparent 1px),
          linear-gradient(to bottom, rgba(139,90,43,0.07) 1px, transparent 1px),
          linear-gradient(to right, rgba(139,90,43,0.12) 1px, transparent 1px),
          linear-gradient(to bottom, rgba(139,90,43,0.12) 1px, transparent 1px)
        `,
        backgroundSize: '20px 20px, 20px 20px, 100px 100px, 100px 100px',
        maskImage:
          'linear-gradient(to bottom, transparent 0%, black 20%, black 80%, transparent 100%)',
        WebkitMaskImage:
          'linear-gradient(to bottom, transparent 0%, black 20%, black 80%, transparent 100%)',
      }}
    />
  );
}

// ─── Root component ───────────────────────────────────────────────────────────

/** Hero variant H1 — floating device showcase (laptop, tablet, phone). */
export function HeroV1({ headline, subhead, ctaText, ctaHref }: HeroProps) {
  const sectionRef = useRef<HTMLElement>(null);
  const parallaxOffset = useMouseParallax(sectionRef);

  return (
    <section ref={sectionRef} className="bg-cream-primary relative min-h-[85vh] overflow-hidden">
      <GridBackground />

      {/* ── DESKTOP: copy left (60%) + devices right (40%) ─────────────── */}
      <div className="mx-auto hidden min-h-[85vh] max-w-7xl items-center gap-8 px-12 lg:flex xl:px-20">
        <motion.div
          className="z-10 max-w-[55%] flex-1"
          initial="hidden"
          animate="visible"
          variants={STAGGER}
        >
          <HeroCopy headline={headline} subhead={subhead} />
          <CtaBlock ctaText={ctaText} ctaHref={ctaHref} />
        </motion.div>

        <motion.div
          className="flex w-[45%] flex-shrink-0 items-center justify-center"
          initial="hidden"
          animate="visible"
          variants={DEVICE_ENTRANCE}
        >
          <DeviceCluster offset={parallaxOffset} />
        </motion.div>
      </div>

      {/* ── TABLET: headline centered, devices in a row below ──────────── */}
      <div className="hidden min-h-[85vh] flex-col items-center px-8 pt-20 pb-16 md:flex lg:hidden">
        <motion.div
          className="max-w-xl text-center"
          initial="hidden"
          animate="visible"
          variants={STAGGER}
        >
          <HeroCopy headline={headline} subhead={subhead} centered />
          <motion.div variants={REVEAL} className="mt-8 flex flex-col items-center gap-4">
            <a
              href={ctaHref}
              target="_blank"
              rel="noopener noreferrer"
              className="transition-smooth inline-flex items-center gap-2 rounded px-5 py-3 font-mono text-sm tracking-[0.06em]"
              style={{
                background: 'var(--charcoal)',
                color: 'var(--cream-white)',
                boxShadow: '0 4px 16px rgba(26,24,20,0.18)',
              }}
            >
              <span style={{ color: 'var(--brand-orange)' }}>$</span>
              <span>{ctaText}</span>
              <span className="cursor-blink" aria-hidden="true" />
            </a>
            <Link
              href="/docs/getting-started/quickstart"
              className="text-2xs transition-smooth inline-flex items-center font-mono tracking-[0.12em] uppercase"
              style={{ color: 'var(--warm-gray-light)' }}
            >
              Read the docs &rarr;
            </Link>
          </motion.div>
        </motion.div>
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
          variants={DEVICE_ENTRANCE}
        >
          <DeviceRow />
        </motion.div>
      </div>

      {/* ── MOBILE: stacked (phone first, then laptop, then tablet) ─────── */}
      <div className="flex min-h-[85vh] flex-col px-5 pt-16 pb-12 md:hidden">
        <motion.div initial="hidden" animate="visible" variants={STAGGER}>
          <HeroCopy headline={headline} subhead={subhead} />
          <motion.div variants={REVEAL} className="mt-6 flex flex-col gap-4">
            <a
              href={ctaHref}
              target="_blank"
              rel="noopener noreferrer"
              className="transition-smooth inline-flex items-center gap-2 self-start rounded px-4 py-2.5 font-mono tracking-[0.06em]"
              style={{
                background: 'var(--charcoal)',
                color: 'var(--cream-white)',
                fontSize: 12,
                boxShadow: '0 4px 14px rgba(26,24,20,0.16)',
              }}
            >
              <span style={{ color: 'var(--brand-orange)' }}>$</span>
              <span>{ctaText}</span>
              <span className="cursor-blink" aria-hidden="true" />
            </a>
            <Link
              href="/docs/getting-started/quickstart"
              className="text-2xs transition-smooth inline-flex items-center font-mono tracking-[0.12em] uppercase"
              style={{ color: 'var(--warm-gray-light)' }}
            >
              Read the docs &rarr;
            </Link>
          </motion.div>
        </motion.div>
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={VIEWPORT}
          variants={DEVICE_ENTRANCE}
          className="self-center"
        >
          <DeviceStack />
        </motion.div>
      </div>

      {/* Scan lines */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.012) 2px, rgba(0,0,0,0.012) 4px)',
        }}
      />
    </section>
  );
}
