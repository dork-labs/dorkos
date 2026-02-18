import { useEffect } from 'react';
import { useAppStore, type Theme } from './app-store';

/** Applies the resolved theme class to `document.documentElement`. */
function applyTheme(theme: Theme): void {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = theme === 'dark' || (theme === 'system' && prefersDark);

  if (isDark) {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}

/**
 * Reads the theme preference from the global store, applies the `dark` class
 * to `document.documentElement`, and listens for OS-level color scheme changes
 * so system theme updates in real-time.
 *
 * @returns `{ theme, setTheme }` — the current preference and a setter.
 */
export function useTheme(): { theme: Theme; setTheme: (theme: Theme) => void } {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);

  useEffect(() => {
    applyTheme(theme);

    if (theme !== 'system') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    const handleChange = () => applyTheme('system');
    mediaQuery.addEventListener('change', handleChange);

    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme]);

  return { theme, setTheme };
}
