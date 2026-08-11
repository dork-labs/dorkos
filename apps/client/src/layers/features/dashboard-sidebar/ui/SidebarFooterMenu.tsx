/**
 * The footer strip's overflow menu — one glyph holding everything the strip
 * itself has no room for.
 *
 * The strip is four destinations and a way to ask DorkBot for help (BC-47), and
 * measuring it in a real 272px panel is what settled the rest — twice. Laid out
 * as peers, the `sidebar.footer` contributions pushed "Ask DorkBot" onto a
 * second line; the operator's face alone took the row's `scrollWidth` to 281 in
 * a 256 box. So all of it folds into one `⋯` here instead. Nothing is lost —
 * your account, Settings, the theme cycle, the developer tools, help and
 * feedback, and any extension-contributed button are one press away — and the
 * row stays one row at every width.
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
import { useCallback, useMemo } from 'react';
import { Check, Copy, ExternalLink, LayoutGrid, MoreHorizontal } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/layers/shared/ui';
import { useAppStore, useSlotContributions, useTheme, type Theme } from '@/layers/shared/model';
import { cn, formatShortcutKey, openLink, SHORTCUTS } from '@/layers/shared/lib';
import { useConfig } from '@/layers/entities/config';
import { AccountMenuContainer } from '@/layers/features/profile';
import { HelpMenuItems } from '@/layers/features/report-issue';

/** The cycle the theme item walks. */
const THEME_ORDER: Theme[] = ['light', 'dark', 'system'];

/** What each stop in the cycle is called, in the language of the menu row. */
const THEME_LABELS: Record<Theme, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

/**
 * Everything the strip folds away: your account, the `sidebar.footer` slot, the
 * query inspectors in development, and help and feedback.
 */
export function SidebarFooterMenu() {
  const contributions = useSlotContributions('sidebar.footer');
  const { theme, setTheme } = useTheme();
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

  // `showInDevOnly` is the slot's own flag and it is honoured for EVERY
  // contribution, not only the built-in `devtools`. The footer bar this replaced
  // applied it in one place (`filteredButtons`); losing it here would have put
  // an extension's dev-only button in front of every production user, which the
  // extension author explicitly asked not to happen.
  const visible = useMemo(
    () => contributions.filter((b) => !b.showInDevOnly || import.meta.env.DEV),
    [contributions]
  );

  // `devtools` is the one contribution this renders as a GROUP rather than a
  // row: its behaviour was always a menu of its own, and a menu inside a menu
  // would be a submenu nobody asked for.
  const rows = visible.filter((b) => b.id !== 'devtools');
  const showDevTools = visible.some((b) => b.id === 'devtools');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="More"
          className="text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar/50 focus-ring rounded-md p-1 transition-colors duration-150"
        >
          <MoreHorizontal className="size-(--size-icon-sm)" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-56">
        {/* Who you are, first — the same rows the operator's face opens from its
            own disc (spec `identity-consistency` §W3.1). It draws nothing until
            the roster names somebody, so the embed gets no dead block. BC-43
            gives the face a home of its own in the header block; this fold is
            what keeps its items reachable until then. */}
        {/* Both of the account block's doors yield to the header block, which
            BC-43 gives "Workspace settings" and "Account". Two menus offering
            one dialog under two different names is the same defect as one menu
            doing it, with more distance between the rows to make it harder to
            notice. What stays is what the header menu does NOT carry: who you
            are signed in as, and how to stop being. */}
        <AccountMenuContainer variant="rows" showSettings={false} showViewProfile={false} />
        <DropdownMenuSeparator />
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
          return (
            <DropdownMenuItem key={button.id} onSelect={button.onClick}>
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

        <DropdownMenuSeparator />
        {/* Help and feedback, which used to be its own `?` trigger beside the
            footer's icons. One row has room for one fold, so it folds here. */}
        <HelpMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
