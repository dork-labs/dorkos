'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { throttle } from 'lodash-es';
import { motion, useReducedMotion } from 'motion/react';
import { ArrowUp } from 'lucide-react';
import { PAGE_SECTIONS, PAGE_SECTION_IDS } from '../sections';
import { OverflowMenu } from './OverflowMenu';
import { SITE_LINKS } from './site-links';
import { useActiveSection } from './use-active-section';

/** Reading past this depth is a commitment to the page, so the pill starts yielding. */
const YIELD_AFTER_PX = 240;

/** This close to the end of the page counts as "arrived" — the pill comes back. */
const BOTTOM_ZONE_PX = 200;

/**
 * The floating pill, forked from the shared `MarketingNav` for this page only.
 *
 * WHY A FORK. `MarketingNav` is a signpost to other pages, and every marketing
 * surface shares it — including `/`, which must not change. This page needs a
 * different instrument: it is one scroll with five landmarks in it, so the
 * pill's entries are the landmarks, the pill shows which one you are standing
 * in, and the other pages fold behind an overflow button. Teaching the shared
 * component both jobs would put in-page anchors, a scroll-spy and a popup menu
 * into a component that eight routes render and only one of them wants.
 *
 * WHAT IS COPIED VERBATIM, so the two stay recognisably one thing: the pill's
 * shape and type, the yield-while-reading behaviour and its two thresholds,
 * the never-yield-out-from-under-focus rule, and the scroll-to-top arrow that
 * grows out of the right end past one viewport.
 *
 * WHAT IS NEW: the entries scroll rather than navigate, an orange rule slides
 * under the section you are in, and the site's other destinations live behind
 * "⋯". The Marketplace moved out of the pill entirely, to the footer, where
 * somewhere-you-go-once-you-run-DorkOS belongs.
 */
export function HomeNav() {
  const navRef = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [visible, setVisible] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const active = useActiveSection(PAGE_SECTION_IDS);

  // An open menu is the one thing that must outlive a scroll: the pill it
  // hangs off is what would be going inert underneath it. The scroll listener
  // is registered once and never re-registered, so it reads this rather than
  // closing over a stale `menuOpen`.
  const menuOpenRef = useRef(menuOpen);
  useEffect(() => {
    menuOpenRef.current = menuOpen;
  }, [menuOpen]);

  useEffect(() => {
    let lastScrollY = window.scrollY;

    const handleScroll = throttle(() => {
      const y = window.scrollY;
      const viewportHeight = window.innerHeight;

      setShowScrollTop(y > viewportHeight);

      const nearTop = y <= YIELD_AFTER_PX;
      const nearBottom =
        y + viewportHeight >= document.documentElement.scrollHeight - BOTTOM_ZONE_PX;
      const scrollingUp = y < lastScrollY;
      lastScrollY = y;

      // Never yield out from under a keyboard user: going inert while focus is
      // inside the pill blurs to <body>, which drops them back at the start of
      // the tab order. The next scroll after focus leaves settles it.
      const holdsFocus = navRef.current?.contains(document.activeElement) ?? false;

      setVisible(menuOpenRef.current || holdsFocus || nearTop || nearBottom || scrollingUp);
    }, 150);

    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();

    return () => {
      window.removeEventListener('scroll', handleScroll);
      handleScroll.cancel();
    };
  }, []);

  const scrollBehavior: ScrollBehavior = reduced ? 'auto' : 'smooth';

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: scrollBehavior });
  };

  const goToSection = useCallback(
    (id: string) => {
      const target = document.getElementById(id);
      if (!target) return;
      target.scrollIntoView({ behavior: scrollBehavior, block: 'start' });
      // The page moves, so the reader's place has to move with it. Every
      // section carries tabIndex={-1} for exactly this: without it a keyboard
      // visitor's next Tab resumes from the pill, three screens behind what
      // they are now looking at. `preventScroll` leaves the smooth scroll that
      // is already running alone.
      target.focus({ preventScroll: true });
    },
    [scrollBehavior]
  );

  return (
    <motion.nav
      ref={navRef}
      aria-label="Page sections"
      inert={!visible}
      initial={false}
      animate={{ opacity: visible ? 1 : 0 }}
      transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
      className={`fixed left-1/2 z-100 -translate-x-1/2 [[data-consent-banner-open]_&]:hidden ${
        visible ? '' : 'pointer-events-none'
      }`}
      style={{ bottom: '40px' }}
    >
      <ul className="bg-cream-white border-cream-secondary flex items-center rounded-[40px] border px-4 py-2 shadow-lg/5 sm:px-8">
        {PAGE_SECTIONS.map((section, index) => (
          <li
            key={section.id}
            className={`${index > 0 ? 'ml-4 sm:ml-8' : ''} ${
              section.yieldsOnMobile ? 'hidden sm:block' : ''
            }`}
          >
            <button
              type="button"
              onClick={() => goToSection(section.id)}
              aria-current={active === section.id ? 'true' : undefined}
              className={`text-2xs hover:text-brand-orange transition-smooth relative -top-0.5 cursor-pointer font-mono font-medium tracking-[0.04em] lowercase ${
                active === section.id ? 'text-charcoal' : 'text-warm-gray'
              }`}
            >
              {section.label}
              {active === section.id && (
                <motion.span
                  aria-hidden="true"
                  layoutId="home-nav-here"
                  transition={
                    reduced
                      ? { duration: 0 }
                      : { type: 'spring', stiffness: 420, damping: 34, mass: 0.7 }
                  }
                  className="bg-brand-orange absolute -bottom-1 left-0 h-px w-full"
                />
              )}
            </button>
          </li>
        ))}

        <li className="ml-4 flex items-center sm:ml-8">
          <OverflowMenu links={SITE_LINKS} open={menuOpen} onOpenChange={setMenuOpen} />
        </li>

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
            className="text-warm-gray hover:text-brand-orange transition-smooth flex cursor-pointer items-center justify-center"
            tabIndex={showScrollTop ? 0 : -1}
          >
            <ArrowUp size={12} strokeWidth={2.5} aria-hidden="true" />
          </button>
        </motion.li>
      </ul>
    </motion.nav>
  );
}
