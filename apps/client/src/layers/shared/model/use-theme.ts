import { create } from 'zustand';

export type Theme = 'light' | 'dark' | 'system';

/** The concrete color scheme in effect — the resolved form of a {@link Theme}. */
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'dorkos-theme';
const DARK_MQ = '(prefers-color-scheme: dark)';

/** Read the persisted preference, defaulting to `system`. */
function getStored(): Theme {
  const val = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
  if (val === 'light' || val === 'dark' || val === 'system') return val;
  return 'system';
}

/** Whether the OS currently prefers a dark color scheme (false when unavailable). */
function systemPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(DARK_MQ).matches
  );
}

/** Resolve a preference plus the OS signal to a concrete scheme. */
function resolveTheme(theme: Theme, systemDark: boolean): ResolvedTheme {
  if (theme === 'light' || theme === 'dark') return theme;
  return systemDark ? 'dark' : 'light';
}

interface ThemeStore {
  /** The user's preference (light / dark / system). */
  theme: Theme;
  /** The OS dark-mode signal, tracked live so `system` resolves correctly. */
  systemDark: boolean;
  /** Set the preference and persist it. */
  setTheme: (theme: Theme) => void;
  /** @internal Store wiring — record an OS preference change (matchMedia / tests). */
  setSystemDark: (systemDark: boolean) => void;
}

/**
 * Shared theme store — the single source of truth for the light/dark/system
 * preference and the OS signal.
 *
 * A change from any surface (settings, command palette, sidebar, or the agent's
 * `control_ui set_theme` command) reaches every consumer at once, including
 * already-mounted canvas viewers that used to hold a stale per-instance copy (so
 * a newly-dark app no longer leaves an open markdown document painted light).
 *
 * Inside React, prefer the {@link useTheme} / {@link useResolvedTheme} hooks.
 * Non-React callers (the app-shell command dispatcher) set the theme
 * imperatively via `useThemeStore.getState().setTheme(...)`.
 */
export const useThemeStore = create<ThemeStore>((set) => ({
  theme: getStored(),
  systemDark: systemPrefersDark(),
  setTheme: (theme) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, theme);
    set({ theme });
  },
  setSystemDark: (systemDark) => set({ systemDark }),
}));

/** Reflect the resolved scheme onto the document root — the single class mutation. */
function applyDark(dark: boolean): void {
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('dark', dark);
  }
}

// One-time wiring (the store is a singleton): keep the root `.dark` class in sync
// with the resolved theme from ONE place, and feed OS preference changes into the
// store from ONE matchMedia listener — so no read-shaped hook mutates <html> and
// there is never more than a single listener regardless of how many consumers
// mount.
const initialState = useThemeStore.getState();
applyDark(resolveTheme(initialState.theme, initialState.systemDark) === 'dark');
useThemeStore.subscribe((state) =>
  applyDark(resolveTheme(state.theme, state.systemDark) === 'dark')
);
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  window
    .matchMedia(DARK_MQ)
    .addEventListener('change', (e) => useThemeStore.getState().setSystemDark(e.matches));
}

/** Manage the light/dark/system theme preference, persisting to localStorage. */
export function useTheme() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  return { theme, setTheme } as const;
}

/**
 * Resolve the theme preference to a concrete `light`/`dark`, following the OS
 * live when the preference is `system` — the same value the shared store applies
 * to the root `.dark` class, so it stays in lockstep with a live theme change.
 *
 * Use this anywhere a component must hand a concrete light/dark to a child that
 * can't read the root `.dark` class itself — an editor theme, a canvas viewer —
 * so the app's choice stays authoritative. Unlike the `theme === 'dark' ? … : …`
 * shortcut, this reports the OS preference under `system` instead of defaulting
 * such users to light.
 */
export function useResolvedTheme(): ResolvedTheme {
  return useThemeStore((s) => resolveTheme(s.theme, s.systemDark));
}
