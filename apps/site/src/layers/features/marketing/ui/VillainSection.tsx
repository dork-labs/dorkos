'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, useInView, useReducedMotion } from 'motion/react';
import { villainCards } from '../lib/villain-cards';
import { REVEAL, STAGGER, VIEWPORT } from '../lib/motion-variants';

// ─── Animated Card Art ───────────────────────────────────────────────────────

/** "Connection closed." types in letter-by-letter on viewport entry. */
function DeadTerminalArt() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, amount: 0.5 });
  const reducedMotion = useReducedMotion();
  const [displayText, setDisplayText] = useState('');
  const text = 'Connection closed.';
  const hasAnimated = useRef(false);

  useEffect(() => {
    if (!isInView || hasAnimated.current || reducedMotion) return;
    hasAnimated.current = true;
    let i = 0;
    const interval = setInterval(() => {
      i++;
      setDisplayText(text.slice(0, i));
      if (i >= text.length) clearInterval(interval);
    }, 40);
    return () => clearInterval(interval);
  }, [isInView, reducedMotion]);

  return (
    <div
      ref={ref}
      className="text-warm-gray-light/50 mb-4 font-mono text-[10px] leading-[1.6] select-none"
      aria-hidden="true"
    >
      <span className="text-warm-gray-light/40">$</span> claude &mdash;session refactor-auth
      <br />
      <span className="text-warm-gray-light/40">&check;</span> 47 files changed, tests passing
      <br />
      <span style={{ color: 'rgba(232, 93, 4, 0.5)' }}>
        {reducedMotion ? text : displayText || '\u00A0'}
      </span>
      {!reducedMotion && displayText.length > 0 && displayText.length < text.length && (
        <span className="cursor-blink" />
      )}
    </div>
  );
}

/** Text types "context..." then clears and restarts, looping. */
function GoldfishArt() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, amount: 0.5 });
  const reducedMotion = useReducedMotion();
  const [displayText, setDisplayText] = useState('Let me give you some contex');
  const text = 'Let me give you some context...';

  useEffect(() => {
    if (!isInView || reducedMotion) return;
    let i = 0;
    let clearing = false;

    const interval = setInterval(() => {
      if (clearing) {
        setDisplayText((prev) => {
          if (prev.length <= 0) {
            clearing = false;
            i = 0;
            return '';
          }
          return prev.slice(0, -1);
        });
      } else {
        i++;
        setDisplayText(text.slice(0, i));
        if (i >= text.length) {
          setTimeout(() => {
            clearing = true;
          }, 800);
        }
      }
    }, 50);

    return () => clearInterval(interval);
  }, [isInView, reducedMotion]);

  return (
    <div
      ref={ref}
      className="text-warm-gray-light/50 mb-4 font-mono text-[10px] leading-[1.6] select-none"
      aria-hidden="true"
    >
      <span className="text-warm-gray-light/30">&gt;</span> {displayText}
      <span className="cursor-blink" />
    </div>
  );
}

/** Bars randomly pulse opacity, one orange bar pulses urgently. */
function TabGraveyardArt() {
  return (
    <div className="mb-4 flex gap-1.5 select-none" aria-hidden="true">
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={i}
          className="h-2 rounded-full"
          style={{
            width: i < 3 ? '32px' : '20px',
            background: i === 2 ? 'rgba(232, 93, 4, 0.45)' : 'rgba(122, 117, 106, 0.22)',
            animation:
              i === 2
                ? 'tab-pulse-urgent 1.2s ease-in-out infinite'
                : `tab-pulse-idle ${2 + i * 0.7}s ease-in-out infinite`,
          }}
        />
      ))}
    </div>
  );
}

/** Small clock SVG with rotating hands. */
function ThreeAmBuildArt() {
  return (
    <div className="mb-4 flex items-center gap-2.5 select-none" aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" className="shrink-0">
        <circle cx="11" cy="11" r="9.5" stroke="rgba(122, 117, 106, 0.3)" strokeWidth="1" />
        {/* Hour hand */}
        <line
          x1="11"
          y1="11"
          x2="11"
          y2="6"
          stroke="rgba(122, 117, 106, 0.5)"
          strokeWidth="1.2"
          strokeLinecap="round"
          style={{ transformOrigin: '11px 11px', animation: 'clock-hour 12s linear infinite' }}
        />
        {/* Minute hand */}
        <line
          x1="11"
          y1="11"
          x2="11"
          y2="4"
          stroke="rgba(122, 117, 106, 0.35)"
          strokeWidth="0.8"
          strokeLinecap="round"
          style={{ transformOrigin: '11px 11px', animation: 'clock-minute 6s linear infinite' }}
        />
        <circle cx="11" cy="11" r="1.2" fill="rgba(232, 93, 4, 0.4)" />
      </svg>
      <div className="text-warm-gray-light/50 font-mono text-[10px] leading-[1.6]">
        <span style={{ color: 'rgba(232, 93, 4, 0.5)' }}>&cross;</span> Tests failed &mdash; 2:47am
        <br />
        <span className="text-warm-gray-light/30">
          fix: 3 lines &middot; agent: ready &middot; terminal: closed
        </span>
      </div>
    </div>
  );
}

const CARD_ART_COMPONENTS: Record<string, React.FC> = {
  'dead-terminal': DeadTerminalArt,
  goldfish: GoldfishArt,
  'tab-graveyard': TabGraveyardArt,
  '3am-build': ThreeAmBuildArt,
};

// ─── SpotlightCard ───────────────────────────────────────────────────────────

/** Card with cursor-following spotlight effect. */
function SpotlightCard({ children }: { children: React.ReactNode }) {
  const cardRef = useRef<HTMLElement>(null);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const el = cardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    el.style.setProperty('--spotlight-x', `${x}px`);
    el.style.setProperty('--spotlight-y', `${y}px`);
  }, []);

  return (
    <article
      ref={cardRef}
      onMouseMove={handleMouseMove}
      className="group relative overflow-hidden rounded-lg px-6 py-6"
      style={{
        background: '#FFFEFB',
        boxShadow: '0 1px 2px rgba(139, 90, 43, 0.04), 0 2px 8px rgba(139, 90, 43, 0.06)',
      }}
    >
      {/* Cursor-following radial gradient spotlight */}
      <div
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background:
            'radial-gradient(300px circle at var(--spotlight-x, 50%) var(--spotlight-y, 50%), rgba(232, 93, 4, 0.04), transparent 60%)',
        }}
      />
      <div className="relative z-10">{children}</div>
    </article>
  );
}

// ─── Main export ─────────────────────────────────────────────────────────────

/** Pain-point recognition section — four villain cards that name the problem. */
export function VillainSection() {
  return (
    <section className="bg-cream-primary px-8 py-16 md:py-28">
      <motion.div
        className="mx-auto max-w-3xl"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        <motion.div variants={REVEAL} className="mb-16 text-center">
          <h2 className="text-charcoal mb-4 text-[28px] leading-[1.3] font-medium tracking-[-0.02em] md:text-[32px]">
            What your agents do when you leave.
          </h2>
          <p className="text-warm-gray text-lg">Nothing.</p>
        </motion.div>

        <motion.div variants={STAGGER} className="space-y-10">
          {villainCards.map((card) => {
            const ArtComponent = CARD_ART_COMPONENTS[card.id];
            return (
              <motion.div key={card.id} variants={REVEAL}>
                <SpotlightCard>
                  {ArtComponent && <ArtComponent />}
                  <span className="text-md text-brand-orange mb-2 block font-mono tracking-[0.12em] uppercase">
                    {card.label}
                  </span>
                  {card.body.split('\n\n').map((paragraph, i) => (
                    <p key={i} className="text-warm-gray mb-3 text-[15px] leading-[1.75] last:mb-0">
                      {paragraph}
                    </p>
                  ))}
                  <p
                    className="text-brand-orange mt-5 pt-5 text-[14px] leading-[1.65] italic"
                    style={{ borderTop: '1px solid rgba(139, 90, 43, 0.1)' }}
                  >
                    {card.solution}
                  </p>
                </SpotlightCard>
              </motion.div>
            );
          })}
        </motion.div>

        <motion.div variants={REVEAL} className="mt-14 text-center">
          <div
            className="mx-auto max-w-xl"
            style={{ borderTop: '1px solid rgba(139, 90, 43, 0.1)' }}
          >
            <p className="text-charcoal pt-10 text-xl leading-[1.5] font-medium md:text-2xl">
              You pay for the most powerful coding agent ever built.
            </p>
            <p className="text-warm-gray text-xl leading-[1.5] font-medium md:text-2xl">
              It stops the moment you look away.
            </p>
          </div>
        </motion.div>
      </motion.div>
    </section>
  );
}
