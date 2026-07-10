'use client';

import { useCallback, useRef } from 'react';
import { motion } from 'motion/react';
import { villainCards } from '../lib/villain-cards';
import { REVEAL, STAGGER, VIEWPORT } from '../lib/motion-variants';

// ─── Animated Card Art ───────────────────────────────────────────────────────

/** Bars pulse at random opacity; one orange bar pulses urgently. */
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
                ? 'tab-tasks-urgent 1.2s ease-in-out infinite'
                : `tab-tasks-idle ${2 + i * 0.7}s ease-in-out infinite`,
          }}
        />
      ))}
    </div>
  );
}

/** Small clock SVG with rotating hands. */
function StuckWaitingArt() {
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
        <span style={{ color: 'rgba(232, 93, 4, 0.5)' }}>?</span> &ldquo;Can I edit this
        file?&rdquo; asked at 12:10pm
        <br />
        <span className="text-warm-gray-light/30">
          agent: waiting &middot; you: at lunch &middot; elapsed: 40m
        </span>
      </div>
    </div>
  );
}

const CARD_ART_COMPONENTS: Record<string, React.FC> = {
  'tab-graveyard': TabGraveyardArt,
  'stuck-waiting': StuckWaitingArt,
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

/** Pain-point recognition section — three villain cards that name the problem plainly. */
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
            You became the integration layer.
          </h2>
          <p className="text-warm-gray text-lg">
            Between every agent and every tool, the wiring is you.
          </p>
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
              You run the most capable agents ever built.
            </p>
            <p className="text-warm-gray text-xl leading-[1.5] font-medium md:text-2xl">
              And you&apos;re the one holding them together.
            </p>
          </div>
        </motion.div>
      </motion.div>
    </section>
  );
}
