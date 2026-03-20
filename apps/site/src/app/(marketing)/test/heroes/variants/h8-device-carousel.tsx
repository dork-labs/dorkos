'use client';

import { useState, useRef } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'motion/react';
import { REVEAL, STAGGER } from '@/layers/features/marketing/lib/motion-variants';

interface HeroProps {
  headline: string;
  subhead: string;
  ctaText: string;
  ctaHref: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BORDER = 'rgba(139, 90, 43, 0.12)';
const BORDER_LIGHT = 'rgba(139, 90, 43, 0.08)';
const ORANGE = '#E85D04';
const CHARCOAL = '#1A1814';
const CREAM_WHITE = '#FFFEFB';
const CREAM_PRIMARY = '#F5F0E6';
const CREAM_SECONDARY = '#EDE6D6';
const WARM_GRAY = '#7A756A';
const WARM_GRAY_MED = '#4A4640';
const GREEN = '#228B22';

// ---------------------------------------------------------------------------
// SVG Icons
// ---------------------------------------------------------------------------

function DeviceIcon({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      style={{ color: active ? ORANGE : WARM_GRAY }}
    >
      {children}
    </svg>
  );
}

function DesktopIcon({ active }: { active: boolean }) {
  return (
    <DeviceIcon active={active}>
      <rect x="1" y="2" width="14" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
      <path d="M5.5 13h5M8 11v2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </DeviceIcon>
  );
}

function TabletIcon({ active }: { active: boolean }) {
  return (
    <DeviceIcon active={active}>
      <rect
        x="2.5"
        y="1"
        width="11"
        height="14"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <circle cx="8" cy="13" r="0.75" fill="currentColor" />
    </DeviceIcon>
  );
}

function PhoneIcon({ active }: { active: boolean }) {
  return (
    <DeviceIcon active={active}>
      <rect x="4" y="1" width="8" height="14" rx="2" stroke="currentColor" strokeWidth="1.25" />
      <path d="M6.5 2.5h3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <circle cx="8" cy="13" r="0.75" fill="currentColor" />
    </DeviceIcon>
  );
}

// ---------------------------------------------------------------------------
// Shared DorkOS screen elements
// ---------------------------------------------------------------------------

/** Pulsing "Agent running..." status indicator. */
function AgentStatus() {
  return (
    <div
      className="flex items-center gap-1.5 rounded-[3px] px-2 py-1"
      style={{ background: CREAM_SECONDARY, border: `1px solid ${BORDER}` }}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full"
        style={{ background: GREEN }}
      />
      <span className="font-mono text-[9px] leading-none" style={{ color: WARM_GRAY }}>
        Agent running…
      </span>
    </div>
  );
}

/** Reusable chat message pair. Pass `compact` for tablet/phone sizes. */
function ChatMessages({ compact = false }: { compact?: boolean }) {
  const pad = compact ? 'px-2 py-1.5' : 'px-3 py-2';
  const size = compact ? 'text-[9px]' : 'text-[11px]';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <div
          className={`max-w-[78%] ${pad} rounded-[5px] rounded-tr-[2px] font-mono ${size} leading-[1.45]`}
          style={{ background: CHARCOAL, color: CREAM_PRIMARY }}
        >
          Fix the JWT refresh bug.
        </div>
      </div>
      <div className="flex justify-start">
        <div
          className={`max-w-[82%] ${pad} rounded-[5px] rounded-tl-[2px] ${size} leading-[1.55]`}
          style={{ background: CREAM_PRIMARY, color: WARM_GRAY_MED, border: `1px solid ${BORDER}` }}
        >
          {!compact && (
            <div
              className="mb-1 font-mono text-[9px] tracking-[0.1em] uppercase"
              style={{ color: ORANGE }}
            >
              Claude
            </div>
          )}
          Reading{' '}
          <code
            className="rounded-[2px] px-[3px] font-mono"
            style={{ background: CREAM_SECONDARY, fontSize: compact ? '8px' : '9px' }}
          >
            auth/middleware.ts
          </code>
          …
        </div>
      </div>
      <div
        className="flex items-center gap-1.5 rounded-[3px] px-2 py-1"
        style={{ background: CREAM_PRIMARY, border: `1px solid ${BORDER}` }}
      >
        <span
          className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full"
          style={{ background: GREEN }}
        />
        <span className="truncate font-mono text-[9px]" style={{ color: WARM_GRAY }}>
          Editing auth/middleware.ts
        </span>
      </div>
    </div>
  );
}

/** Shared input bar used by all device screens. */
function InputBar({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-t px-2 py-2"
      style={{ borderColor: BORDER_LIGHT }}
    >
      <div
        className="flex-1 rounded-[3px] px-2 py-1 font-mono text-[10px]"
        style={{ background: CREAM_PRIMARY, color: WARM_GRAY, border: `1px solid ${BORDER}` }}
      >
        {compact ? 'Message…' : 'Message Claude…'}
      </div>
      <div
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[3px]"
        style={{ background: ORANGE }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path
            d="M1 5h8M6 2l3 3-3 3"
            stroke={CREAM_WHITE}
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Device frame mockups
// ---------------------------------------------------------------------------

/** Full laptop frame — sidebar + main chat + status bar. */
function DesktopFrame() {
  const sessions = [
    { label: 'Fix auth middleware', active: true },
    { label: 'Refactor API routes', active: false },
    { label: 'Add test coverage', active: false },
  ];
  return (
    <div
      className="shadow-floating flex w-full flex-col overflow-hidden rounded-xl"
      style={{ background: CREAM_WHITE, border: `1px solid ${BORDER}`, maxHeight: '340px' }}
    >
      {/* Title bar */}
      <div
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2.5"
        style={{ background: CREAM_SECONDARY, borderColor: BORDER }}
      >
        <span className="h-2.5 w-2.5 rounded-full bg-[#FF5F57]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#FEBC2E]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#28C840]" />
        <div
          className="mx-auto max-w-[180px] flex-1 rounded-[3px] px-2 py-0.5 text-center font-mono text-[9px]"
          style={{ background: CREAM_PRIMARY, color: WARM_GRAY }}
        >
          localhost:4242
        </div>
      </div>
      {/* App body */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Sidebar */}
        <div
          className="flex w-[136px] shrink-0 flex-col border-r"
          style={{ background: CREAM_SECONDARY, borderColor: BORDER }}
        >
          <div className="shrink-0 border-b px-2.5 py-2" style={{ borderColor: BORDER }}>
            <span
              className="font-mono text-[8px] tracking-[0.14em] uppercase"
              style={{ color: WARM_GRAY }}
            >
              Sessions
            </span>
          </div>
          <div className="flex-1 overflow-hidden py-1">
            {sessions.map((s) => (
              <div
                key={s.label}
                className="mx-1 my-0.5 rounded-[3px] px-2.5 py-1.5"
                style={{
                  background: s.active ? CREAM_WHITE : 'transparent',
                  borderLeft: s.active ? `2px solid ${ORANGE}` : '2px solid transparent',
                }}
              >
                <div
                  className="truncate font-mono text-[9px]"
                  style={{ color: s.active ? CHARCOAL : WARM_GRAY }}
                >
                  {s.label}
                </div>
              </div>
            ))}
          </div>
          <div className="shrink-0 border-t p-1.5" style={{ borderColor: BORDER }}>
            <div
              className="rounded-[3px] py-1 text-center font-mono text-[8px]"
              style={{ background: ORANGE, color: CREAM_WHITE }}
            >
              + New
            </div>
          </div>
        </div>
        {/* Main */}
        <div className="flex min-w-0 flex-1 flex-col" style={{ background: CREAM_WHITE }}>
          <div
            className="flex shrink-0 items-center justify-between border-b px-3 py-2"
            style={{ borderColor: BORDER_LIGHT }}
          >
            <span className="font-mono text-[9px]" style={{ color: CHARCOAL }}>
              Fix auth middleware
            </span>
            <AgentStatus />
          </div>
          <div className="flex-1 overflow-hidden p-3">
            <ChatMessages />
          </div>
          <InputBar />
        </div>
      </div>
    </div>
  );
}

/** Tablet frame — icon rail + full-width chat. */
function TabletFrame() {
  return (
    <div
      className="shadow-floating mx-auto flex flex-col overflow-hidden rounded-xl"
      style={{
        background: CREAM_WHITE,
        border: `1px solid ${BORDER}`,
        width: '300px',
        maxHeight: '360px',
      }}
    >
      {/* Status bar */}
      <div
        className="flex shrink-0 items-center gap-1.5 border-b px-3 py-2"
        style={{ background: CREAM_SECONDARY, borderColor: BORDER }}
      >
        <span className="h-2 w-2 rounded-full bg-[#FF5F57]" />
        <span className="h-2 w-2 rounded-full bg-[#FEBC2E]" />
        <span className="h-2 w-2 rounded-full bg-[#28C840]" />
        <span className="ml-auto font-mono text-[8px]" style={{ color: WARM_GRAY }}>
          DorkOS
        </span>
      </div>
      {/* Body */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Icon rail */}
        <div
          className="flex w-9 shrink-0 flex-col items-center gap-2 border-r py-2"
          style={{ background: CREAM_SECONDARY, borderColor: BORDER }}
        >
          {[ORANGE, WARM_GRAY, WARM_GRAY].map((color, i) => (
            <div
              key={i}
              className="flex h-6 w-6 items-center justify-center rounded-[4px]"
              style={{
                background: i === 0 ? CREAM_WHITE : 'transparent',
                border: i === 0 ? `1px solid ${BORDER}` : 'none',
              }}
            >
              <div
                className="h-3 w-3 rounded-[2px]"
                style={{ background: color, opacity: i === 0 ? 1 : 0.4 }}
              />
            </div>
          ))}
        </div>
        {/* Chat */}
        <div className="flex min-w-0 flex-1 flex-col" style={{ background: CREAM_WHITE }}>
          <div
            className="flex shrink-0 items-center justify-between border-b px-2.5 py-1.5"
            style={{ borderColor: BORDER_LIGHT }}
          >
            <span className="font-mono text-[9px]" style={{ color: CHARCOAL }}>
              Fix auth middleware
            </span>
            <AgentStatus />
          </div>
          <div className="flex-1 overflow-hidden p-2.5">
            <ChatMessages compact />
          </div>
          <InputBar compact />
        </div>
      </div>
    </div>
  );
}

/** Phone frame — notch, full-height chat, bottom nav. */
function PhoneFrame() {
  return (
    <div
      className="shadow-floating mx-auto flex flex-col overflow-hidden rounded-[22px]"
      style={{
        background: CREAM_WHITE,
        border: `2px solid ${BORDER}`,
        width: '200px',
        maxHeight: '380px',
      }}
    >
      {/* Notch bar */}
      <div
        className="flex shrink-0 items-center justify-center pt-2 pb-1"
        style={{ background: CREAM_WHITE }}
      >
        <div className="h-3.5 w-16 rounded-full" style={{ background: CHARCOAL }} />
      </div>
      {/* Header */}
      <div
        className="flex shrink-0 items-center justify-between border-b px-3 py-1.5"
        style={{ borderColor: BORDER_LIGHT }}
      >
        <span className="font-mono text-[9px] font-medium" style={{ color: CHARCOAL }}>
          Session
        </span>
        <AgentStatus />
      </div>
      {/* Chat area */}
      <div className="flex-1 overflow-hidden p-2">
        <ChatMessages compact />
      </div>
      {/* Input */}
      <InputBar compact />
      {/* Bottom nav */}
      <div
        className="flex shrink-0 items-center justify-around border-t px-4 py-2"
        style={{ background: CREAM_SECONDARY, borderColor: BORDER }}
      >
        {[ORANGE, WARM_GRAY, WARM_GRAY].map((color, i) => (
          <div key={i} className="flex flex-col items-center gap-0.5">
            <div
              className="h-4 w-4 rounded-[3px]"
              style={{ background: color, opacity: i === 0 ? 1 : 0.35 }}
            />
            <div
              className="h-[2px] w-3 rounded-full"
              style={{ background: i === 0 ? ORANGE : WARM_GRAY, opacity: i === 0 ? 1 : 0.3 }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Device tab config
// ---------------------------------------------------------------------------

const DEVICES = [
  {
    id: 'desktop',
    label: 'Desktop',
    Icon: DesktopIcon,
    Frame: DesktopFrame,
  },
  {
    id: 'tablet',
    label: 'Tablet',
    Icon: TabletIcon,
    Frame: TabletFrame,
  },
  {
    id: 'phone',
    label: 'Phone',
    Icon: PhoneIcon,
    Frame: PhoneFrame,
  },
] as const;

// ---------------------------------------------------------------------------
// Carousel slide variants (direction-aware)
// ---------------------------------------------------------------------------

function slideVariants(direction: 1 | -1) {
  return {
    enter: { x: direction * 60, opacity: 0 },
    center: { x: 0, opacity: 1 },
    exit: { x: direction * -60, opacity: 0 },
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * HeroV8 — Interactive device carousel showing DorkOS on desktop, tablet, and phone.
 * Users click tabs or swipe to switch between device frames.
 */
export function HeroV8({ headline, subhead, ctaText, ctaHref }: HeroProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const pointerStartX = useRef<number | null>(null);

  function goTo(index: number) {
    setDirection(index > activeIndex ? 1 : -1);
    setActiveIndex(index);
  }

  function handlePointerDown(e: React.PointerEvent) {
    pointerStartX.current = e.clientX;
  }

  function handlePointerUp(e: React.PointerEvent) {
    if (pointerStartX.current === null) return;
    const delta = e.clientX - pointerStartX.current;
    pointerStartX.current = null;
    if (Math.abs(delta) < 40) return;
    if (delta < 0 && activeIndex < DEVICES.length - 1) {
      goTo(activeIndex + 1);
    } else if (delta > 0 && activeIndex > 0) {
      goTo(activeIndex - 1);
    }
  }

  const ActiveFrame = DEVICES[activeIndex].Frame;
  const variants = slideVariants(direction);

  return (
    <section className="bg-cream-primary relative flex min-h-[85vh] flex-col items-center justify-center overflow-hidden px-6 py-16">
      {/* Subtle dot-grid background */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: `radial-gradient(circle, rgba(139,90,43,0.18) 1px, transparent 1px)`,
          backgroundSize: '24px 24px',
          maskImage: 'radial-gradient(ellipse 80% 70% at 50% 50%, black 40%, transparent 100%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 80% 70% at 50% 50%, black 40%, transparent 100%)',
        }}
      />

      {/* Content wrapper */}
      <motion.div
        className="relative z-10 mx-auto flex w-full max-w-5xl flex-col items-center gap-10"
        initial="hidden"
        animate="visible"
        variants={STAGGER}
      >
        {/* Headline + subhead */}
        <div className="max-w-[640px] text-center">
          <motion.p
            variants={REVEAL}
            className="text-2xs text-brand-orange mb-4 font-mono tracking-[0.2em] uppercase"
          >
            Any device. Any screen.
          </motion.p>
          <motion.h1
            variants={REVEAL}
            className="text-charcoal mb-5 font-bold tracking-[-0.04em]"
            style={{ fontSize: 'clamp(32px, 5.5vw, 64px)', lineHeight: 1.05 }}
          >
            {headline}
          </motion.h1>
          <motion.p variants={REVEAL} className="text-warm-gray text-base leading-[1.7] font-light">
            {subhead}
          </motion.p>
        </div>

        {/* Device tab selector */}
        <motion.div
          variants={REVEAL}
          className="flex items-center gap-1 rounded-lg p-1"
          style={{ background: CREAM_SECONDARY, border: `1px solid ${BORDER}` }}
        >
          {DEVICES.map((device, i) => {
            const isActive = i === activeIndex;
            return (
              <button
                key={device.id}
                onClick={() => goTo(i)}
                className="text-button transition-smooth relative flex items-center gap-2 rounded-md px-4 py-2 font-mono tracking-[0.06em] focus-visible:ring-2 focus-visible:outline-none"
                style={{ color: isActive ? CHARCOAL : WARM_GRAY }}
                aria-pressed={isActive}
                aria-label={`View ${device.label} layout`}
              >
                {isActive && (
                  <motion.div
                    layoutId="device-tab-bg"
                    className="absolute inset-0 rounded-md"
                    style={{ background: CREAM_WHITE, border: `1px solid ${BORDER}` }}
                    transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                  />
                )}
                <span className="relative z-10">
                  <device.Icon active={isActive} />
                </span>
                <span className="relative z-10">{device.label}</span>
                {isActive && (
                  <motion.div
                    layoutId="device-tab-underline"
                    className="absolute bottom-0 left-1/2 h-[2px] w-8 -translate-x-1/2 rounded-full"
                    style={{ background: ORANGE }}
                    transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                  />
                )}
              </button>
            );
          })}
        </motion.div>

        {/* Device carousel */}
        <motion.div
          variants={REVEAL}
          className="w-full"
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          style={{ touchAction: 'pan-y', cursor: 'grab' }}
        >
          <AnimatePresence mode="wait" custom={direction} initial={false}>
            <motion.div
              key={activeIndex}
              custom={direction}
              variants={variants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className="flex w-full justify-center"
            >
              <div className="w-full">
                <ActiveFrame />
              </div>
            </motion.div>
          </AnimatePresence>
        </motion.div>

        {/* Dot indicators */}
        <motion.div variants={REVEAL} className="flex items-center gap-2">
          {DEVICES.map((_, i) => (
            <button
              key={i}
              onClick={() => goTo(i)}
              aria-label={`Go to ${DEVICES[i].label}`}
              className="transition-smooth rounded-full"
              style={{
                width: i === activeIndex ? '20px' : '6px',
                height: '6px',
                background: i === activeIndex ? ORANGE : 'rgba(139,90,43,0.25)',
              }}
            />
          ))}
        </motion.div>

        {/* CTAs */}
        <motion.div variants={REVEAL} className="flex flex-col items-center gap-5 sm:flex-row">
          <Link
            href={ctaHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-button text-brand-orange hover:text-brand-green transition-smooth inline-flex items-center font-mono tracking-[0.1em]"
          >
            {ctaText}
            <span className="cursor-blink" aria-hidden="true" />
          </Link>
          <span
            className="text-warm-gray-light text-2xs hidden font-mono sm:inline"
            aria-hidden="true"
          >
            ·
          </span>
          <Link
            href="/docs/getting-started/quickstart"
            className="text-2xs text-warm-gray-light hover:text-brand-orange transition-smooth inline-flex items-center font-mono tracking-[0.1em]"
          >
            Read the docs &rarr;
          </Link>
        </motion.div>
      </motion.div>
    </section>
  );
}
