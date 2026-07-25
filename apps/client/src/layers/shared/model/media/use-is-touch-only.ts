import { useState, useEffect } from 'react';

/** The primary pointing device is a finger rather than a mouse or stylus. */
const COARSE_PRIMARY = '(pointer: coarse)';
/** SOME attached pointing device is precise — a mouse, trackpad, or stylus. */
const ANY_FINE = '(any-pointer: fine)';

/**
 * Whether touch is the only way to point at this device.
 *
 * Answers the two questions the composer has to get right: is there a software
 * keyboard that an unbidden focus would pop, and does the Enter key mean "send"?
 *
 * **Why not viewport width.** Dragging a desktop window narrow enough to sit
 * beside an editor is an ordinary thing to do, and it must not silently change
 * what the primary keystroke does. A 700px window with a mouse is a desktop.
 *
 * **Why `pointer: coarse` is not enough on its own.** iPadOS reports a coarse
 * primary pointer whether or not a Magic Keyboard is attached, and the same
 * holds for an Android tablet in a keyboard case or a Surface in tablet mode.
 * Those are ~1024 CSS px in landscape, so the width rule that came before this
 * gave them Enter-to-send; a bare `pointer: coarse` rule would take it away
 * with no setting to get it back. Requiring that NO fine pointer exists hands
 * Enter back to any tablet with a trackpad, mouse, or stylus, while a phone —
 * coarse primary, no fine pointer anywhere — keeps Enter as a newline.
 *
 * **Known residuals**, stated rather than implied:
 * - A tablet with a trackpad-LESS Bluetooth keyboard still reads as touch-only,
 *   so Enter stays a newline there. Nothing in CSS distinguishes it from a bare
 *   tablet; closing that gap needs a user-facing setting, not a better query.
 * - Hybrid touchscreen laptops are UNVERIFIED. They should report a fine
 *   primary pointer and never reach this branch at all, but the case could not
 *   be measured: Chrome DevTools touch emulation REPLACES the pointer rather
 *   than adding one, which no real hybrid does.
 *
 * Deliberately two queries rather than the single
 * `(pointer: coarse) and (not (any-pointer: fine))`. The `not (…)` operator
 * inside a condition is Media Queries Level 4 (Safari 16.4+), and an engine
 * that cannot parse a condition evaluates the WHOLE query to false. On such an
 * engine that single query answers false on a phone — quietly handing it
 * Enter-to-send, the worse direction to fail in, on the exact devices the rule
 * exists to protect. `pointer` and `any-pointer` on their own are supported far
 * more widely, and a query built from them alone cannot fail that way.
 *
 * @returns `true` while touch is the only pointer; updates live.
 */
export function useIsTouchOnly(): boolean {
  const [isTouchOnly, setIsTouchOnly] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(COARSE_PRIMARY).matches && !window.matchMedia(ANY_FINE).matches;
  });

  useEffect(() => {
    const coarse = window.matchMedia(COARSE_PRIMARY);
    const anyFine = window.matchMedia(ANY_FINE);
    const sync = () => setIsTouchOnly(coarse.matches && !anyFine.matches);
    coarse.addEventListener('change', sync);
    anyFine.addEventListener('change', sync);
    sync();
    return () => {
      coarse.removeEventListener('change', sync);
      anyFine.removeEventListener('change', sync);
    };
  }, []);

  return isTouchOnly;
}
