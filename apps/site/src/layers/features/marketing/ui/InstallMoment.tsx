'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { motion, useInView, useReducedMotion } from 'motion/react';
import { Copy, Check, Download, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { trackHeroInstallCopy, trackHeroDownload, type InstallMethod } from '@/lib/analytics';
import { REVEAL, STAGGER, VIEWPORT } from '../lib/motion-variants';
import { usePlatform, type Platform } from '../lib/use-platform';

const SCRAMBLE_CHARS = '!@#$%&*_+-=<>?~';
/** Frame cadence for the scramble effect. */
const SCRAMBLE_FRAME_MS = 20;
/** Frames each successive character waits before settling. Longest command settles under 1s. */
const SCRAMBLE_SETTLE_STEP = 1;

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
    description: 'Requires Node.js 22+.',
    recommended: false,
  },
  // Homebrew returns as a tab once the dorkos-ai/tap tap is published.
  // Until then, listing it here would hand people a command that 404s.
] as const;

/** The terminal one-liner — the launch-critical native install path. */
const CURL_COMMAND = INSTALL_METHODS[0].command;

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
        const settleAt = (i + 1) * SCRAMBLE_SETTLE_STEP;
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
    }, SCRAMBLE_FRAME_MS);

    return () => clearInterval(interval);
  }, [text]);

  useEffect(() => {
    if (!isActive || reducedMotion) return;
    return scramble();
  }, [isActive, reducedMotion, scramble]);

  return display;
}

/**
 * A refined, still-copyable command chip — the install one-liner offered quietly,
 * not as a form field. Borderless save for a whisper of warm tint, an orange
 * `$` prompt echoing the main terminal, and a copy glyph that stays subtle
 * until hover/focus. Always copies the real command with check confirmation;
 * the long string scrolls within the chip rather than overflowing on mobile.
 */
function TerminalPeerCommand({
  command,
  method,
  className,
}: {
  command: string;
  method: InstallMethod;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    // Only confirm once the write lands — insecure contexts reject.
    navigator.clipboard.writeText(command).then(
      () => {
        trackHeroInstallCopy(method);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {}
    );
  }, [command, method]);

  return (
    <div
      className={cn(
        'group inline-flex max-w-full items-center gap-3 rounded-lg bg-[rgba(139,90,43,0.05)] px-4 py-2.5',
        className
      )}
    >
      <code className="text-charcoal min-w-0 overflow-x-auto font-mono text-[13px] whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <span style={{ color: '#E85D04' }}>$ </span>
        {command}
      </code>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? 'Command copied' : `Copy command: ${command}`}
        className="text-warm-gray-light hover:text-brand-orange focus-visible:ring-brand-orange/40 shrink-0 rounded p-1 opacity-70 transition-all group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:outline-none"
      >
        {copied ? (
          <Check size={13} style={{ color: '#228B22' }} />
        ) : (
          <Copy size={13} aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

/**
 * Collapsed-by-default disclosure of the remaining install paths — npm (only
 * when it isn't already a primary tab) plus honest per-platform notes. A native
 * `<details>`/`<summary>` so it is keyboard-accessible and works without JS.
 *
 * `currentPlatform` suppresses the note for whichever platform already has
 * its own hero above (no point telling a Windows visitor to go download
 * Windows). Homebrew is intentionally absent: the `dorkos-ai/tap` tap
 * doesn't exist yet, so offering it would hand people a command that 404s.
 */
function OtherWaysToInstall({
  showNpm,
  currentPlatform,
}: {
  showNpm: boolean;
  currentPlatform: Platform;
}) {
  return (
    <details className="group mx-auto mt-8 w-full max-w-md text-left">
      <summary className="text-warm-gray-light hover:text-brand-orange focus-visible:ring-brand-orange/40 flex cursor-pointer list-none items-center justify-center gap-1.5 rounded font-mono text-xs tracking-[0.04em] transition-colors focus-visible:ring-2 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
        Other ways to install
        <ChevronDown
          size={13}
          className="transition-transform duration-200 group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>

      <div className="mt-4 space-y-4">
        {showNpm && (
          <div className="space-y-1.5">
            <p className="text-charcoal font-mono text-[11px] tracking-[0.08em] uppercase">npm</p>
            <TerminalPeerCommand command="npm install -g dorkos" method="npm" />
            <p className="text-warm-gray-light font-mono text-[11px]">Requires Node 22+.</p>
          </div>
        )}

        <ul className="space-y-2">
          {currentPlatform !== 'windows' && (
            <li className="text-warm-gray-light font-mono text-[11px] leading-relaxed">
              <span className="text-charcoal">Windows</span> —{' '}
              <a
                href="/download/windows"
                onClick={() => trackHeroDownload('windows_other_ways')}
                className="text-brand-orange hover:underline"
              >
                download the alpha installer
              </a>
              , or use the terminal today.
            </li>
          )}
          <li className="text-warm-gray-light font-mono text-[11px] leading-relaxed">
            <span className="text-charcoal">Linux</span> — install with the one-liner or npm; the
            web cockpit runs the same everywhere.
          </li>
          <li className="text-warm-gray-light font-mono text-[11px] leading-relaxed">
            <span className="text-charcoal">Server</span> — running DorkOS somewhere other than your
            own machine?{' '}
            <Link href="/docs/self-hosting/docker" className="text-brand-orange hover:underline">
              Run it in Docker
            </Link>
            .
          </li>
        </ul>
      </div>
    </details>
  );
}

/**
 * macOS visitor's hero — the desktop download leads, with the terminal
 * one-liner a quiet but respected peer directly below (never buried, always
 * copyable). The build is Apple-Silicon only, so we say so plainly and point
 * Intel Macs back at the terminal.
 */
function DownloadHero() {
  return (
    <div className="flex flex-col items-center">
      <a
        href="/download/mac"
        onClick={() => trackHeroDownload('hero')}
        className="marketing-btn bg-brand-orange text-cream-white inline-flex items-center gap-2.5"
      >
        <Download size={18} aria-hidden="true" />
        Download for Mac
      </a>
      <p className="text-warm-gray-light mt-3 font-mono text-xs tracking-[0.02em]">
        Apple Silicon · no terminal needed
      </p>
      <Link
        href="/docs/getting-started/desktop-app"
        className="text-warm-gray-light hover:text-brand-orange transition-smooth mt-2 font-mono text-[11px] tracking-[0.02em]"
      >
        What you get →
      </Link>

      {/* Terminal one-liner — a respected peer, not a footnote. */}
      <div className="mt-10 flex w-full max-w-md flex-col items-center gap-2">
        <p className="text-warm-gray-light font-mono text-xs tracking-[0.04em]">
          Prefer the terminal?
        </p>
        <TerminalPeerCommand command={CURL_COMMAND} method="curl" />
        <p className="text-warm-gray-light font-mono text-[11px] tracking-[0.02em]">
          On an Intel Mac? This works everywhere.
        </p>
      </div>

      <OtherWaysToInstall showNpm currentPlatform="mac" />
    </div>
  );
}

/**
 * Windows visitor's hero — mirrors the Mac download hero: the desktop
 * download leads, with the terminal one-liner a quiet, still-copyable peer
 * directly below. The build is an unsigned early alpha with no verified
 * end-to-end install yet (demo-claim gate, AGENTS.md), so the button carries
 * a visible "alpha" tag and the subtitle says so plainly — SmartScreen will
 * warn on first launch until the build is signed.
 */
function WindowsDownloadHero() {
  return (
    <div className="flex flex-col items-center">
      <a
        href="/download/windows"
        onClick={() => trackHeroDownload('windows_hero')}
        className="marketing-btn bg-brand-orange text-cream-white inline-flex items-center gap-2.5"
      >
        <Download size={18} aria-hidden="true" />
        Download for Windows
        <span className="text-cream-white rounded-sm bg-white/[0.18] px-1.5 py-0.5 text-[9px] tracking-[0.1em] uppercase">
          alpha
        </span>
      </a>
      <p className="text-warm-gray-light mt-3 font-mono text-xs tracking-[0.02em]">
        Windows x64 · unsigned early alpha — SmartScreen may warn on first launch
      </p>
      <Link
        href="/docs/getting-started/desktop-app"
        className="text-warm-gray-light hover:text-brand-orange transition-smooth mt-2 font-mono text-[11px] tracking-[0.02em]"
      >
        What you get →
      </Link>

      {/* Terminal one-liner — a respected peer, not a footnote. */}
      <div className="mt-10 flex w-full max-w-md flex-col items-center gap-2">
        <p className="text-warm-gray-light font-mono text-xs tracking-[0.04em]">
          Prefer the terminal?
        </p>
        <TerminalPeerCommand command={CURL_COMMAND} method="curl" />
      </div>

      <OtherWaysToInstall showNpm currentPlatform="windows" />
    </div>
  );
}

/**
 * Visitor's hero on anything but Mac or Windows — and the stable
 * pre-hydration default — where the terminal one-liner leads inside the
 * tabbed terminal mockup, since there is no native download to offer them. A
 * subtle "Desktop app for macOS" link stays available for anyone browsing
 * from the wrong machine.
 *
 * @param isInView - Whether the section has scrolled into view (drives the scramble).
 */
function TerminalHero({ isInView }: { isInView: boolean }) {
  const [activeTab, setActiveTab] = useState<(typeof INSTALL_METHODS)[number]['id']>('curl');
  const [copied, setCopied] = useState(false);

  const activeMethod = INSTALL_METHODS.find((m) => m.id === activeTab)!;
  const displayText = useTextScramble(CURL_COMMAND, isInView && activeTab === 'curl');

  const handleCopy = useCallback(() => {
    // Always copy the real command, never the scrambled display text — and only
    // confirm once the write actually succeeds (insecure contexts reject).
    navigator.clipboard.writeText(activeMethod.command).then(
      () => {
        trackHeroInstallCopy(activeMethod.id as InstallMethod);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {}
    );
  }, [activeMethod.command, activeMethod.id]);

  return (
    <div>
      {/* Tab bar */}
      <div className="mb-4 flex items-center justify-center gap-1">
        {INSTALL_METHODS.map((method) => (
          <button
            key={method.id}
            onClick={() => {
              setActiveTab(method.id);
              setCopied(false);
            }}
            className={`focus-visible:ring-brand-orange/40 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-mono text-xs tracking-[0.06em] transition-all focus-visible:ring-2 focus-visible:outline-none ${
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
      </div>

      {/* Terminal mockup */}
      <div className="mb-3">
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
            <span className="font-mono text-[10px] tracking-[0.06em]" style={{ color: '#7A756A' }}>
              Terminal
            </span>
            <button
              onClick={handleCopy}
              className="focus-visible:ring-brand-orange/40 flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:outline-none"
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
      </div>

      {/* "Run in terminal" hint + description */}
      <div className="mb-6">
        <p className="text-warm-gray-light mb-1 font-mono text-xs tracking-[0.04em]">
          Run in your terminal
        </p>
        <p className="text-warm-gray-light font-mono text-sm">{activeMethod.description}</p>
      </div>

      {/* Native download stays one subtle link away for anyone on the wrong machine. */}
      <a
        href="/download/mac"
        onClick={() => trackHeroDownload('terminal_hero_link')}
        className="text-warm-gray-light hover:text-brand-orange transition-smooth inline-flex items-center gap-1.5 font-mono text-xs tracking-[0.04em]"
      >
        <Download size={13} aria-hidden="true" />
        Desktop app for macOS
        <span aria-hidden="true">→</span>
      </a>

      <OtherWaysToInstall showNpm={false} currentPlatform="other" />
    </div>
  );
}

/**
 * Combined install + close section — the "Get started." moment. OS-adaptive:
 * macOS and Windows visitors lead with the desktop download (terminal one-liner
 * a respected peer below); everyone else leads with the terminal one-liner in a
 * mockup. The pre-hydration render is the terminal hero (works for all), then it
 * gracefully enhances to the matching download hero once the platform resolves.
 */
export function InstallMoment() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });
  const reducedMotion = useReducedMotion();
  const platform = usePlatform();

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
        {/* Eyebrow — neutral so it reads right above a download button or a command alike. */}
        <motion.p
          variants={REVEAL}
          className="text-warm-gray mb-6 text-lg leading-[1.5] md:text-xl"
        >
          Your fleet is one step away.
        </motion.p>

        <motion.p
          variants={REVEAL}
          className="text-brand-orange mb-6 font-mono text-[48px] leading-none font-bold tracking-[-0.03em] md:text-[72px]"
        >
          Get started
          <span className="cursor-blink" aria-hidden="true" />.
        </motion.p>

        {/*
          OS-adaptive hero. The terminal hero is the stable default rendered
          server-side and pre-hydration (`'unknown'`); once platform detection
          settles to `'mac'` or `'windows'`, it gracefully enhances to the
          matching download hero with a gentle fade (reduced-motion respected).
          No content flash; the only shift is this fade.
        */}
        <motion.div variants={REVEAL} className="mb-10">
          {platform === 'mac' || platform === 'windows' ? (
            <motion.div
              initial={reducedMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
            >
              {platform === 'mac' ? <DownloadHero /> : <WindowsDownloadHero />}
            </motion.div>
          ) : (
            <TerminalHero isInView={isInView} />
          )}
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
