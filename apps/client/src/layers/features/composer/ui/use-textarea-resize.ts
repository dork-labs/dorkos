import { useLayoutEffect } from 'react';
import type { RefObject } from 'react';

const MAX_TEXTAREA_HEIGHT = 200;
const SINGLE_LINE_HEIGHT = 24;
const SHRINK_DURATION_MS = 200;

/**
 * Keep a textarea's height in step with its value — however the value got there.
 *
 * Height follows `value`, never the keystroke that produced it. The composer is
 * a controlled field, and most of the text it holds never came from typing:
 * clicking a queued message to edit it, ArrowUp into the queue, Escape
 * restoring a parked draft, a `?prompt=` re-run seed, a suggestion chip. Sizing
 * only on the `input` event left every one of those showing line 1 of 6 inside
 * a 24px box with `resize-none` and no scrollbar to hint at the rest.
 *
 * Emptying the field eases back to a single line rather than snapping. The
 * inline `transition` that animation installs is torn down on every exit path,
 * including the one where the person starts typing again mid-animation — a
 * stale `transition` would make every later auto-grow animate instead of snap.
 *
 * @param textareaRef - Ref to the textarea being sized.
 * @param value - The field's current value; the sole trigger for a resize.
 */
export function useTextareaResize(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  value: string
): void {
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    /** Drop every inline override so the element sits at its stylesheet height. */
    const settle = () => {
      textarea.style.transition = '';
      textarea.style.height = '';
    };

    if (value !== '') {
      // `auto` first, so `scrollHeight` reports the content's natural height
      // rather than whatever height the previous pass pinned.
      textarea.style.transition = '';
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
      return;
    }

    // Emptied. Animate down from wherever the box currently stands.
    const currentHeight = textarea.offsetHeight;
    if (currentHeight <= SINGLE_LINE_HEIGHT) {
      settle();
      return;
    }

    textarea.style.height = `${currentHeight}px`;
    textarea.style.transition = `height ${SHRINK_DURATION_MS}ms ease`;
    const frame = requestAnimationFrame(() => {
      textarea.style.height = `${SINGLE_LINE_HEIGHT}px`;
    });
    textarea.addEventListener('transitionend', settle, { once: true });

    return () => {
      cancelAnimationFrame(frame);
      textarea.removeEventListener('transitionend', settle);
      settle();
    };
  }, [textareaRef, value]);
}
