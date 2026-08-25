'use client';

import { useEffect, useState } from 'react';
import { throttle } from 'lodash-es';

/** How far down the viewport a section's top has to cross to count as "here". */
const ENTRY_LINE = 0.35;

/**
 * Which of the page's sections the visitor is currently reading.
 *
 * Deliberately a scroll measurement rather than an `IntersectionObserver`. The
 * stage on this page is 320vh tall with a sticky child, and the clips rail is
 * shorter than a viewport: an observer keyed on "is visible" reports two or
 * three of them at once and has no opinion about which one you are actually
 * looking at. A single line a third of the way down the viewport does: the
 * last section whose top has crossed it is the one you are in, whatever the
 * heights are.
 *
 * @param ids - Section element ids, in page order. Must be a stable reference.
 * @returns The id of the current section, or null above the first one.
 */
export function useActiveSection(ids: readonly string[]): string | null {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const measure = throttle(() => {
      const line = window.innerHeight * ENTRY_LINE;
      let current: string | null = null;
      for (const id of ids) {
        const top = document.getElementById(id)?.getBoundingClientRect().top;
        if (top !== undefined && top <= line) current = id;
      }
      setActive(current);
    }, 150);

    window.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure, { passive: true });
    measure();

    return () => {
      window.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      measure.cancel();
    };
  }, [ids]);

  return active;
}
