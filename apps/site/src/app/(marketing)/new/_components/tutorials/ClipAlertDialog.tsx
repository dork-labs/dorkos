'use client';

import { useCallback, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, useReducedMotion } from 'motion/react';
import { X } from 'lucide-react';
import { NewsletterSignupForm } from '@/layers/shared/ui/newsletter-signup';
import { PANEL } from '../film-tokens';
import type { TutorialRailConfig } from './tutorials';

/** Everything a keyboard can land on. The trap cycles this list and nothing else. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** How long the panel takes to arrive, when the visitor allows animation at all. */
const ENTER_SECONDS = 0.16;

interface ClipAlertDialogProps {
  /** The rail's words. Everything the panel says arrives through here. */
  alert: TutorialRailConfig['alert'];
  /** The tile that was pressed, named at the top of the panel. */
  cardTitle: string;
  /** Close it. */
  onClose: () => void;
  /** The tile's button, so the visitor lands back where they left. */
  restoreFocusTo: HTMLElement | null;
}

/**
 * Hold focus inside the panel and hand it back on the way out.
 *
 * Three separate obligations, and they are together because they share one
 * lifetime. Focus moves into the panel on open, so a keyboard visitor is
 * looking at what they just summoned rather than three screens above it. The
 * page behind stops scrolling, because a dialog over a moving page is a dialog
 * the visitor cannot read. And focus returns to the exact tile that opened
 * this, which is the part nobody notices until it is missing: without it a
 * press on the fourth tile ends with the next Tab resuming from the top of the
 * document.
 *
 * The trigger is passed in rather than read from `document.activeElement`,
 * because Safari does not focus a button when it is clicked, so the element
 * that opened the panel is frequently not the focused one.
 */
function useDialogFocus(
  panelRef: React.RefObject<HTMLDivElement | null>,
  restoreFocusTo: HTMLElement | null
): void {
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });

    const { body, documentElement } = document;
    const previousOverflow = body.style.overflow;
    const previousPadding = body.style.paddingRight;
    // Compensate for the scrollbar the lock removes, or the page jumps sideways.
    const scrollbar = window.innerWidth - documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;

    return () => {
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPadding;
      restoreFocusTo?.focus({ preventScroll: true });
    };
  }, [panelRef, restoreFocusTo]);
}

/**
 * The email capture behind a tile that has no footage yet.
 *
 * WHAT IT IS ALLOWED TO SAY. The tile it came from is a promise the page has
 * not kept, so the panel opens by admitting that and then offers the only
 * honest thing there is to offer: the list new clips are announced on. It
 * names no date, promises no feature, and pre-checks nothing. Closing it is
 * one press of Escape, one click anywhere outside it, or the button in its
 * corner, which is the same number of gestures as subscribing.
 *
 * It reuses the site's own signup form, the same component and the same
 * `POST /api/newsletter/subscribe` behind the footer's box. A second mailing
 * pathway would be a second list to keep, a second unsubscribe to honour and a
 * second thing to get wrong. `source` is `unknown` for now: the API validates
 * that field against a closed enum, and adding `tutorials-modal` to it means
 * editing the schema and the route, which is a change outside this page.
 *
 * It renders through a portal because the rail's own section animates, and a
 * transformed ancestor makes `position: fixed` behave like `absolute` — the
 * overlay would cover the section instead of the screen.
 */
export function ClipAlertDialog({
  alert,
  cardTitle,
  onClose,
  restoreFocusTo,
}: ClipAlertDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const eyebrowId = useId();
  const titleId = useId();
  const ledeId = useId();

  useDialogFocus(panelRef, restoreFocusTo);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;
      const stops = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (stops.length === 0) return;

      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;
      // Only the two ends need catching. Everything between them is the
      // browser's own tab order, which is already correct.
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose]
  );

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center overscroll-contain p-4 sm:items-center"
      style={{ background: 'rgba(11,10,9,0.72)' }}
      onKeyDown={onKeyDown}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${eyebrowId} ${titleId}`}
        aria-describedby={ledeId}
        tabIndex={-1}
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reduced ? 0 : ENTER_SECONDS, ease: 'easeOut' }}
        className="relative w-full max-w-md rounded-2xl p-6 shadow-[0_24px_60px_rgba(0,0,0,0.55)] focus:outline-none sm:p-7"
        style={{ background: '#181513', border: `1px solid ${PANEL.border}` }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={alert.close}
          className="focus-visible:ring-brand-orange absolute top-3 right-3 grid size-9 place-items-center rounded-full text-[rgba(255,254,251,0.55)] transition-colors hover:bg-white/10 hover:text-[#fffefb] focus-visible:ring-2 focus-visible:outline-none"
        >
          <X size={16} aria-hidden="true" />
        </button>

        <p
          id={eyebrowId}
          className="text-2xs font-mono tracking-[0.14em] uppercase"
          style={{ color: 'rgba(255,254,251,0.5)' }}
        >
          {cardTitle}
        </p>
        <h2
          id={titleId}
          className="mt-2 text-2xl leading-tight font-semibold tracking-[-0.02em]"
          style={{ color: '#fffefb' }}
        >
          {alert.title}
        </h2>
        <p
          id={ledeId}
          className="mt-3 text-sm leading-relaxed text-pretty"
          style={{ color: 'rgba(255,254,251,0.66)' }}
        >
          {alert.lede}
        </p>

        <div className="mt-5">
          <NewsletterSignupForm source="unknown" variant="compact" />
        </div>
      </motion.div>
    </div>,
    document.body
  );
}
