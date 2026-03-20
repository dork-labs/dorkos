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

// ─── Notification bubbles ────────────────────────────────────────────────────

interface BubbleData {
  icon: string;
  text: string;
  delay: number;
  floatOffset: number;
}

const BUBBLES: BubbleData[] = [
  { icon: '✓', text: '3 PRs merged', delay: 0.1, floatOffset: 0 },
  { icon: '📝', text: 'Docs updated', delay: 0.22, floatOffset: 4 },
  { icon: '🧪', text: 'Tests passing', delay: 0.34, floatOffset: -3 },
  { icon: '⚡', text: 'Deployed v2.1', delay: 0.46, floatOffset: 5 },
];

function NotificationBubble({ bubble, index }: { bubble: BubbleData; index: number }) {
  return (
    <motion.div
      variants={REVEAL}
      custom={index}
      animate={{
        y: [bubble.floatOffset, bubble.floatOffset - 6, bubble.floatOffset],
        transition: {
          duration: 3.2 + index * 0.4,
          repeat: Infinity,
          ease: 'easeInOut',
          delay: index * 0.7,
        },
      }}
      className="bg-cream-white shadow-floating inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-warm)] px-3 py-2 whitespace-nowrap"
    >
      <span className="text-xs leading-none" aria-hidden="true">
        {bubble.icon}
      </span>
      <span className="text-2xs text-charcoal font-mono font-medium tracking-wide">
        {bubble.text}
      </span>
      <span
        className="bg-brand-green ml-1 h-1.5 w-1.5 flex-shrink-0 rounded-full"
        aria-hidden="true"
      />
    </motion.div>
  );
}

// ─── DorkOS laptop screen mini-UI ────────────────────────────────────────────

function LaptopScreen() {
  return (
    <g>
      {/* Screen background */}
      <rect x="192" y="176" width="176" height="112" rx="2" fill="#1A1814" />

      {/* Top bar */}
      <rect x="192" y="176" width="176" height="16" rx="2" fill="#2A2520" />
      <circle cx="202" cy="184" r="3" fill="#E85D04" opacity="0.8" />
      <circle cx="212" cy="184" r="3" fill="#E8A004" opacity="0.6" />
      <circle cx="222" cy="184" r="3" fill="#228B22" opacity="0.6" />

      {/* Brand label in titlebar */}
      <text
        x="255"
        y="187.5"
        fontSize="6"
        fill="#7A756A"
        fontFamily="monospace"
        textAnchor="middle"
      >
        DorkOS
      </text>

      {/* Sidebar */}
      <rect x="192" y="192" width="32" height="96" fill="#211E1A" />

      {/* Sidebar items */}
      <rect x="198" y="200" width="20" height="5" rx="1.5" fill="#3A3530" />
      <rect x="198" y="210" width="14" height="5" rx="1.5" fill="#E85D04" opacity="0.9" />
      <rect x="198" y="220" width="18" height="5" rx="1.5" fill="#3A3530" />
      <rect x="198" y="230" width="12" height="5" rx="1.5" fill="#3A3530" />

      {/* Main content area */}
      {/* Chat message - user */}
      <rect x="232" y="198" width="60" height="8" rx="2" fill="#3A3530" />
      <rect x="232" y="208" width="44" height="6" rx="2" fill="#3A3530" />

      {/* Chat message - agent (orange accent) */}
      <rect x="232" y="222" width="52" height="6" rx="2" fill="#E85D04" opacity="0.25" />
      <rect x="232" y="231" width="68" height="6" rx="2" fill="#E85D04" opacity="0.18" />
      <rect x="232" y="240" width="40" height="6" rx="2" fill="#E85D04" opacity="0.12" />

      {/* Blinking cursor line */}
      <rect x="232" y="254" width="28" height="5" rx="1.5" fill="#3A3530" opacity="0.6" />
      <rect x="262" y="254" width="2" height="5" rx="1" fill="#E85D04" opacity="0.9" />

      {/* Status bar */}
      <rect x="192" y="284" width="176" height="4" rx="0" fill="#2A2520" />
      <rect x="196" y="285.5" width="8" height="1" rx="0.5" fill="#228B22" />
      <rect x="206" y="285.5" width="12" height="1" rx="0.5" fill="#7A756A" />
      <rect x="352" y="285.5" width="12" height="1" rx="0.5" fill="#7A756A" />
    </g>
  );
}

// ─── Scene illustration (SVG) ─────────────────────────────────────────────────

function TravelSceneIllustration() {
  return (
    <svg
      viewBox="0 0 560 420"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="h-auto w-full"
      aria-label="Person at a cafe window using DorkOS on a laptop while agents work autonomously"
      role="img"
    >
      {/* ── Background wall / window area ── */}
      <rect width="560" height="420" fill="#EDE6D6" />

      {/* Large window frame */}
      <rect
        x="60"
        y="40"
        width="440"
        height="240"
        rx="8"
        fill="#E5DCC8"
        stroke="#C8BEA8"
        strokeWidth="2"
      />

      {/* Window glass — sky gradient */}
      <defs>
        <linearGradient id="skyGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#B8D4E8" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#D4E8D4" stopOpacity="0.7" />
        </linearGradient>
        <linearGradient id="tableGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#C8BEA8" />
          <stop offset="100%" stopColor="#B8AE98" />
        </linearGradient>
        <linearGradient id="laptopBodyGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#4A4640" />
          <stop offset="100%" stopColor="#2A2520" />
        </linearGradient>
        <linearGradient id="screenLid" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3A3530" />
          <stop offset="100%" stopColor="#1A1814" />
        </linearGradient>
        <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="4" stdDeviation="8" floodColor="#1A1814" floodOpacity="0.15" />
        </filter>
        <filter id="windowGlow">
          <feGaussianBlur stdDeviation="6" />
        </filter>
      </defs>

      {/* Window glass panes */}
      <rect x="68" y="48" width="210" height="224" rx="4" fill="url(#skyGrad)" />
      <rect x="286" y="48" width="206" height="224" rx="4" fill="url(#skyGrad)" />

      {/* Window divider bar */}
      <rect x="277" y="48" width="6" height="224" fill="#C8BEA8" />
      {/* Horizontal bar */}
      <rect x="68" y="156" width="424" height="5" fill="#C8BEA8" />

      {/* Distant clouds in window */}
      <ellipse cx="130" cy="90" rx="40" ry="14" fill="white" opacity="0.7" />
      <ellipse cx="160" cy="82" rx="28" ry="12" fill="white" opacity="0.7" />
      <ellipse cx="370" cy="100" rx="36" ry="12" fill="white" opacity="0.65" />
      <ellipse cx="400" cy="92" rx="24" ry="10" fill="white" opacity="0.65" />

      {/* Distant city skyline silhouette */}
      <rect x="80" y="188" width="12" height="72" rx="2" fill="#4A90A4" opacity="0.3" />
      <rect x="96" y="172" width="16" height="88" rx="2" fill="#4A90A4" opacity="0.25" />
      <rect x="116" y="196" width="10" height="64" rx="2" fill="#4A90A4" opacity="0.28" />
      <rect x="130" y="180" width="14" height="80" rx="2" fill="#4A90A4" opacity="0.22" />
      <rect x="380" y="190" width="12" height="70" rx="2" fill="#4A90A4" opacity="0.25" />
      <rect x="396" y="174" width="16" height="86" rx="2" fill="#4A90A4" opacity="0.22" />
      <rect x="416" y="198" width="10" height="62" rx="2" fill="#4A90A4" opacity="0.28" />
      <rect x="430" y="182" width="14" height="78" rx="2" fill="#4A90A4" opacity="0.2" />

      {/* Airplane in upper right window pane */}
      <g transform="translate(460, 75) rotate(-15)" opacity="0.55">
        <rect x="-16" y="-3" width="32" height="6" rx="3" fill="#7A756A" />
        <polygon points="12,-3 22,0 12,3" fill="#7A756A" />
        <rect x="-6" y="-10" width="12" height="7" rx="1" fill="#7A756A" />
        <rect x="-4" y="3" width="8" height="5" rx="1" fill="#7A756A" />
      </g>

      {/* ── Floor / wall below window ── */}
      <rect x="0" y="280" width="560" height="140" fill="#DDD6C4" />
      {/* Baseboard */}
      <rect x="0" y="277" width="560" height="6" fill="#C8BEA8" />

      {/* ── Table surface ── */}
      <rect
        x="80"
        y="296"
        width="400"
        height="20"
        rx="4"
        fill="url(#tableGrad)"
        filter="url(#softShadow)"
      />
      {/* Table legs */}
      <rect x="100" y="316" width="12" height="90" rx="2" fill="#B8AE98" />
      <rect x="448" y="316" width="12" height="90" rx="2" fill="#B8AE98" />

      {/* ── Laptop (open, slight perspective) ── */}
      {/* Screen lid — angled top portion */}
      <g filter="url(#softShadow)">
        {/* Lid back face */}
        <path d="M168 160 L392 160 L406 296 L154 296 Z" fill="url(#laptopBodyGrad)" />
        {/* Lid front face (screen side) */}
        <path d="M174 164 L386 164 L400 292 L160 292 Z" fill="#211E1A" />
        {/* Screen bezel */}
        <path d="M182 170 L378 170 L392 286 L168 286 Z" fill="#1A1814" />
      </g>

      {/* Laptop screen content — positioned within the lid */}
      <LaptopScreen />

      {/* Laptop base (keyboard) */}
      <g filter="url(#softShadow)">
        <path d="M140 296 L420 296 L426 316 L134 316 Z" fill="#3A3530" />
        {/* Keyboard rows suggestion */}
        <path d="M152 300 L408 300 L412 312 L148 312 Z" fill="#2A2520" opacity="0.8" />
        {/* Key rows */}
        <rect x="160" y="303" width="200" height="3" rx="1" fill="#4A4640" opacity="0.6" />
        <rect x="164" y="308" width="192" height="3" rx="1" fill="#4A4640" opacity="0.6" />
        {/* Trackpad */}
        <rect x="255" y="302" width="48" height="9" rx="2" fill="#3A3530" opacity="0.8" />
      </g>

      {/* ── Coffee cup ── */}
      <g transform="translate(440, 260)">
        {/* Cup body */}
        <path d="M0 0 L4 50 L36 50 L40 0 Z" fill="#FFFEFB" stroke="#C8BEA8" strokeWidth="1.5" />
        {/* Handle */}
        <path
          d="M38 10 Q54 10 54 25 Q54 40 38 40"
          fill="none"
          stroke="#C8BEA8"
          strokeWidth="2"
          strokeLinecap="round"
        />
        {/* Coffee liquid */}
        <path d="M2 4 L5 46 L35 46 L38 4 Z" fill="#8B5A2B" opacity="0.35" />
        {/* Cup rim */}
        <rect
          x="0"
          y="0"
          width="40"
          height="5"
          rx="1"
          fill="#EDE6D6"
          stroke="#C8BEA8"
          strokeWidth="1"
        />
        {/* Steam wisps */}
        <path
          d="M12 -6 Q16 -14 12 -22"
          stroke="#C8BEA8"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
          opacity="0.6"
        />
        <path
          d="M20 -8 Q24 -18 20 -28"
          stroke="#C8BEA8"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
          opacity="0.5"
        />
        <path
          d="M28 -5 Q32 -15 28 -23"
          stroke="#C8BEA8"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
          opacity="0.55"
        />
      </g>

      {/* ── Boarding pass / passport ── */}
      <g transform="translate(84, 268)" filter="url(#softShadow)">
        {/* Boarding pass card */}
        <rect width="68" height="38" rx="4" fill="#FFFEFB" stroke="#E5DCC8" strokeWidth="1" />
        {/* Dashed perforation line */}
        <line
          x1="44"
          y1="4"
          x2="44"
          y2="34"
          stroke="#C8BEA8"
          strokeWidth="1"
          strokeDasharray="3 2"
        />
        {/* Left section text bars */}
        <rect x="6" y="8" width="28" height="3" rx="1" fill="#E85D04" opacity="0.7" />
        <rect x="6" y="14" width="20" height="2.5" rx="1" fill="#C8BEA8" />
        <rect x="6" y="20" width="24" height="2.5" rx="1" fill="#C8BEA8" />
        <rect x="6" y="26" width="16" height="2.5" rx="1" fill="#C8BEA8" />
        {/* Seat/gate label */}
        <rect x="8" y="30" width="10" height="4" rx="1" fill="#E85D04" opacity="0.5" />
        {/* Right section — barcode-like lines */}
        <rect x="48" y="8" width="2" height="22" rx="0.5" fill="#C8BEA8" />
        <rect x="52" y="8" width="1" height="22" rx="0.5" fill="#C8BEA8" />
        <rect x="55" y="8" width="2" height="22" rx="0.5" fill="#C8BEA8" />
        <rect x="59" y="8" width="1" height="22" rx="0.5" fill="#C8BEA8" />
        <rect x="62" y="8" width="2" height="22" rx="0.5" fill="#C8BEA8" />
      </g>

      {/* ── Person silhouette (minimal, geometric) ── */}
      {/* Head */}
      <circle cx="120" cy="220" r="22" fill="#8B7BA4" opacity="0.85" />
      {/* Neck */}
      <rect x="112" y="240" width="16" height="12" rx="3" fill="#8B7BA4" opacity="0.8" />
      {/* Torso / sweater */}
      <path
        d="M92 252 Q98 248 120 248 Q142 248 148 252 L152 296 L88 296 Z"
        fill="#8B7BA4"
        opacity="0.8"
      />
      {/* Left arm reaching to laptop */}
      <path
        d="M92 262 Q72 272 112 286"
        stroke="#8B7BA4"
        strokeWidth="16"
        strokeLinecap="round"
        fill="none"
        opacity="0.75"
      />
      {/* Right arm */}
      <path
        d="M148 262 Q162 272 174 284"
        stroke="#8B7BA4"
        strokeWidth="14"
        strokeLinecap="round"
        fill="none"
        opacity="0.75"
      />

      {/* ── Subtle glow behind laptop screen (ambient light) ── */}
      <ellipse
        cx="280"
        cy="228"
        rx="100"
        ry="40"
        fill="#E85D04"
        opacity="0.04"
        filter="url(#windowGlow)"
      />
    </svg>
  );
}

// ─── Floating notification cluster ───────────────────────────────────────────

function NotificationCluster() {
  return (
    <motion.div
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.3 }}
      variants={STAGGER}
      className="flex flex-wrap justify-center gap-2 lg:justify-start"
      aria-label="Active agent notifications"
    >
      {BUBBLES.map((bubble, i) => (
        <NotificationBubble key={bubble.text} bubble={bubble} index={i} />
      ))}
    </motion.div>
  );
}

// ─── Headline / CTA panel ────────────────────────────────────────────────────

interface ContentPanelProps {
  headline: string;
  subhead: string;
  ctaText: string;
  ctaHref: string;
}

function ContentPanel({ headline, subhead, ctaText, ctaHref }: ContentPanelProps) {
  return (
    <motion.div
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.2 }}
      variants={STAGGER}
      className="flex flex-col justify-center gap-8 lg:pr-12"
    >
      {/* Eyebrow label */}
      <motion.span
        variants={REVEAL}
        className="text-2xs text-brand-orange self-start font-mono tracking-[0.2em] uppercase"
      >
        Work from anywhere
      </motion.span>

      {/* Headline */}
      <motion.h1
        variants={REVEAL}
        className="text-charcoal leading-[1.0] font-bold tracking-[-0.04em] text-balance"
        style={{ fontSize: 'clamp(36px, 5.5vw, 72px)' }}
      >
        {headline}
      </motion.h1>

      {/* Subhead */}
      <motion.p
        variants={REVEAL}
        className="text-warm-gray max-w-[480px] text-lg leading-[1.7] font-light"
      >
        {subhead}
      </motion.p>

      {/* Notification bubbles — proof of autonomous work */}
      <motion.div variants={REVEAL} className="space-y-3">
        <p className="text-2xs text-warm-gray-light font-mono tracking-[0.12em] uppercase">
          While you were boarding
        </p>
        <NotificationCluster />
      </motion.div>

      {/* CTA */}
      <motion.div variants={REVEAL} className="flex flex-col items-start gap-4 sm:flex-row">
        <Link
          href={ctaHref}
          target="_blank"
          rel="noopener noreferrer"
          className="bg-charcoal text-cream-white text-button hover:bg-brand-orange transition-smooth inline-flex items-center gap-2 rounded-sm px-6 py-3.5 font-mono tracking-[0.08em] uppercase"
        >
          {ctaText}
          <span className="cursor-blink" aria-hidden="true" />
        </Link>
        <Link
          href="/docs/getting-started/quickstart"
          className="text-2xs text-warm-gray-light hover:text-brand-orange transition-smooth inline-flex items-center self-center font-mono tracking-[0.1em] uppercase"
        >
          See it in action &rarr;
        </Link>
      </motion.div>
    </motion.div>
  );
}

// ─── Illustration panel ───────────────────────────────────────────────────────

function IllustrationPanel() {
  return (
    <motion.div
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.2 }}
      variants={REVEAL}
      className="relative mx-auto w-full max-w-[560px] lg:mx-0"
    >
      {/* Warm halo behind scene */}
      <div
        className="pointer-events-none absolute inset-0 rounded-2xl"
        style={{
          background:
            'radial-gradient(ellipse 70% 55% at 50% 60%, rgba(232, 93, 4, 0.07) 0%, transparent 70%)',
        }}
        aria-hidden="true"
      />

      {/* The scene */}
      <TravelSceneIllustration />

      {/* Caption below illustration */}
      <p className="text-2xs text-warm-gray-light mt-4 text-center font-mono tracking-[0.12em] uppercase">
        Your flight took off. Your agents never stopped.
      </p>
    </motion.div>
  );
}

// ─── Root hero component ──────────────────────────────────────────────────────

/**
 * HeroV6 — Travel Scene hero variant.
 *
 * Illustrates a person at an airport cafe using DorkOS on a laptop
 * while floating notification bubbles prove that agents kept working
 * autonomously throughout their journey.
 */
export function HeroV6({ headline, subhead, ctaText, ctaHref }: HeroProps) {
  return (
    <section
      className="bg-cream-primary relative flex min-h-[85vh] items-center overflow-hidden"
      aria-label="Hero: Work from anywhere with DorkOS"
    >
      {/* Subtle warm grid pattern */}
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
        style={{
          backgroundImage: `
            linear-gradient(to right, rgba(139, 90, 43, 0.05) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(139, 90, 43, 0.05) 1px, transparent 1px)
          `,
          backgroundSize: '40px 40px',
          maskImage:
            'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.4) 20%, rgba(0,0,0,1) 40%, rgba(0,0,0,1) 80%, transparent 100%)',
          WebkitMaskImage:
            'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.4) 20%, rgba(0,0,0,1) 40%, rgba(0,0,0,1) 80%, transparent 100%)',
        }}
      />

      {/* Cream vignette edges */}
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
        style={{
          background:
            'radial-gradient(ellipse 90% 90% at 50% 50%, transparent 50%, var(--color-cream-primary) 100%)',
        }}
      />

      {/* Content grid */}
      <div className="relative z-10 mx-auto w-full max-w-7xl px-6 py-20 sm:px-10 lg:px-16 lg:py-28">
        <div className="grid grid-cols-1 items-center gap-16 lg:grid-cols-2 lg:gap-10">
          {/* Left: Headline + CTA */}
          <ContentPanel headline={headline} subhead={subhead} ctaText={ctaText} ctaHref={ctaHref} />

          {/* Right: Illustration */}
          <IllustrationPanel />
        </div>
      </div>
    </section>
  );
}
