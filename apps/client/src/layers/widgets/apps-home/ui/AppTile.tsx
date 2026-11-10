/**
 * One app on the Apps page: a tile on a wide screen, a row on a phone
 * (DOR-3970, spec §3–4).
 *
 * The tile is one button; its "⋮" is the next tab stop and fades in on hover
 * or focus. On a phone there is no "⋮": a long press opens the same menu as a
 * bottom sheet. The line under the name is the app's own live line, or its
 * state in words, or nothing (never a truncated description).
 *
 * @module widgets/apps-home/ui/AppTile
 */
import { useRef, useState, type PointerEvent } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import {
  ExternalLink,
  MoreHorizontal,
  Pin,
  PinOff,
  Power,
  PowerOff,
  RotateCw,
  Settings,
} from 'lucide-react';
import {
  APP_NEEDS_UPDATE_COPY,
  appAccessibleName,
  useAppActions,
  useAppPins,
  useAppTrying,
  type AppEntry,
} from '@/layers/entities/extension';
import { cn, SPRING } from '@/layers/shared/lib';
import { useExtensionRegistry } from '@/layers/shared/model';
import {
  ContributedIcon,
  CORNER_COUNT_CAP,
  CountPill,
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuItem,
  ResponsiveDropdownMenuTrigger,
} from '@/layers/shared/ui';

/** How long a press rests before it opens the menu on a phone. */
const LONG_PRESS_MS = 500;

/** Props for {@link AppTile}. */
export interface AppTileProps {
  /** The app. */
  app: AppEntry;
  /** Whether it is pinned (the menu offers the other half). */
  pinned: boolean;
  /** Draw as a phone row instead of a tile. */
  asRow: boolean;
}

/** The line under the name, and how it reads. */
function stateLine(app: AppEntry, trying: boolean): { text: string; tone: string } | null {
  if (app.state === 'starting') return { text: 'Starting…', tone: 'text-muted-foreground' };
  if (trying) return { text: 'Trying…', tone: 'text-muted-foreground' };
  if (app.state === 'held') return { text: 'Needs your OK', tone: 'text-brand-text font-[550]' };
  if (app.state === 'error')
    return { text: 'Not working', tone: 'text-status-error-fg font-medium' };
  if (app.state === 'off') return { text: 'Off', tone: 'text-muted-foreground' };
  if (app.state === 'needs-update')
    return { text: APP_NEEDS_UPDATE_COPY.tileLine, tone: 'text-muted-foreground' };
  return app.line ? { text: app.line, tone: 'text-muted-foreground' } : null;
}

/**
 * Draw one app.
 *
 * @param props - The app, whether it is pinned, and which shape to draw.
 */
export function AppTile({ app, pinned, asRow }: AppTileProps) {
  const actions = useAppActions();
  const { pin, unpin } = useAppPins();
  const trying = useAppTrying(app.id);
  const reducedMotion = useReducedMotion();
  const [menuOpen, setMenuOpen] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  const icon = useExtensionRegistry(
    (state) => state.slots.pages.find((page) => page.id === app.pageId)?.icon
  );
  const line = stateLine(app, trying);
  const off = app.state === 'off';

  const startPress = (event: PointerEvent) => {
    if (!asRow || event.pointerType === 'mouse') return;
    longPressed.current = false;
    pressTimer.current = setTimeout(() => {
      longPressed.current = true;
      setMenuOpen(true);
    }, LONG_PRESS_MS);
  };
  const endPress = () => {
    if (pressTimer.current !== null) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  return (
    <motion.div
      layout={reducedMotion ? false : 'position'}
      transition={SPRING.snap}
      className="group/tile relative"
    >
      <motion.button
        type="button"
        data-testid={`apps-tile-${app.id}`}
        data-state={app.state}
        aria-label={trying ? `${app.name}, trying again` : appAccessibleName(app)}
        aria-busy={trying || app.state === 'starting' || undefined}
        disabled={trying}
        whileTap={reducedMotion ? undefined : { scale: 0.985 }}
        transition={{ duration: 0.1 }}
        onClick={() => {
          if (longPressed.current) {
            longPressed.current = false;
            return;
          }
          actions.open(app);
        }}
        onPointerDown={startPress}
        onPointerUp={endPress}
        onPointerLeave={endPress}
        onContextMenu={(event) => {
          if (!asRow) return;
          event.preventDefault();
          setMenuOpen(true);
        }}
        className={cn(
          'focus-ring bg-muted/60 hover:bg-muted flex w-full items-center gap-3 text-left transition-colors duration-150 forced-colors:outline forced-colors:outline-1',
          asRow ? 'min-h-15 rounded-lg px-3 py-2.5' : 'h-17 rounded-xl px-3.5 pr-12'
        )}
      >
        <span
          aria-hidden
          className={cn(
            'bg-secondary text-foreground flex size-10 shrink-0 items-center justify-center rounded-[10px]',
            off && 'opacity-45'
          )}
        >
          <ContributedIcon icon={icon} className="size-5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col justify-center">
          <span
            className={cn(
              'truncate font-[550]',
              asRow ? 'text-base' : 'text-sm',
              off && 'text-muted-foreground'
            )}
          >
            {app.name}
          </span>
          {line && (
            <span className={cn('truncate', asRow ? 'text-sm' : 'text-[13px]', line.tone)}>
              {line.text}
            </span>
          )}
        </span>
        {app.state === 'ok' && app.count > 0 && (
          <span
            aria-hidden
            className={cn(
              !asRow &&
                'transition-opacity group-focus-within/tile:opacity-0 group-hover/tile:opacity-0'
            )}
          >
            {/* The same neutral pill as the sidebar row, capped at 9+ (DOR-3077). */}
            <CountPill count={app.count} tone="neutral" cap={CORNER_COUNT_CAP} label="" />
          </span>
        )}
      </motion.button>
      <ResponsiveDropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <ResponsiveDropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`${app.name} actions`}
            className={cn(
              'focus-ring text-muted-foreground hover:bg-background/70 absolute top-1/2 right-2.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-md opacity-0 transition-opacity duration-150 group-focus-within/tile:opacity-100 group-hover/tile:opacity-100 focus-visible:opacity-100',
              asRow && 'pointer-events-none size-0 overflow-hidden'
            )}
            {...(asRow ? { tabIndex: -1 } : {})}
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </button>
        </ResponsiveDropdownMenuTrigger>
        <ResponsiveDropdownMenuContent align="end">
          {app.state === 'error' && (
            <ResponsiveDropdownMenuItem
              icon={RotateCw}
              onSelect={() => void actions.tryAgain(app.id)}
            >
              Try again
            </ResponsiveDropdownMenuItem>
          )}
          <ResponsiveDropdownMenuItem
            icon={ExternalLink}
            onSelect={() => actions.openInNewTab(app)}
          >
            Open in new tab
          </ResponsiveDropdownMenuItem>
          {!off && (
            <ResponsiveDropdownMenuItem
              icon={pinned ? PinOff : Pin}
              onSelect={() => (pinned ? unpin(app.id) : pin(app.id))}
            >
              {pinned ? 'Unpin' : 'Pin'}
            </ResponsiveDropdownMenuItem>
          )}
          <ResponsiveDropdownMenuItem icon={Settings} onSelect={() => actions.openSettings(app.id)}>
            Settings
          </ResponsiveDropdownMenuItem>
          <ResponsiveDropdownMenuItem
            icon={off ? Power : PowerOff}
            onSelect={() => void actions.setOn(app.id, off)}
          >
            {off ? 'Turn on' : 'Turn off'}
          </ResponsiveDropdownMenuItem>
        </ResponsiveDropdownMenuContent>
      </ResponsiveDropdownMenu>
    </motion.div>
  );
}
