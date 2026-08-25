'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { useScroll, useTransform, type MotionValue } from 'motion/react';
import { clamp01 } from './motion-tokens';

/**
 * Progress (0–1) through a tall section that pins a full-screen child.
 *
 * Deliberately measured from window scroll rather than `useScroll({ target })`:
 * Motion's target mode warns whenever the scroll container is `position:
 * static` (which the document is), and its keyframe transforms get promoted to
 * a native ScrollTimeline that mismaps the offsets. Bounds are measured once
 * per layout instead of per frame, so scrolling never forces a reflow.
 *
 * @param ref - The tall section that scrolls past a sticky child.
 */
export function useSectionProgress(ref: RefObject<HTMLElement | null>): MotionValue<number> {
  const { scrollY } = useScroll();
  const bounds = useRef({ start: 0, span: 1 });

  useEffect(() => {
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      bounds.current = {
        start: el.getBoundingClientRect().top + window.scrollY,
        span: Math.max(1, el.offsetHeight - window.innerHeight),
      };
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [ref]);

  return useTransform(scrollY, (y) => clamp01((y - bounds.current.start) / bounds.current.span));
}
