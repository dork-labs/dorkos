'use client';

import Image from 'next/image';
import Link from 'next/link';
import { motion } from 'motion/react';
import { PulseAnimation } from './PulseAnimation';
import { REVEAL } from '../lib/motion-variants';

interface HeroProps {
  label?: string;
  headline: string;
  subhead: string;
  ctaText: string;
  ctaHref: string;
}

export function Hero({ label = 'Open Source', headline, subhead, ctaText, ctaHref }: HeroProps) {
  return (
    <section className="relative flex min-h-screen flex-col items-center justify-center px-6 pt-24">
      {/* Graph paper background - small + large grid with vertical fade */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: `
            linear-gradient(to right, rgba(139, 90, 43, 0.08) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(139, 90, 43, 0.08) 1px, transparent 1px),
            linear-gradient(to right, rgba(139, 90, 43, 0.15) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(139, 90, 43, 0.15) 1px, transparent 1px)
          `,
          backgroundSize: '20px 20px, 20px 20px, 100px 100px, 100px 100px',
          maskImage:
            'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.5) 15%, rgba(0,0,0,1) 30%, rgba(0,0,0,1) 70%, rgba(0,0,0,0.5) 85%, transparent 100%)',
          WebkitMaskImage:
            'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.5) 15%, rgba(0,0,0,1) 30%, rgba(0,0,0,1) 70%, rgba(0,0,0,0.5) 85%, transparent 100%)',
        }}
      />

      {/* Soft radial glow behind text - creates subtle "spotlight" effect */}
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background:
            'radial-gradient(ellipse 60% 50% at 50% 50%, var(--color-cream-primary) 0%, var(--color-cream-primary) 15%, transparent 65%)',
        }}
      />

      {/* Content */}
      <motion.div
        className="relative z-10 mx-auto max-w-4xl text-center"
        initial="hidden"
        animate="visible"
        variants={{
          hidden: {},
          visible: {
            transition: { staggerChildren: 0.1 },
          },
        }}
      >
        {/* Label */}
        <motion.p
          variants={REVEAL}
          className="text-2xs text-warm-gray-light mb-12 font-mono tracking-[0.2em] uppercase"
        >
          {label}
        </motion.p>

        {/* Headline — increased lineHeight to 1.0 to prevent ascender clipping */}
        <motion.h1
          variants={REVEAL}
          className="text-brand-orange mb-10 overflow-visible font-bold tracking-[-0.04em]"
          style={{
            fontSize: 'clamp(48px, 8vw, 96px)',
            lineHeight: 1.0,
          }}
        >
          {headline}
        </motion.h1>

        {/* Subhead - one paragraph, no line breaks */}
        <motion.p
          variants={REVEAL}
          className="text-warm-gray mx-auto mb-8 max-w-[540px] text-lg leading-[1.7] font-light"
        >
          {subhead}
        </motion.p>

        {/* Primary CTA with blinking cursor */}
        <motion.div variants={REVEAL}>
          <Link
            href={ctaHref}
            className="text-button text-brand-orange hover:text-brand-green transition-smooth inline-flex items-center font-mono tracking-[0.1em]"
            target="_blank"
            rel="noopener noreferrer"
          >
            {ctaText}
            <span className="cursor-blink" aria-hidden="true" />
          </Link>
        </motion.div>

        {/* Secondary CTA - docs link */}
        <motion.div variants={REVEAL} className="mt-6">
          <Link
            href="/docs/getting-started/quickstart"
            className="text-2xs text-warm-gray-light hover:text-brand-orange transition-smooth inline-flex items-center font-mono tracking-[0.1em]"
          >
            Watch it work &rarr;
          </Link>
        </motion.div>

        {/* Heartbeat pulse line */}
        <motion.div variants={REVEAL}>
          <PulseAnimation />
        </motion.div>

        {/* Product screenshot */}
        <motion.div variants={REVEAL} className="mx-auto mt-12 max-w-4xl">
          <Image
            src="/images/dorkos-screenshot.png"
            alt="DorkOS console with an active autonomous session"
            width={1280}
            height={800}
            className="shadow-elevated rounded-lg border border-[var(--border-warm)]"
            priority
          />
        </motion.div>
      </motion.div>

      {/* Subtle scan lines overlay */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0, 0, 0, 0.02) 2px, rgba(0, 0, 0, 0.02) 4px)',
        }}
      />
    </section>
  );
}
