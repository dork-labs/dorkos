'use client';

import { useSyncExternalStore } from 'react';

/**
 * The visitor's platform, as far as it matters for offering a desktop
 * download. `'unknown'` is the server-render / pre-hydration value — the
 * detection only runs in the browser, so the first paint must not assume a
 * platform (that would risk a hydration mismatch and a content flash).
 */
export type Platform = 'unknown' | 'mac' | 'other';

/**
 * Detect whether the current browser is running on a Mac desktop (macOS),
 * excluding iPhone and iPad — including iPadOS, which masquerades as a Mac in
 * `navigator.platform`/`userAgent` but reports multiple touch points and
 * cannot run a `.dmg`.
 *
 * Returns `'other'` when called outside a browser so it is safe to call
 * anywhere; the hook below is what gates on client-side execution.
 */
export function detectPlatform(): Exclude<Platform, 'unknown'> {
  if (typeof navigator === 'undefined') return 'other';

  const ua = navigator.userAgent ?? '';
  const platform = navigator.platform ?? '';
  const looksLikeMac = /Mac/i.test(platform) || /Mac OS X/i.test(ua);

  const touchPoints = navigator.maxTouchPoints ?? 0;
  const isIpadOrIphone = /iPhone|iPad|iPod/i.test(ua) || (looksLikeMac && touchPoints > 1);

  return looksLikeMac && !isIpadOrIphone ? 'mac' : 'other';
}

/** Platform never changes for the life of a page, so there is nothing to subscribe to. */
const subscribe = (): (() => void) => () => {};

/**
 * Client-side platform detection for OS-aware download affordances.
 *
 * Uses {@link useSyncExternalStore} so the server snapshot is always
 * `'unknown'` and the browser snapshot is the real platform: React swaps to
 * the client value after hydration, giving the correct download CTA without a
 * hydration mismatch and without a set-state-in-effect cascade.
 */
export function usePlatform(): Platform {
  return useSyncExternalStore<Platform>(subscribe, detectPlatform, () => 'unknown');
}
