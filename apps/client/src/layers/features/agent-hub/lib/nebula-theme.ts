import { useSyncExternalStore } from 'react';

/**
 * Hex alpha suffixes for the Cosmic Nebula effect in light and dark modes.
 *
 * Dark mode uses lower alpha (colors glow against dark backgrounds).
 * Light mode uses higher alpha (colors need more saturation to be visible
 * against bright backgrounds).
 */
const ALPHA = {
  light: {
    /** Hero radial-gradient inner glow */
    heroGlow: '28',
    /** Hero radial-gradient outer glow */
    heroGlowOuter: '14',
    /** Personality badge background gradient stops */
    pillBgStart: '20',
    pillBgEnd: '14',
    /** Personality badge border */
    pillBorder: '50',
    /** Active preset pill glow (box-shadow) */
    pillGlow: '30',
  },
  dark: {
    heroGlow: '18',
    heroGlowOuter: '08',
    pillBgStart: '12',
    pillBgEnd: '08',
    pillBorder: '40',
    pillGlow: '33',
  },
} as const;

export interface NebulaAlpha {
  heroGlow: string;
  heroGlowOuter: string;
  pillBgStart: string;
  pillBgEnd: string;
  pillBorder: string;
  pillGlow: string;
}

// ---------------------------------------------------------------------------
// useIsDark — lightweight dark-mode detector
// ---------------------------------------------------------------------------

function getSnapshot(): boolean {
  return document.documentElement.classList.contains('dark');
}

function getServerSnapshot(): boolean {
  return false;
}

function subscribe(callback: () => void): () => void {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.attributeName === 'class') {
        callback();
        return;
      }
    }
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

/** Reactive hook that tracks whether dark mode is active via `.dark` on `<html>`. */
export function useIsDark(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Returns the current set of hex alpha suffixes for nebula effects. */
export function useNebulaAlpha(): NebulaAlpha {
  const isDark = useIsDark();
  return isDark ? ALPHA.dark : ALPHA.light;
}
