import { useState, useEffect, useCallback } from 'react';

export type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'gateway-theme';
const DARK_MQ = '(prefers-color-scheme: dark)';

function getStored(): Theme {
  const val = localStorage.getItem(STORAGE_KEY);
  if (val === 'light' || val === 'dark' || val === 'system') return val;
  return 'system';
}

function applyDark(dark: boolean) {
  document.documentElement.classList.toggle('dark', dark);
}

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
