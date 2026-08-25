'use client';

import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react';
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

/** Nothing external ever notifies this decision — it's fixed once for the life of the mounted component. */
function subscribeToNothing() {
  return () => {};
}

/** SSR (and the client's hydration pass) always assumes the prelude should not play, matching the pre-hydration DOM. */
function getShouldPlayServerSnapshot() {
  return false;
}

/**
 * Boot-sequence prelude — types "DorkOS is starting." then fades to reveal the page.
 *
 * Plays at most once per browser session, skips instantly on any user input,
 * and is bypassed entirely when the visitor prefers reduced motion.
 */
export function Prelude() {
  // The play/skip decision needs client-only APIs (matchMedia, sessionStorage)
  // that don't exist during SSR, so useSyncExternalStore supplies `false` for
  // the server and the hydration pass, then swaps in the real client-only
  // read right after — the mechanism that guarantees reduced-motion and
  // repeat visitors never see a flash of the boot overlay. The ref caches the
  // decision after its first real read so a later render (e.g. while the
  // effect below marks the session as seen) can't flip it mid-animation.
  const decidedRef = useRef<boolean | null>(null);
  const getShouldPlaySnapshot = useCallback(() => {
    if (decidedRef.current === null) {
      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const alreadySeen = sessionStorage.getItem(SESSION_KEY) === 'true';
      decidedRef.current = !prefersReducedMotion && !alreadySeen;
    }
    return decidedRef.current;
  }, []);
  const shouldPlay = useSyncExternalStore(
    subscribeToNothing,
    getShouldPlaySnapshot,
    getShouldPlayServerSnapshot
  );

  const [dismissed, setDismissed] = useState(false);
  const [text, setText] = useState('');
  const visible = shouldPlay && !dismissed;

  const dismiss = useCallback(() => setDismissed(true), []);

  useEffect(() => {
    // Mark as seen up front so it never replays within the session.
    sessionStorage.setItem(SESSION_KEY, 'true');

    if (!shouldPlay) return;

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
  }, [shouldPlay, dismiss]);

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
