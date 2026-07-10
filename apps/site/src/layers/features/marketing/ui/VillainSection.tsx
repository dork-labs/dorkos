'use client';

import { useCallback, useRef } from 'react';
import { motion } from 'motion/react';
import { villainCards } from '../lib/villain-cards';
import { REVEAL, STAGGER, VIEWPORT } from '../lib/motion-variants';

// ─── Animated Card Art ───────────────────────────────────────────────────────
//
// Each card opens with a small UI vignette of its pain: monospaced, muted
// warm-gray, exactly one orange accent, readable in under a second.

/** One mini window in the scattered-windows vignette. */
function MiniWindow({
  label,
  left,
  top,
  depth,
  urgent,
}: {
  label: string;
  left: number;
  top: number;
  /** 0 = back of the stack (dimmest), 1 = front. */
  depth: number;
  urgent?: boolean;
}) {
  const chrome = `rgba(122, 117, 106, ${0.18 + depth * 0.14})`;
  return (
    <div
      className="absolute w-24 rounded-[5px] border"
      style={{
        left,
        top,
        borderColor: chrome,
        background: '#FFFEFB',
        boxShadow: '0 1px 3px rgba(139, 90, 43, 0.07)',
      }}
    >
      <div
        className="flex items-center gap-1.5 border-b px-1.5 py-1"
        style={{ borderColor: `rgba(122, 117, 106, ${0.12 + depth * 0.1})` }}
      >
        <span
          className="size-1.5 shrink-0 rounded-full"
          style={
            urgent
              ? {
                  background: 'rgba(232, 93, 4, 0.65)',
                  animation: 'villain-dot-pulse 1.4s ease-in-out infinite',
                }
              : { background: `rgba(122, 117, 106, ${0.2 + depth * 0.15})` }
          }
        />
        <span
          className="font-mono text-[8px] leading-none tracking-[0.08em]"
          style={{ color: `rgba(122, 117, 106, ${0.45 + depth * 0.3})` }}
        >
          {label}
        </span>
      </div>
      <div className="space-y-1 px-1.5 py-1.5">
        <div
          className="h-1 w-3/4 rounded-full"
          style={{ background: `rgba(122, 117, 106, ${0.1 + depth * 0.06})` }}
        />
        <div
          className="h-1 w-1/2 rounded-full"
          style={{ background: `rgba(122, 117, 106, ${0.07 + depth * 0.05})` }}
        />
      </div>
    </div>
  );
}

/** Three overlapping runtime windows; the half-buried one pulses for attention. */
function TabGraveyardArt() {
  return (
    <div className="relative mb-5 h-[58px] select-none" aria-hidden="true">
      <MiniWindow label="claude" left={0} top={10} depth={0} urgent />
      <MiniWindow label="codex" left={74} top={4} depth={0.5} />
      <MiniWindow label="opencode" left={148} top={0} depth={1} />
    </div>
  );
}

/** A select control that can't select — one vendor, locked shut. */
function VendorBetArt() {
  return (
    <div className="mb-5 select-none" aria-hidden="true">
      <div
        className="inline-flex items-center gap-5 rounded-[5px] border px-2.5 py-1.5"
        style={{ borderColor: 'rgba(122, 117, 106, 0.3)', background: '#FFFEFB' }}
      >
        <span className="text-warm-gray-light/80 font-mono text-[10px] leading-none">
          agent: that-one-cli
        </span>
        {/* Padlock where the dropdown chevron should be */}
        <svg width="9" height="11" viewBox="0 0 9 11" fill="none" className="shrink-0">
          <rect
            x="0.75"
            y="4.75"
            width="7.5"
            height="5.5"
            rx="1.25"
            stroke="rgba(232, 93, 4, 0.6)"
            strokeWidth="1"
          />
          <path d="M2.5 4.5V3a2 2 0 1 1 4 0v1.5" stroke="rgba(232, 93, 4, 0.6)" strokeWidth="1" />
        </svg>
      </div>
      <div className="text-warm-gray-light/40 mt-1.5 font-mono text-[10px] leading-[1.6]">
        alternatives: none &middot; switching cost: everything
      </div>
    </div>
  );
}

/** The frozen permission prompt itself — a caret blinking at nobody. */
function StuckWaitingArt() {
  return (
    <div className="mb-5 font-mono text-[10px] leading-[1.8] select-none" aria-hidden="true">
      <div className="text-warm-gray-light/80">
        <span className="text-warm-gray-light/45">&#10095;</span> approve file edit?{' '}
        <span className="text-warm-gray-light/55">[y/n]</span>{' '}
        <span
          className="ml-0.5 inline-block h-[11px] w-[5px] align-[-1px]"
          style={{
            background: 'rgba(232, 93, 4, 0.6)',
            animation: 'villain-caret-blink 1.1s step-end infinite',
          }}
        />
      </div>
      <div className="text-warm-gray-light/40">agent: blocked &middot; waiting on: you</div>
    </div>
  );
}

const CARD_ART_COMPONENTS: Record<string, React.FC> = {
  'tab-graveyard': TabGraveyardArt,
  'vendor-bet': VendorBetArt,
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
            Ten agents. One of you.
          </h2>
          <p className="text-warm-gray text-lg">
            Each one can do the work of a person. Keeping up with all of them became your job.
          </p>
        </motion.div>

        <motion.div variants={STAGGER} className="space-y-10">
          {villainCards.map((card) => {
            const ArtComponent = CARD_ART_COMPONENTS[card.id];
            return (
              <motion.div key={card.id} variants={REVEAL}>
                <SpotlightCard>
                  {ArtComponent && <ArtComponent />}
                  <h3 className="text-brand-orange mb-2.5 font-mono text-[13px] leading-[1.6] font-medium tracking-[0.12em] uppercase">
                    {card.label}
                  </h3>
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

        <motion.div variants={STAGGER} className="mt-14 text-center">
          <div
            className="mx-auto max-w-xl"
            style={{ borderTop: '1px solid rgba(139, 90, 43, 0.1)' }}
          >
            <motion.p
              variants={REVEAL}
              className="text-charcoal pt-10 text-xl leading-[1.5] font-medium md:text-2xl"
            >
              You run the smartest agents ever built.
            </motion.p>
            <motion.p
              variants={REVEAL}
              className="text-warm-gray text-xl leading-[1.5] font-medium md:text-2xl"
            >
              Running them shouldn&rsquo;t be the hard part.
            </motion.p>
            <motion.p
              variants={REVEAL}
              className="text-brand-orange mt-6 text-xl leading-[1.5] font-semibold md:text-2xl"
            >
              That&rsquo;s the part we fixed.
            </motion.p>
          </div>
        </motion.div>
      </motion.div>
    </section>
  );
}
