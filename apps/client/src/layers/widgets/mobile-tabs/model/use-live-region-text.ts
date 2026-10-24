/**
 * What the phone's polite live region says about things waiting on you, and how
 * often it is allowed to say it (BC-11, spec R2).
 *
 * @module widgets/mobile-tabs/model/use-live-region-text
 */
import { useEffect, useRef, useState } from 'react';

/**
 * How long the count has to hold still before a screen reader hears it.
 *
 * One second, from R2. Two agents finishing a turn a few hundred milliseconds
 * apart is one piece of news, not two, and a queue draining item by item would
 * otherwise read the whole countdown out loud.
 */
export const LIVE_REGION_DEBOUNCE_MS = 1_000;

/**
 * What the region says for a count of things waiting on you — the COUNT and
 * nothing else (BC-11). A verb or an unread change must never reach a screen
 * reader from here; a fleet of thirty agents would turn one into a siren.
 *
 * @param count - How many things are waiting on the operator.
 */
export function needsYouLiveRegionText(count: number): string | undefined {
  if (count === 0) return undefined;
  return count === 1 ? '1 agent needs you' : `${count} agents need you`;
}

/**
 * The live-region text, published at most once per {@link LIVE_REGION_DEBOUNCE_MS}.
 *
 * **The caller has already decided this can only be a count**
 * ({@link needsYouLiveRegionText}), so a verb or an unread change cannot reach
 * here however often it fires — this hook's job is only to keep a fast-moving
 * COUNT from becoming a siren.
 *
 * The FIRST value waits too. Adopting it on mount would put words into the
 * region the instant the cockpit appears, which is the moment a queue is most
 * likely to still be settling — one approval landing a beat before a second one
 * would announce "1 agent needs you" and then correct itself.
 *
 * @param text - What should be said, or `undefined` for nothing.
 */
export function useLiveRegionText(text: string | undefined): string {
  const [published, setPublished] = useState('');
  // Held so the effect can tell "the count changed" from "React ran
  // this effect again", without putting `published` in the dependency list —
  // which would re-arm the timer every time it fires.
  const publishedRef = useRef(published);

  useEffect(() => {
    const next = text ?? '';
    if (next === publishedRef.current) return;
    const timer = setTimeout(() => {
      publishedRef.current = next;
      setPublished(next);
    }, LIVE_REGION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  return published;
}
