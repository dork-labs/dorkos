'use client';

import { useState, useEffect, useMemo } from 'react';
import { useEventListener } from 'usehooks-ts';
import { throttle } from 'lodash-es';
import { motion } from 'motion/react';
import { ArrowUp } from 'lucide-react';
import type { NavLink } from '../lib/types';

interface MarketingNavProps {
  links: NavLink[];
}

export function MarketingNav({ links }: MarketingNavProps) {
  const [showScrollTop, setShowScrollTop] = useState(false);

  // Throttled scroll handler - only runs once per 150ms for performance
  // Scroll events can fire 30-100+ times per second, throttling prevents excessive re-renders
  const handleScroll = useMemo(
    () =>
      throttle(() => {
        // Show arrow only after scrolling past the hero section (100vh)
        const pastHero = window.scrollY > window.innerHeight;
        setShowScrollTop(pastHero);
      }, 150),
    []
  );

  // Cancel pending throttled calls on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      handleScroll.cancel();
    };
  }, [handleScroll]);

  // useEventListener handles attaching/detaching automatically with proper cleanup
  // Using { passive: true } for better scroll performance
  useEventListener('scroll', handleScroll, undefined, { passive: true });

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <nav className="fixed left-1/2 z-100 -translate-x-1/2" style={{ bottom: '40px' }}>
      {/* Using explicit margins instead of gap to avoid extra space from hidden arrow */}
      <ul className="bg-cream-white border-cream-secondary flex items-center rounded-[40px] border px-8 py-2 shadow-lg/5">
        {links.map((link, index) => (
          <li key={link.href} className={index > 0 ? 'ml-8' : ''}>
            <a
              href={link.href}
              className="text-2xs text-warm-gray hover:text-brand-orange transition-smooth relative -top-0.5 font-mono font-medium tracking-[0.04em] lowercase"
            >
              {link.label}
            </a>
          </li>
        ))}

        {/* Scroll to top arrow - width animates from 0 to create expanding effect */}
        <motion.li
          initial={false}
          animate={{
            width: showScrollTop ? 12 : 0,
            opacity: showScrollTop ? 1 : 0,
            marginLeft: showScrollTop ? 32 : 0,
          }}
          transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
          className="flex items-center overflow-hidden"
        >
          <button
            onClick={scrollToTop}
            aria-label="Scroll to top"
            className="text-warm-gray hover:text-brand-orange transition-smooth flex items-center justify-center"
            tabIndex={showScrollTop ? 0 : -1}
          >
            <ArrowUp size={12} strokeWidth={2.5} />
          </button>
        </motion.li>
      </ul>
    </nav>
  );
}
