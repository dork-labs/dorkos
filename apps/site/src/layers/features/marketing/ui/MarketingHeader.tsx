'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { DorkLogo } from '@dorkos/icons/logos';

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
      <div className="flex w-full items-center justify-between">
        <div className="w-16" />
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
        <Link
          href="/docs"
          className="text-2xs text-warm-gray-light hover:text-brand-orange transition-smooth w-16 text-right font-mono tracking-[0.15em] uppercase"
        >
          Docs
        </Link>
      </div>
    </header>
  );
}
