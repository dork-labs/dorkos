'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';

const FULL_TEXT = 'DorkOS is starting.';
/** Per-character typing cadence. 19 chars × 32ms ≈ 610ms of typing. */
const TYPE_INTERVAL_MS = 32;
/** Pause after the line finishes before the fade begins. */
const HOLD_MS = 220;
/** Fade-out duration. Typing + hold + fade stays under the 1.2s budget. */
const FADE_S = 0.3;
/** Session flag — set the first time the prelude runs so it never replays. */
const SESSION_KEY = 'dorkos-prelude-seen';

/**
 * Boot-sequence prelude — types "DorkOS is starting." then fades to reveal the page.
 *
 * Plays at most once per browser session, skips instantly on any user input,
 * and is bypassed entirely when the visitor prefers reduced motion.
 */
export function Prelude() {
  // Starts hidden: the play/skip decision needs client-only APIs, so it is
  // made in the mount effect. This guarantees reduced-motion and repeat
  // visitors never see a flash of the boot overlay.
  const [visible, setVisible] = useState(false);
  const [text, setText] = useState('');

  const dismiss = useCallback(() => setVisible(false), []);

  useEffect(() => {
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const alreadySeen = sessionStorage.getItem(SESSION_KEY) === 'true';
    // Mark as seen up front so it never replays within the session.
    sessionStorage.setItem(SESSION_KEY, 'true');

    if (prefersReducedMotion || alreadySeen) return;

    setVisible(true);

    let holdTimeout: ReturnType<typeof setTimeout> | undefined;
    let index = 0;
    const typeInterval = setInterval(() => {
      index++;
      setText(FULL_TEXT.slice(0, index));
      if (index >= FULL_TEXT.length) {
        clearInterval(typeInterval);
        holdTimeout = setTimeout(dismiss, HOLD_MS);
      }
    }, TYPE_INTERVAL_MS);

    // Any user input skips the prelude instantly.
    const skip = () => dismiss();
    const events = ['scroll', 'wheel', 'pointerdown', 'keydown', 'touchstart'] as const;
    for (const event of events) {
      window.addEventListener(event, skip, { passive: true, once: true });
    }

    return () => {
      clearInterval(typeInterval);
      clearTimeout(holdTimeout);
      for (const event of events) window.removeEventListener(event, skip);
    };
  }, [dismiss]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: '#1A1814' }}
          exit={{ opacity: 0 }}
          transition={{ duration: FADE_S, ease: 'easeOut' }}
        >
          <p className="font-mono text-sm tracking-[0.08em]" style={{ color: '#F5F0E6' }}>
            {text}
            <span className="cursor-blink" aria-hidden="true" />
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
