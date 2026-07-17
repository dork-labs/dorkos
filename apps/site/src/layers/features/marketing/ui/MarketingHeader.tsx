'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { DorkLogo } from '@dorkos/icons/logos';
import { GITHUB_OUTBOUND_HREF } from '@/config/site';
import { trackGithubClick, trackGetStartedNav } from '@/lib/analytics';

/** GitHub mark — lucide dropped its brand glyph, so inline the official path. */
function GitHubMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
    </svg>
  );
}

export function MarketingHeader() {
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    let ticking = false;
    const scrollThreshold = 50;

    const handleScroll = () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          setIsScrolled(window.scrollY > scrollThreshold);
          ticking = false;
        });
        ticking = true;
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    // Check initial state
    handleScroll();

    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <header
      className="bg-cream-primary fixed top-0 right-0 left-0 z-40 px-6 transition-all duration-500 ease-out"
      style={{
        paddingTop: isScrolled ? '12px' : '20px',
        paddingBottom: isScrolled ? '12px' : '20px',
      }}
    >
      {/* Equal-width flanks (`flex-1`) keep the logo dead-center regardless of
          how wide the right-hand CTA cluster grows. */}
      <div className="flex w-full items-center justify-between gap-3">
        <div className="flex flex-1 items-center">
          <a
            href={GITHUB_OUTBOUND_HREF}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="DorkOS on GitHub"
            onClick={() => trackGithubClick('header')}
            className="text-warm-gray-light hover:text-brand-orange transition-smooth flex items-center"
          >
            <GitHubMark />
          </a>
        </div>
        <Link href="/" className="flex flex-col items-center gap-1.5">
          <DorkLogo
            size={120}
            className="w-auto transition-all duration-500 ease-out"
            style={{ height: isScrolled ? '28px' : '40px' }}
          />
          <span
            className="text-warm-gray-light overflow-hidden font-mono text-xs tracking-[0.15em] transition-all duration-500 ease-out"
            style={{
              opacity: isScrolled ? 0 : 1,
              maxHeight: isScrolled ? '0px' : '20px',
              marginTop: isScrolled ? '0px' : '6px',
            }}
          >
            DorkOS
          </span>
        </Link>
        <div className="flex flex-1 items-center justify-end gap-4 sm:gap-5">
          {/* Docs is duplicated in the bottom pill nav, so it yields on the
              narrowest screens to keep the CTA from ever overflowing. */}
          <Link
            href="/docs"
            className="text-2xs text-warm-gray-light hover:text-brand-orange transition-smooth hidden font-mono tracking-[0.15em] uppercase sm:inline"
          >
            Docs
          </Link>
          <Link
            href="/install"
            onClick={trackGetStartedNav}
            className="bg-brand-orange text-cream-white text-2xs focus-visible:ring-brand-orange/50 inline-flex items-center gap-1.5 rounded-md px-3.5 py-2 font-mono font-medium tracking-[0.08em] uppercase transition-colors hover:bg-[#C94E00] focus-visible:ring-2 focus-visible:outline-none"
          >
            Get started
          </Link>
        </div>
      </div>
    </header>
  );
}
