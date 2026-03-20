'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { motion, useInView, useReducedMotion } from 'motion/react';
import { Copy, Check } from 'lucide-react';
import { REVEAL, STAGGER, VIEWPORT } from '../lib/motion-variants';

const SCRAMBLE_CHARS = '!@#$%&*_+-=<>?~';

const INSTALL_METHODS = [
  {
    id: 'curl',
    label: 'One-liner',
    command: 'curl -fsSL https://dorkos.ai/install | bash',
    description: 'Checks Node.js, installs via npm, offers setup wizard.',
    recommended: true,
  },
  {
    id: 'npm',
    label: 'npm',
    command: 'npm install -g dorkos',
    description: 'Requires Node.js 18+.',
    recommended: false,
  },
  {
    id: 'brew',
    label: 'Homebrew',
    command: 'brew install dorkos-ai/tap/dorkos',
    description: 'macOS and Linux. Updates via brew upgrade.',
    recommended: false,
  },
] as const;

/**
 * Scramble/decode effect — each position cycles through random characters
 * before settling on the real character. Creates a "system booting" feel.
 */
function useTextScramble(text: string, isActive: boolean) {
  const reducedMotion = useReducedMotion();
  const [display, setDisplay] = useState(text);
  const hasRun = useRef(false);

  const scramble = useCallback(() => {
    if (hasRun.current) return;
    hasRun.current = true;

    const chars = text.split('');
    const settled = new Array(chars.length).fill(false);
    let frame = 0;

    const interval = setInterval(() => {
      frame++;
      const result = chars.map((char, i) => {
        if (char === ' ') return ' ';
        const settleAt = (i + 1) * 3;
        if (frame >= settleAt) {
          settled[i] = true;
          return char;
        }
        return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
      });

      setDisplay(result.join(''));

      if (settled.every(Boolean)) {
        clearInterval(interval);
      }
    }, 30);

    return () => clearInterval(interval);
  }, [text]);

  useEffect(() => {
    if (!isActive || reducedMotion) return;
    return scramble();
  }, [isActive, reducedMotion, scramble]);

  return display;
}

/** Combined install + close section — "Ready." headline with tabbed install in a terminal mockup. */
export function InstallMoment() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });
  const [activeTab, setActiveTab] = useState('curl');
  const [copied, setCopied] = useState(false);

  const activeMethod = INSTALL_METHODS.find((m) => m.id === activeTab)!;
  const displayText = useTextScramble(INSTALL_METHODS[0].command, isInView && activeTab === 'curl');

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(activeMethod.command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [activeMethod.command]);

  return (
    <section id="install" ref={ref} className="bg-cream-primary relative px-8 py-14 md:py-24">
      {/* Graph-paper background */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: `
            linear-gradient(to right, rgba(139, 90, 43, 0.07) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(139, 90, 43, 0.07) 1px, transparent 1px)
          `,
          backgroundSize: '32px 32px',
          maskImage:
            'linear-gradient(to bottom, transparent 0%, black 30%, black 70%, transparent 100%)',
          WebkitMaskImage:
            'linear-gradient(to bottom, transparent 0%, black 30%, black 70%, transparent 100%)',
        }}
      />

      <motion.div
        className="relative z-10 mx-auto max-w-xl text-center"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        {/* Headline */}
        <motion.p
          variants={REVEAL}
          className="text-warm-gray mb-6 text-lg leading-[1.5] md:text-xl"
        >
          Your agents are ready. Give them the night.
        </motion.p>

        <motion.p
          variants={REVEAL}
          className="text-brand-orange mb-10 font-mono text-[48px] leading-none font-bold tracking-[-0.03em] md:text-[72px]"
        >
          Get started
          <span className="cursor-blink" aria-hidden="true" />.
        </motion.p>

        {/* Tab bar */}
        <motion.div variants={REVEAL} className="mb-4 flex items-center justify-center gap-1">
          {INSTALL_METHODS.map((method) => (
            <button
              key={method.id}
              onClick={() => {
                setActiveTab(method.id);
                setCopied(false);
              }}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-mono text-xs tracking-[0.06em] transition-all ${
                activeTab === method.id
                  ? 'bg-charcoal text-cream'
                  : 'text-warm-gray-light hover:text-charcoal'
              }`}
            >
              {method.label}
              {method.recommended && (
                <span
                  className="rounded-sm px-1 py-px text-[8px] tracking-[0.1em] uppercase"
                  style={{
                    background:
                      activeTab === method.id ? 'rgba(255,255,255,0.15)' : 'rgba(232, 93, 4, 0.1)',
                    color: activeTab === method.id ? '#FFFEFB' : '#E85D04',
                  }}
                >
                  recommended
                </span>
              )}
            </button>
          ))}
        </motion.div>

        {/* Terminal mockup */}
        <motion.div variants={REVEAL} className="mb-3">
          <div
            className="mx-auto max-w-lg overflow-hidden rounded-lg"
            style={{
              border: '1px solid rgba(139, 90, 43, 0.12)',
              background: '#1A1814',
              boxShadow: '0 1px 3px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.12)',
            }}
          >
            {/* Terminal title bar */}
            <div
              className="flex items-center justify-between px-3 py-2"
              style={{ background: '#252220', borderBottom: '1px solid rgba(255,255,255,0.06)' }}
            >
              <div className="flex items-center gap-1.5">
                <div
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: '#E85D04', opacity: 0.5 }}
                />
                <div
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: '#7A756A', opacity: 0.3 }}
                />
                <div
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: '#7A756A', opacity: 0.3 }}
                />
              </div>
              <span
                className="font-mono text-[10px] tracking-[0.06em]"
                style={{ color: '#7A756A' }}
              >
                Terminal
              </span>
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-white/10"
                aria-label="Copy command"
              >
                {copied ? (
                  <Check size={12} style={{ color: '#228B22' }} />
                ) : (
                  <Copy size={12} style={{ color: '#7A756A' }} />
                )}
                <span
                  className="font-mono text-[10px]"
                  style={{ color: copied ? '#228B22' : '#7A756A' }}
                >
                  {copied ? 'copied' : 'copy'}
                </span>
              </button>
            </div>

            {/* Terminal body */}
            <div className="px-4 py-4">
              <p className="text-left font-mono text-sm md:text-base" style={{ color: '#F5F0E6' }}>
                <span style={{ color: '#E85D04' }}>~ </span>
                <span style={{ color: '#7A756A' }}>$ </span>
                {activeTab === 'curl' ? displayText : activeMethod.command}
                <span className="cursor-blink" aria-hidden="true" />
              </p>
            </div>
          </div>
        </motion.div>

        {/* "Run in terminal" hint + description */}
        <motion.div variants={REVEAL} className="mb-10">
          <p className="text-warm-gray-light mb-1 font-mono text-xs tracking-[0.04em]">
            Run in your terminal
          </p>
          <p className="text-warm-gray-light font-mono text-sm">{activeMethod.description}</p>
        </motion.div>

        {/* Badges */}
        <motion.div
          variants={REVEAL}
          className="mb-6 flex flex-wrap items-center justify-center gap-2"
        >
          {['Open Source', 'MIT Licensed', 'Runs on Your Machine'].map((badge) => (
            <span
              key={badge}
              className="rounded-[3px] px-2 py-0.5 font-mono text-[9px] tracking-[0.08em] uppercase"
              style={{
                background: 'rgba(232, 93, 4, 0.06)',
                color: '#7A756A',
                border: '1px solid rgba(232, 93, 4, 0.12)',
              }}
            >
              {badge}
            </span>
          ))}
        </motion.div>

        <motion.p variants={REVEAL} className="text-charcoal mb-2 text-lg font-medium">
          One person. Ten agents. Ship around the clock.
        </motion.p>

        <motion.div variants={REVEAL} className="mt-8 flex items-center justify-center gap-6">
          <Link
            href="/docs/getting-started/quickstart"
            className="text-button text-warm-gray-light hover:text-brand-orange transition-smooth font-mono tracking-[0.08em]"
          >
            Read the docs
          </Link>
        </motion.div>
      </motion.div>
    </section>
  );
}
