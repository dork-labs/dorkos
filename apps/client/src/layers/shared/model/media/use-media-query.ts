import { useEffect, useState } from 'react';

/**
 * Follow a CSS media query, and re-render whenever the answer changes.
 *
 * The one implementation behind this folder's width hooks. It answers
 * synchronously on the first render — a layout hook that starts out wrong and
 * corrects itself in an effect paints the desktop layout on a phone for a frame
 * — and then tracks the query for as long as the component is mounted.
 *
 * @param query - A CSS media query, e.g. `(max-width: 767px)`.
 * @returns Whether the query matches right now. Always `false` where there is no
 *   `window` to ask.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    mql.addEventListener('change', onChange);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Idiomatic: sync state with matchMedia on mount
    setMatches(mql.matches);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
