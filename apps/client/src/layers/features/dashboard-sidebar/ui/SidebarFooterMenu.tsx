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
import { Check, Copy, ExternalLink, LayoutGrid, MoreHorizontal, UserRound } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  TOUCH_TARGET_MIN_H,
} from '@/layers/shared/ui';
import { useAppStore, useSlotContributions, useTheme, type Theme } from '@/layers/shared/model';
import { cn, formatShortcutKey, openLink, SHORTCUTS, useCopyFeedback } from '@/layers/shared/lib';
import { useConfig } from '@/layers/entities/config';
import { AccountMenuContainer } from '@/layers/features/profile';
import { HelpMenuItems } from '@/layers/features/report-issue';

/**
 * The shape a footer control takes when the You tab gives it a whole row:
 * full width, named, and 44px tall.
 *
 * **The height is the whole reason it is named.** In the desktop footer these
 * controls are 28px unlabelled glyphs whose only names are tooltips — fine at
 * 272px beside a pointer, and neither a target nor a name on a phone (P4 AC-4,
 * design-system §Hover Pattern Mobile Alternatives).
 *
 * It lives here rather than in the strip because the strip already imports this
 * module: putting it the other way round would make the pair a cycle for the
 * sake of a string.
 */
export const FOOTER_LABELLED_ROW = cn(
  'flex w-full items-center gap-2.5 rounded-md px-2.5 text-[13px]',
  TOUCH_TARGET_MIN_H
);

/**
 * What the fold is called once it has room for a name.
 *
 * Named for what is behind it rather than for the fact that it is a fold: your
 * account first, then Settings, the theme, help and feedback. "More" is what a
 * control is called when nobody has decided what it holds.
 */
const ACCOUNT_MENU_LABEL = 'Account and settings';

/** The cycle the theme item walks. */
const THEME_ORDER: Theme[] = ['light', 'dark', 'system'];

/** What each stop in the cycle is called, in the language of the menu row. */
const THEME_LABELS: Record<Theme, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

/** Props for {@link SidebarFooterMenu}. */
export interface SidebarFooterMenuProps {
  /**
   * Draw the trigger as a named, thumb-sized row instead of a "⋯" glyph — the
   * You tab.
   *
   * **The glyph's only name was a tooltip, and touch screens have no hover.**
   * On a phone that made the operator's own account a 28px unlabelled dot: the
   * one thing in this panel that is about them, behind a mark that says
   * nothing. The fold itself stays — the list genuinely is long — but it is
   * named for what is behind it (P4 AC-4, and the reason it is a fold at all is
   * a 272px panel this tab does not have).
   */
  labelled?: boolean;
}

/**
 * Everything the strip folds away: your account, the `sidebar.footer` slot, the
 * query inspectors in development, and help and feedback.
 *
 * @param props - Whether the trigger is a named row or a "⋯" glyph.
 */
export function SidebarFooterMenu({ labelled = false }: SidebarFooterMenuProps) {
  const contributions = useSlotContributions('sidebar.footer');
  const { theme, setTheme } = useTheme();
  const { devtoolsOpen, routerDevtoolsOpen, toggleDevtools, toggleRouterDevtools } = useAppStore();
  const { data: config } = useConfig();
  const version = config?.version;
  // Pressing the item closes the menu, so there is no chrome left to morph a
  // check mark into — the toast fallback is the pattern for exactly that
  // (`useCopyFeedback`'s TSDoc). Before this it was a bare
  // `navigator.clipboard.writeText` whose promise nobody awaited: a refused
  // clipboard said nothing at all, and the person walked away believing they
  // had their diagnostics.
  const { copy } = useCopyFeedback({ toastOnSettle: true });

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
    void copy(info);
  }, [copy, version]);

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
          aria-label={labelled ? ACCOUNT_MENU_LABEL : 'More'}
          data-testid="sidebar-footer-menu-trigger"
          className={cn(
            'hover:text-sidebar-foreground hover:bg-sidebar/50 focus-ring transition-colors duration-150',
            labelled
              ? cn(FOOTER_LABELLED_ROW, 'text-sidebar-foreground/80')
              : 'text-sidebar-foreground/60 rounded-md p-1'
          )}
        >
          {labelled ? (
            <UserRound className="size-(--size-icon-sm) shrink-0" />
          ) : (
            <MoreHorizontal className="size-(--size-icon-sm)" />
          )}
          {labelled && ACCOUNT_MENU_LABEL}
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
                <span className="text-sidebar-foreground/50 text-2xs ml-auto">
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
                <kbd className="text-3xs">{formatShortcutKey(SHORTCUTS.DEV_PLAYGROUND)}</kbd>
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
