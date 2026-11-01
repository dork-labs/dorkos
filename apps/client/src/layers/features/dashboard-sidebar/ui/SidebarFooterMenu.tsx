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
import {
  Check,
  Copy,
  ExternalLink,
  LayoutGrid,
  Monitor,
  Moon,
  MoreHorizontal,
  Sun,
  SunMoon,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import {
  Button,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuItem,
  ResponsiveDropdownMenuLabel,
  ResponsiveDropdownMenuRadioGroup,
  ResponsiveDropdownMenuRadioItem,
  ResponsiveDropdownMenuSeparator,
  ResponsiveDropdownMenuTrigger,
  SIDEBAR_ICON_CONTROL,
  TOUCH_TARGET_MIN_H,
} from '@/layers/shared/ui';
import {
  useAppStore,
  useIsMobile,
  useSlotContributions,
  useTheme,
  type Theme,
} from '@/layers/shared/model';
import { cn, formatShortcutKey, openLink, SHORTCUTS, useCopyFeedback } from '@/layers/shared/lib';
import { useConfig } from '@/layers/entities/config';
import { AccountMenuContainer } from '@/layers/features/profile';
import { HelpMenuItems } from '@/layers/features/report-issue';
import { useCurrentUser } from '@/layers/features/auth';

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
  'flex w-full items-center gap-2.5 rounded-md px-2.5 text-control',
  TOUCH_TARGET_MIN_H
);

/**
 * What the fold is called once it has room for a name — the phone, where help
 * and feedback sit outside it as rows of their own.
 *
 * Named for what is behind it rather than for the fact that it is a fold, and
 * true in both states: the theme always, and signing out only on an install
 * that has a login to sign out of (login is off by default, ADR-0320). "More"
 * is what a control is called when nobody has decided what it holds. It never
 * says "account": that word means the DorkOS account, which has its own row at
 * the top of the You tab (DOR-2628).
 *
 * @param canSignOut - Whether this install has a local session to end.
 */
function foldLabel(canSignOut: boolean): string {
  return canSignOut ? 'Sign out and theme' : 'Theme';
}

/** The cycle the theme item walks. */
const THEME_ORDER: Theme[] = ['light', 'dark', 'system'];

/** What each stop in the cycle is called, in the language of the menu row. */
const THEME_LABELS: Record<Theme, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

/** Each stop's glyph, for the phone sheet's three rows. */
const THEME_ICONS: Record<Theme, LucideIcon> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
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
  const isMobile = useIsMobile();
  const canSignOut = useCurrentUser() !== null;
  const label = foldLabel(canSignOut);
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

  // **The trigger's glyph says what is behind it** (Phase 4 S9). A person icon
  // on a fold that holds only the theme read as "your account", which this
  // fold is not; the person comes back only when signing out is in here too.
  const FoldIcon = canSignOut ? UserRound : SunMoon;

  return (
    // A menu under a pointer, a bottom sheet on a phone (Overlay B). The sheet
    // is where this fold lives on the You tab, so its rows are thumb-sized and
    // the theme is three choices you can see rather than a cycle you guess at.
    <ResponsiveDropdownMenu>
      <ResponsiveDropdownMenuTrigger asChild>
        {labelled ? (
          <button
            type="button"
            aria-label={label}
            data-testid="sidebar-footer-menu-trigger"
            className={cn(
              'hover:text-sidebar-foreground hover:bg-sidebar/50 focus-ring transition-colors duration-150',
              FOOTER_LABELLED_ROW,
              'text-sidebar-foreground/80'
            )}
          >
            <FoldIcon className="size-(--size-icon-sm) shrink-0" />
            {label}
          </button>
        ) : (
          // The real Button (Phase 4 S17), the destinations' own shape. Its
          // name stays "More".
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="More"
            data-testid="sidebar-footer-menu-trigger"
            className="text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar/50 data-[state=open]:bg-sidebar/50 focus-ring"
          >
            <MoreHorizontal className={SIDEBAR_ICON_CONTROL} />
          </Button>
        )}
      </ResponsiveDropdownMenuTrigger>
      <ResponsiveDropdownMenuContent side="top" align="end" className="w-56">
        {/* A sheet is a dialog, and a dialog needs a name: the fold's own. */}
        {isMobile && <ResponsiveDropdownMenuLabel>{label}</ResponsiveDropdownMenuLabel>}
        {/* Both of the account block's doors yield to the header block, which
            BC-43 gives "Settings" and your profile ("you"). Two menus offering
            one dialog under two different names is the same defect as one menu
            doing it, with more distance between the rows to make it harder to
            notice. What stays is what the header menu does NOT carry: who you
            are signed in as, and how to stop being. */}
        <AccountMenuContainer variant="rows" showSettings={false} showViewProfile={false} />
        <ResponsiveDropdownMenuSeparator />
        {rows.map((button) => {
          const Icon = button.icon;
          if (button.id === 'theme') {
            if (isMobile) {
              // Three rows, the current one ticked, and the sheet stays up so
              // the change can be seen behind it.
              return (
                <ResponsiveDropdownMenuRadioGroup
                  key={button.id}
                  value={theme}
                  onValueChange={(next) => setTheme(next as Theme)}
                  closeOnSelect={false}
                >
                  {THEME_ORDER.map((option) => (
                    <ResponsiveDropdownMenuRadioItem
                      key={option}
                      value={option}
                      icon={THEME_ICONS[option]}
                    >
                      {THEME_LABELS[option]}
                    </ResponsiveDropdownMenuRadioItem>
                  ))}
                </ResponsiveDropdownMenuRadioGroup>
              );
            }
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
                <span className="text-muted-foreground text-2xs ml-auto">
                  {THEME_LABELS[theme]}
                </span>
              </DropdownMenuItem>
            );
          }
          if (isMobile) {
            return (
              <ResponsiveDropdownMenuItem key={button.id} icon={Icon} onSelect={button.onClick}>
                {button.label}
              </ResponsiveDropdownMenuItem>
            );
          }
          return (
            <DropdownMenuItem key={button.id} onSelect={button.onClick}>
              <Icon className="size-(--size-icon-sm)" />
              {button.label}
            </DropdownMenuItem>
          );
        })}

        {showDevTools && !isMobile && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Developer tools</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => openLink('/dev')}>
              <LayoutGrid className="size-(--size-icon-sm)" />
              Dev Playground
              <span className="text-muted-foreground ml-auto flex items-center gap-1.5">
                <kbd className="text-3xs">{formatShortcutKey(SHORTCUTS.DEV_PLAYGROUND)}</kbd>
                <ExternalLink className="size-(--size-icon-xs)" />
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
              Router inspector
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={handleCopyDebugInfo}>
              <Copy className="size-(--size-icon-sm)" />
              Copy debug info
            </DropdownMenuItem>
          </>
        )}
        {/* On a phone the developer tools are plain rows: the sheet has no
            room for a toggle that keeps it open, and a build that ships them
            is a development build on somebody's own machine. */}
        {showDevTools && isMobile && (
          <>
            <ResponsiveDropdownMenuSeparator />
            <ResponsiveDropdownMenuItem icon={LayoutGrid} onSelect={() => openLink('/dev')}>
              Dev Playground
            </ResponsiveDropdownMenuItem>
            <ResponsiveDropdownMenuItem icon={Copy} onSelect={handleCopyDebugInfo}>
              Copy debug info
            </ResponsiveDropdownMenuItem>
          </>
        )}

        {/* Help and feedback, which used to be its own `?` trigger beside the
            footer's icons. One row has room for one fold, so it folds here —
            on a desktop. The You tab draws the same actions as rows of their
            own (`HelpRows` in the strip), so the phone's fold leaves them out
            rather than offering them twice. */}
        {!labelled && (
          <>
            <ResponsiveDropdownMenuSeparator />
            <HelpMenuItems />
          </>
        )}
      </ResponsiveDropdownMenuContent>
    </ResponsiveDropdownMenu>
  );
}
