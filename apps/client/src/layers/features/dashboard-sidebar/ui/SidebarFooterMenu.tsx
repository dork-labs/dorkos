/**
 * The footer strip's overflow menu — one glyph holding everything the strip
 * itself has no room for.
 *
 * The strip is four destinations and a way to ask DorkBot for help (BC-47), and
 * measuring it in a real 272px panel is what settled the rest: laid out as
 * peers, the `sidebar.footer` contributions pushed "Ask DorkBot" onto a second
 * line. So they fold into one `⋯` here instead. Nothing is lost — Settings, the
 * theme cycle, the developer tools and any extension-contributed button are all
 * still one press away — and the row stays one row at every width.
 *
 * `sidebar.footer` is a published extension seam: an extension registers a
 * button and it appears. That is why the slot is rendered at all rather than
 * quietly dropped with the footer bar it used to live in. The `settings` and
 * `theme` built-ins register no-op `onClick` placeholders because their handlers
 * need React state, and this component overrides them by id — the arrangement
 * `sidebar-contributions.ts` documents.
 *
 * @module features/dashboard-sidebar/ui/SidebarFooterMenu
 */
import { useCallback } from 'react';
import { Check, Copy, ExternalLink, LayoutGrid, MoreHorizontal } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/layers/shared/ui';
import {
  useAppStore,
  useSettingsDeepLink,
  useSlotContributions,
  useTheme,
  type Theme,
} from '@/layers/shared/model';
import { cn, formatShortcutKey, openLink, SHORTCUTS } from '@/layers/shared/lib';
import { useConfig } from '@/layers/entities/config';

/** The cycle the theme item walks. */
const THEME_ORDER: Theme[] = ['light', 'dark', 'system'];

/** What each stop in the cycle is called, in the language of the menu row. */
const THEME_LABELS: Record<Theme, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

/**
 * Everything the strip folds away: the `sidebar.footer` slot and, in
 * development, the query inspectors.
 */
export function SidebarFooterMenu() {
  const contributions = useSlotContributions('sidebar.footer');
  const { theme, setTheme } = useTheme();
  const { open: openSettings } = useSettingsDeepLink();
  const { devtoolsOpen, routerDevtoolsOpen, toggleDevtools, toggleRouterDevtools } = useAppStore();
  const { data: config } = useConfig();
  const version = config?.version;

  const cycleTheme = useCallback(() => {
    const index = THEME_ORDER.indexOf(theme);
    setTheme(THEME_ORDER[(index + 1) % THEME_ORDER.length]);
  }, [theme, setTheme]);

  const handleCopyDebugInfo = useCallback(() => {
    const info = [
      `DorkOS ${version ? `v${version}` : '(unknown version)'}`,
      `Mode: ${import.meta.env.MODE}`,
      `URL: ${window.location.origin}`,
      `User Agent: ${navigator.userAgent}`,
      `Timestamp: ${new Date().toISOString()}`,
    ].join('\n');
    void navigator.clipboard.writeText(info);
  }, [version]);

  // `devtools` is the one contribution this renders as a GROUP rather than a
  // row: its behaviour was always a menu of its own, and a menu inside a menu
  // would be a submenu nobody asked for.
  const rows = contributions.filter((b) => b.id !== 'devtools');
  const showDevTools = import.meta.env.DEV && contributions.some((b) => b.id === 'devtools');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="More"
          className="text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar/50 rounded-md p-1 transition-colors duration-150"
        >
          <MoreHorizontal className="size-(--size-icon-sm)" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-52">
        {rows.map((button) => {
          const Icon = button.icon;
          if (button.id === 'theme') {
            return (
              <DropdownMenuItem
                key={button.id}
                onSelect={(e) => {
                  e.preventDefault();
                  cycleTheme();
                }}
              >
                <Icon className="size-(--size-icon-sm)" />
                Theme
                <span className="text-sidebar-foreground/50 ml-auto text-[11px]">
                  {THEME_LABELS[theme]}
                </span>
              </DropdownMenuItem>
            );
          }
          const onSelect = button.id === 'settings' ? () => openSettings() : button.onClick;
          return (
            <DropdownMenuItem key={button.id} onSelect={onSelect}>
              <Icon className="size-(--size-icon-sm)" />
              {button.label}
            </DropdownMenuItem>
          );
        })}

        {showDevTools && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Developer Tools</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => openLink('/dev')}>
              <LayoutGrid className="size-(--size-icon-sm)" />
              Dev Playground
              <span className="text-sidebar-foreground/50 ml-auto flex items-center gap-1.5">
                <kbd className="text-[10px]">{formatShortcutKey(SHORTCUTS.DEV_PLAYGROUND)}</kbd>
                <ExternalLink className="size-3" />
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                toggleDevtools();
              }}
            >
              <Check className={cn('size-(--size-icon-sm)', !devtoolsOpen && 'invisible')} />
              React Query
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                toggleRouterDevtools();
              }}
            >
              <Check className={cn('size-(--size-icon-sm)', !routerDevtoolsOpen && 'invisible')} />
              Router Inspector
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={handleCopyDebugInfo}>
              <Copy className="size-(--size-icon-sm)" />
              Copy Debug Info
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
