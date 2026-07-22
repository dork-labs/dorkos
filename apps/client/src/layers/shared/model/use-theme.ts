import { useState, useEffect, useCallback } from 'react';

export type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'dorkos-theme';
const DARK_MQ = '(prefers-color-scheme: dark)';

function getStored(): Theme {
  const val = localStorage.getItem(STORAGE_KEY);
  if (val === 'light' || val === 'dark' || val === 'system') return val;
  return 'system';
}

function applyDark(dark: boolean) {
  document.documentElement.classList.toggle('dark', dark);
}

/** Manage the light/dark/system theme preference, persisting to localStorage. */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getStored);

  const setTheme = useCallback((t: Theme) => {
    localStorage.setItem(STORAGE_KEY, t);
    setThemeState(t);
  }, []);

  useEffect(() => {
    if (theme === 'system') {
      if (typeof window.matchMedia !== 'function') {
        applyDark(false);
        return;
      }
      const mq = window.matchMedia(DARK_MQ);
      applyDark(mq.matches);
      const handler = (e: MediaQueryListEvent) => applyDark(e.matches);
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
    applyDark(theme === 'dark');
  }, [theme]);

  return { theme, setTheme } as const;
}

/** The concrete color scheme in effect — the resolved form of a {@link Theme}. */
export type ResolvedTheme = 'light' | 'dark';

/** Whether the OS currently prefers a dark color scheme (false when unavailable). */
function systemPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(DARK_MQ).matches
  );
}

/**
 * Resolve the theme preference to a concrete `light`/`dark`, following the OS
 * live when the preference is `system` — the same resolution {@link useTheme}
 * applies to the root `.dark` class.
 *
 * Use this anywhere a component must hand a concrete light/dark to a child that
 * can't read the root `.dark` class itself — an editor theme, a canvas viewer —
 * so the app's choice stays authoritative. Unlike the `theme === 'dark' ? … : …`
 * shortcut, this reports the OS preference under `system` instead of defaulting
 * such users to light.
 */
export function useResolvedTheme(): ResolvedTheme {
  const { theme } = useTheme();
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  // Track the OS preference regardless of the current setting, so switching to
  // `system` — or the OS flipping while on `system` — is reflected live. Only the
  // change handler sets state, never the effect body, so no cascading render.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(DARK_MQ);
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  if (theme === 'light' || theme === 'dark') return theme;
  return systemDark ? 'dark' : 'light';
}
