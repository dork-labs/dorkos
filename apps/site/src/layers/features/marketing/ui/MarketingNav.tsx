'use client';

import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { throttle } from 'lodash-es';
import { motion } from 'motion/react';
import { ArrowUp } from 'lucide-react';
import type { NavLink } from '../lib/types';
import { isNavLinkActive } from '../lib/nav-links';

interface MarketingNavProps {
  links: NavLink[];
}

/** Reading past this depth is a commitment to the page, so the pill starts yielding. */
const YIELD_AFTER_PX = 240;

/** This close to the end of the page counts as "arrived" — the pill comes back. */
const BOTTOM_ZONE_PX = 200;

export function MarketingNav({ links }: MarketingNavProps) {
  const pathname = usePathname();
  const [showScrollTop, setShowScrollTop] = useState(false);
  // The pill floats over the page, so anything it covers is unreadable and
  // unclickable. It steps aside while you read downward and returns the moment
  // you scroll back up, reach the top, or arrive at the end of the page.
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    // Scroll direction is the listener's own bookkeeping, so it lives in the
    // effect's closure — nothing rendered depends on it between frames.
    let lastScrollY = window.scrollY;

    // Throttled scroll handler - only runs once per 150ms for performance
    // Scroll events can fire 30-100+ times per second, throttling prevents excessive re-renders
    const handleScroll = throttle(() => {
      const y = window.scrollY;
      const viewportHeight = window.innerHeight;

      // Show arrow only after scrolling past the hero section (100vh)
      setShowScrollTop(y > viewportHeight);

      const nearTop = y <= YIELD_AFTER_PX;
      const nearBottom =
        y + viewportHeight >= document.documentElement.scrollHeight - BOTTOM_ZONE_PX;
      const scrollingUp = y < lastScrollY;
      lastScrollY = y;
      setVisible(nearTop || nearBottom || scrollingUp);
    }, 150);

    // Using { passive: true } for better scroll performance
    window.addEventListener('scroll', handleScroll, { passive: true });
    // Settle the initial state for a page opened partway down.
    handleScroll();

    return () => {
      window.removeEventListener('scroll', handleScroll);
      // Cancel pending throttled calls to prevent memory leaks
      handleScroll.cancel();
    };
  }, []);

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    // Hide while the cookie banner is open (it flags <html> with
    // data-consent-banner-open) so the pill never overlaps the banner.
    // While yielded: `pointer-events-none` lets clicks reach the content the
    // pill sits over, and `inert` keeps it out of the tab order and the
    // accessibility tree.
    <motion.nav
      aria-label="Site sections"
      inert={!visible}
      initial={false}
      animate={{ opacity: visible ? 1 : 0 }}
      transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
      className={`fixed left-1/2 z-100 -translate-x-1/2 [[data-consent-banner-open]_&]:hidden ${
        visible ? '' : 'pointer-events-none'
      }`}
      style={{ bottom: '40px' }}
    >
      {/* Using explicit margins instead of gap to avoid extra space from hidden arrow */}
      <ul className="bg-cream-white border-cream-secondary flex items-center rounded-[40px] border px-4 py-2 shadow-lg/5 sm:px-8">
        {links.map((link, index) => {
          const active = isNavLinkActive(pathname, link.href);
          // Home is duplicated by the always-present header logo, so it yields
          // on the narrowest screens to keep the pill inside the viewport.
          const isHome = link.href === '/';
          return (
            <li
              key={link.href}
              className={`${index > 0 ? 'ml-4 sm:ml-8' : ''} ${isHome ? 'hidden sm:block' : ''}`}
            >
              <a
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className={`text-2xs hover:text-brand-orange transition-smooth relative -top-0.5 font-mono font-medium tracking-[0.04em] lowercase ${
                  active ? 'text-charcoal' : 'text-warm-gray'
                }`}
              >
                {link.label}
              </a>
            </li>
          );
        })}

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
    </motion.nav>
  );
}
