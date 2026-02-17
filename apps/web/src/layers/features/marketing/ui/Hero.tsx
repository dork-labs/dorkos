import Image from 'next/image'
import Link from 'next/link'
import { PulseAnimation } from './PulseAnimation'

interface HeroProps {
  label?: string
  headline: string
  subhead: string
  ctaText: string
  ctaHref: string
}

export function Hero({
  label = 'Open Source',
  headline,
  subhead,
  ctaText,
  ctaHref,
}: HeroProps) {
  return (
    <section className="relative min-h-screen flex flex-col items-center justify-center px-6 pt-24">
      {/* Graph paper background - small + large grid with vertical fade */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: `
            linear-gradient(to right, rgba(139, 90, 43, 0.08) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(139, 90, 43, 0.08) 1px, transparent 1px),
            linear-gradient(to right, rgba(139, 90, 43, 0.15) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(139, 90, 43, 0.15) 1px, transparent 1px)
          `,
          backgroundSize: '20px 20px, 20px 20px, 100px 100px, 100px 100px',
          maskImage: 'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.5) 15%, rgba(0,0,0,1) 30%, rgba(0,0,0,1) 70%, rgba(0,0,0,0.5) 85%, transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.5) 15%, rgba(0,0,0,1) 30%, rgba(0,0,0,1) 70%, rgba(0,0,0,0.5) 85%, transparent 100%)',
        }}
      />

      {/* Soft radial glow behind text - creates subtle "spotlight" effect */}
      <div
        className="absolute inset-0 pointer-events-none opacity-70"
        style={{
          background: 'radial-gradient(ellipse 60% 50% at 50% 50%, var(--color-cream-primary) 0%, var(--color-cream-primary) 15%, transparent 65%)',
        }}
      />

      {/* Content */}
      <div className="relative z-10 text-center max-w-4xl mx-auto">
        {/* Label */}
        <p className="font-mono text-2xs tracking-[0.2em] uppercase text-warm-gray-light mb-12">
          {label}
        </p>

        {/* Headline — increased lineHeight to 1.0 to prevent ascender clipping */}
        <h1
          className="font-bold text-brand-orange mb-10 tracking-[-0.04em] overflow-visible"
          style={{
            fontSize: 'clamp(48px, 8vw, 96px)',
            lineHeight: 1.0,
          }}
        >
          {headline}
        </h1>

        {/* Subhead - one paragraph, no line breaks */}
        <p className="text-warm-gray text-lg font-light leading-[1.7] max-w-[540px] mx-auto mb-8">
          {subhead}
        </p>

        {/* Primary CTA with blinking cursor */}
        <Link
          href={ctaHref}
          className="inline-flex items-center font-mono text-button tracking-[0.1em] text-brand-orange hover:text-brand-green transition-smooth"
          target="_blank"
          rel="noopener noreferrer"
        >
          {ctaText}
          <span className="cursor-blink" aria-hidden="true" />
        </Link>

        {/* Secondary CTA - docs link */}
        <div className="mt-6">
          <Link
            href="/docs/getting-started/quickstart"
            className="inline-flex items-center font-mono text-2xs tracking-[0.1em] text-warm-gray-light hover:text-brand-orange transition-smooth"
          >
            Watch it work &rarr;
          </Link>
        </div>

        {/* Heartbeat pulse line */}
        <PulseAnimation />

        {/* Product screenshot */}
        <div className="mt-12 max-w-4xl mx-auto">
          <Image
            src="/images/dorkos-screenshot.png"
            alt="DorkOS console with an active autonomous session"
            width={1280}
            height={800}
            className="rounded-lg shadow-elevated border border-[var(--border-warm)]"
            priority
          />
        </div>
      </div>

      {/* Subtle scan lines overlay */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0, 0, 0, 0.02) 2px, rgba(0, 0, 0, 0.02) 4px)',
        }}
      />
    </section>
  )
}
