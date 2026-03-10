import { useCallback } from 'react';
import { Sun, Moon, Monitor, Settings, Bug, Pencil } from 'lucide-react';
import { DorkLogo } from '@dorkos/icons/logos';
import { useAppStore, useTheme, type Theme } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';

const THEME_ORDER: Theme[] = ['light', 'dark', 'system'];

const THEME_ICONS = {
  light: Sun,
  dark: Moon,
  system: Monitor,
} as const;

/**
 * Bottom bar for the sidebar footer. Shows branding link, settings gear button,
 * theme cycle toggle (light → dark → system), and a devtools toggle in DEV mode.
 */
export function SidebarFooterBar() {
  const { setSettingsOpen, setAgentDialogOpen, devtoolsOpen, toggleDevtools } = useAppStore();
  const { theme, setTheme } = useTheme();
  const ThemeIcon = THEME_ICONS[theme];

  const cycleTheme = useCallback(() => {
    const idx = THEME_ORDER.indexOf(theme);
    setTheme(THEME_ORDER[(idx + 1) % THEME_ORDER.length]);
  }, [theme, setTheme]);

  return (
    <div className="border-border flex items-center border-t px-2 py-1.5">
      <a
        href="https://dorkos.ai"
        target="_blank"
        rel="noopener noreferrer"
        className="text-muted-foreground/50 hover:text-muted-foreground transition-colors duration-150"
      >
        <DorkLogo variant="current" size={60} />
      </a>
      <div className="ml-auto flex items-center gap-0.5">
        <button
          onClick={() => setAgentDialogOpen(true)}
          className="text-muted-foreground/50 hover:text-muted-foreground rounded-md p-1 transition-colors duration-150"
          aria-label="Edit agent"
        >
          <Pencil className="size-(--size-icon-sm)" />
        </button>
        <button
          onClick={() => setSettingsOpen(true)}
          className="text-muted-foreground/50 hover:text-muted-foreground rounded-md p-1 transition-colors duration-150"
          aria-label="Settings"
        >
          <Settings className="size-(--size-icon-sm)" />
        </button>
        <button
          onClick={cycleTheme}
          className="text-muted-foreground/50 hover:text-muted-foreground rounded-md p-1 transition-colors duration-150"
          aria-label={`Theme: ${theme}. Click to cycle.`}
          title={`Theme: ${theme}`}
        >
          <ThemeIcon className="size-(--size-icon-sm)" />
        </button>
        {import.meta.env.DEV && (
          <button
            onClick={toggleDevtools}
            className={cn(
              'rounded-md p-1 transition-colors duration-150',
              devtoolsOpen ? 'text-amber-500' : 'text-amber-500/60 hover:text-amber-500'
            )}
            title={devtoolsOpen ? 'Hide React Query devtools' : 'Show React Query devtools'}
            aria-label="Toggle React Query devtools"
          >
            <Bug className="size-(--size-icon-sm)" />
          </button>
        )}
      </div>
    </div>
  );
}
