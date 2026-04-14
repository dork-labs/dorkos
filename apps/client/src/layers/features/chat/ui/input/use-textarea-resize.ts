import { useEffect, useCallback } from 'react';
import type { RefObject } from 'react';

const MAX_TEXTAREA_HEIGHT = 200;
const SINGLE_LINE_HEIGHT = 24;

/** Auto-grow textarea on input and smoothly shrink back on clear. */
export function useTextareaResize(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  value: string
) {
  /** Recalculate textarea height after content changes. */
  const resize = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [textareaRef]);

  // Smoothly shrink textarea back to single-line height after value is cleared
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || value !== '') return;

    const currentHeight = textarea.scrollHeight;
    if (currentHeight <= SINGLE_LINE_HEIGHT) return;

    textarea.style.height = `${currentHeight}px`;
    textarea.style.transition = 'height 200ms ease';
    requestAnimationFrame(() => {
      textarea.style.height = `${SINGLE_LINE_HEIGHT}px`;
    });

    const onEnd = () => {
      textarea.style.transition = '';
      textarea.style.height = '';
    };
    textarea.addEventListener('transitionend', onEnd, { once: true });
    return () => textarea.removeEventListener('transitionend', onEnd);
  }, [textareaRef, value]);

  return resize;
}
