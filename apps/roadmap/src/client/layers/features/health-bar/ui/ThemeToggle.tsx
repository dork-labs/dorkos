import { Sun, Moon, Monitor } from 'lucide-react';
import { useTheme } from '@/layers/shared/model';
import type { Theme } from '@/layers/shared/model';

/** Cycle order for theme toggling. */
const THEME_CYCLE: Theme[] = ['light', 'dark', 'system'];

const THEME_ICONS: Record<Theme, React.ReactNode> = {
  light: <Sun className="h-4 w-4" />,
  dark: <Moon className="h-4 w-4" />,
  system: <Monitor className="h-4 w-4" />,
};

const THEME_LABELS: Record<Theme, string> = {
  light: 'Switch to dark theme',
  dark: 'Switch to system theme',
  system: 'Switch to light theme',
};

/**
 * Small icon button that cycles through light → dark → system themes.
 *
 * Suitable for placement in a header or toolbar.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  function handleClick() {
    const currentIndex = THEME_CYCLE.indexOf(theme);
    const nextIndex = (currentIndex + 1) % THEME_CYCLE.length;
    setTheme(THEME_CYCLE[nextIndex]);
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={THEME_LABELS[theme]}
      className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-1 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 dark:focus-visible:ring-neutral-100"
    >
      {THEME_ICONS[theme]}
    </button>
  );
}
