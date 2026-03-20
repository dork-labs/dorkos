'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { REVEAL, STAGGER } from '@/layers/features/marketing/lib/motion-variants';

interface HeroProps {
  headline: string;
  subhead: string;
  ctaText: string;
  ctaHref: string;
}

// Split the headline into individual words for staggered entrance.
// Each word fades up independently for dramatic vertical rhythm.
function HeadlineWords({ text }: { text: string }) {
  const words = text.split(' ');
  return (
    <motion.div
      variants={STAGGER}
      initial="hidden"
      animate="visible"
      className="flex flex-col items-center"
      aria-label={text}
    >
      {words.map((word, i) => (
        <motion.span
          key={`${word}-${i}`}
          variants={REVEAL}
          className="hero-gradient-text block leading-[0.92]"
          style={{ letterSpacing: '-0.05em' }}
          aria-hidden="true"
        >
          {word}
        </motion.span>
      ))}
    </motion.div>
  );
}

/**
 * Hero variant 7 — oversized animated gradient headline with a warm mesh
 * background. Typography is the entire visual statement; CTA is minimal.
 */
export function HeroV7({ headline, subhead, ctaText, ctaHref }: HeroProps) {
  return (
    <section className="bg-cream-primary relative flex min-h-[90vh] flex-col items-center justify-center overflow-hidden px-6">
      {/*
       * Mesh background — 3 large radial blobs that animate position.
       * Opacity is intentionally low (0.15) so the cream base reads clean.
       */}
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div className="mesh-blob mesh-blob-a" />
        <div className="mesh-blob mesh-blob-b" />
        <div className="mesh-blob mesh-blob-c" />
      </div>

      {/* Content — single centered column */}
      <div className="relative z-10 mx-auto flex w-full max-w-5xl flex-col items-center gap-10 text-center">
        {/* Oversized gradient headline */}
        <h1 className="w-full" style={{ fontSize: 'clamp(56px, 12vw, 140px)' }}>
          <HeadlineWords text={headline} />
        </h1>

        {/* Subhead — minimal, restrained */}
        <motion.p
          variants={REVEAL}
          initial="hidden"
          animate="visible"
          className="text-warm-gray mx-auto max-w-[480px] text-base leading-[1.75] font-light md:text-lg"
        >
          {subhead}
        </motion.p>

        {/* CTA block — text links only, no heavy buttons */}
        <motion.div
          variants={STAGGER}
          initial="hidden"
          animate="visible"
          className="flex flex-col items-center gap-4"
        >
          {/* Primary CTA: install command in mono, underlined */}
          <motion.div variants={REVEAL}>
            <Link
              href={ctaHref}
              className="text-charcoal decoration-brand-orange/50 hover:decoration-brand-orange transition-smooth font-mono text-sm tracking-[0.08em] underline underline-offset-4"
              target="_blank"
              rel="noopener noreferrer"
            >
              {ctaText}
            </Link>
          </motion.div>

          {/* Secondary CTA: docs link */}
          <motion.div variants={REVEAL}>
            <Link
              href="/docs/getting-started/quickstart"
              className="text-2xs text-warm-gray-light hover:text-brand-orange transition-smooth font-mono tracking-[0.12em]"
            >
              Read the docs &rarr;
            </Link>
          </motion.div>
        </motion.div>
      </div>

      {/*
       * Component-scoped styles injected as a style tag.
       * Using a <style> element here is intentional: the gradient-text
       * technique requires background-clip: text which has vendor prefix
       * requirements, and the @keyframes for gradient-shift and blob drift
       * cannot be expressed as pure Tailwind utilities in Tailwind v4 without
       * polluting globals.css with single-use animations.
       */}
      <style>{`
        /* ── Gradient text ──────────────────────────────────────────── */
        .hero-gradient-text {
          background-image: linear-gradient(
            135deg,
            #E85D04 0%,
            #D4740A 25%,
            #C4451A 50%,
            #D4740A 75%,
            #E85D04 100%
          );
          background-size: 300% 300%;
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          color: transparent;
          animation: gradient-shift 8s ease-in-out infinite;
        }

        @keyframes gradient-shift {
          0%   { background-position: 0%   50%; }
          50%  { background-position: 100% 50%; }
          100% { background-position: 0%   50%; }
        }

        /* ── Mesh background blobs ──────────────────────────────────── */
        .mesh-blob {
          position: absolute;
          border-radius: 50%;
          filter: blur(80px);
          opacity: 0.15;
        }

        /* Blob A — warm orange, top-left quadrant */
        .mesh-blob-a {
          width: 55vw;
          height: 55vw;
          max-width: 700px;
          max-height: 700px;
          background: radial-gradient(circle, #E85D04 0%, transparent 70%);
          top: -15%;
          left: -10%;
          animation: drift-a 18s ease-in-out infinite alternate;
        }

        /* Blob B — amber, bottom-right quadrant */
        .mesh-blob-b {
          width: 45vw;
          height: 45vw;
          max-width: 600px;
          max-height: 600px;
          background: radial-gradient(circle, #D4740A 0%, transparent 70%);
          bottom: -10%;
          right: -8%;
          animation: drift-b 22s ease-in-out infinite alternate;
        }

        /* Blob C — cream-amber, center-right — very subtle fill */
        .mesh-blob-c {
          width: 35vw;
          height: 35vw;
          max-width: 480px;
          max-height: 480px;
          background: radial-gradient(circle, #F5C842 0%, transparent 70%);
          top: 40%;
          right: 20%;
          animation: drift-c 26s ease-in-out infinite alternate;
        }

        @keyframes drift-a {
          0%   { transform: translate(0,   0) scale(1);    }
          50%  { transform: translate(4%,  6%) scale(1.05); }
          100% { transform: translate(-3%, 3%) scale(0.97); }
        }

        @keyframes drift-b {
          0%   { transform: translate(0,    0) scale(1);    }
          50%  { transform: translate(-5%, -4%) scale(1.07); }
          100% { transform: translate(3%,  -2%) scale(0.95); }
        }

        @keyframes drift-c {
          0%   { transform: translate(0,   0) scale(1);    }
          50%  { transform: translate(-4%, 5%) scale(1.04); }
          100% { transform: translate(6%,  2%) scale(0.98); }
        }
      `}</style>
    </section>
  );
}
