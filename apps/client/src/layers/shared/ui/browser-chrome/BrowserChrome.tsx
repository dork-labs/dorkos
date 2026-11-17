import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, CircleAlert, RotateCw, X, type LucideIcon } from 'lucide-react';
import { cn } from '@/layers/shared/lib/utils';
import { useIsMobile } from '../../model';
import { Button } from '../button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../tooltip';
import { AddressField } from './AddressField';

/**
 * Whether the seam under the chrome turns brand orange while an agent drives
 * the page. One switch, because the orange may be vetoed (DOR-4427): the
 * design system keeps orange for "this is about you", and an agent at the
 * wheel is a judgment call. Off, the seam stays its resting tint.
 */
export const SEAM_SHOWS_AGENT_DRIVING = true;

/**
 * How long a pointer rests on a chrome button before its tooltip opens. Passing
 * over the row on the way to the page opens nothing, which matters most over a
 * native page: each tooltip there puts a still in the page's place (DOR-4427).
 */
export const CHROME_TOOLTIP_DELAY_MS = 500;

/**
 * A still of the page taken before a tooltip opens over it, for a page that a
 * tooltip would otherwise blank: `prepare` answers whether one is in place, and
 * `release` drops one no tooltip came to use.
 */
export interface ChromeTooltipStill {
  prepare: () => Promise<boolean>;
  release: () => void;
}

/** The still the chrome's buttons ask for, when the page under them needs one. */
const TooltipStillContext = createContext<ChromeTooltipStill | null>(null);

/** Props for {@link BrowserChrome}. */
export interface BrowserChromeProps {
  /** The address open now, drawn simply at rest. */
  url: string;
  /** Whether the one HTTP fallback opened this page and it is still on HTTP. */
  openedOverHttp?: boolean;
  /** A new number opens the address field, all selected: ⌘L. */
  focusAddress?: number;
  /** Whether there is a page to go back to. */
  canBack: boolean;
  /** Whether there is a page to go forward to. */
  canForward: boolean;
  /** Go back. Omit it where the browser cannot yet, and the button stays disabled. */
  onBack?: () => void;
  /** Go forward. Omit it where the browser cannot yet, and the button stays disabled. */
  onForward?: () => void;
  /** Reload the page. */
  onReload: () => void;
  /**
   * Whether the browser is busy with another action. Reload is disabled, and
   * Enter keeps the field open on what was typed rather than dropping it.
   */
  busy?: boolean;
  /** Whether the page is loading, which turns Reload into Stop. */
  loading?: boolean;
  /** Stop loading. Reload shows instead while it is absent. */
  onStop?: () => void;
  /** What the person typed, committed with Enter. */
  onSubmit: (value: string) => void;
  /**
   * What was typed when it did not open, to reopen the field on in edit mode.
   * Each new `attempt` reopens it, even for the same text typed twice.
   */
  retry?: { draft: string; attempt: number } | null;
  /** One line under the chrome saying why something did not open. */
  notice?: string | null;
  /** Whether an agent is driving the page right now. */
  agentDriving?: boolean;
  /**
   * For a page a tooltip would blank (the Agent browser's native page): each
   * tooltip opens only once a still is in the page's place, and with no still
   * the button keeps a plain `title` hint instead.
   */
  tooltipStill?: ChromeTooltipStill;
  /** The status pill's place, right of the address. */
  status?: ReactNode;
  /**
   * The ⋯ menu's place, at the end. While it is here, Forward leaves the row
   * below 480px, so the menu must offer Forward itself.
   */
  menu?: ReactNode;
  /** Any other button at the end of the row, before the menu. */
  trailing?: ReactNode;
  /** Extra classes for the outer element. */
  className?: string;
}

/**
 * The browser's navigation chrome, shared by the canvas browser and the Agent
 * browser: one 36px row (48px on a phone) on the page background, with Back,
 * Forward and Reload (Stop while loading), the address filling the rest, and
 * places for a status pill and a ⋯ menu. Under it, a 2px seam, and a 28px
 * notice line only when there is something to say (it wraps rather than cut a
 * reason off on a narrow panel).
 *
 * It sizes itself by its own width, not the window's: from 480px everything
 * shows; below that the path drops and, once a ⋯ menu exists, Forward moves
 * into it. On a phone, Reload moves inside the address field's right end.
 */
export function BrowserChrome({
  url,
  openedOverHttp = false,
  focusAddress,
  canBack,
  canForward,
  onBack,
  onForward,
  onReload,
  busy = false,
  loading = false,
  onStop,
  onSubmit,
  retry = null,
  notice = null,
  agentDriving = false,
  tooltipStill,
  status,
  menu,
  trailing,
  className,
}: BrowserChromeProps) {
  const stopping = loading && onStop !== undefined;
  // On a phone, Reload sits inside the field's right end rather than taking a
  // 44px slot of its own (spec §12). Crossing `md` moves it to the other parent,
  // which remounts it and drops an open tooltip; that is fine, and intended.
  const phone = useIsMobile();
  const reload = (
    <ChromeButton
      label={stopping ? 'Stop' : 'Reload'}
      icon={stopping ? X : RotateCw}
      disabled={busy && !stopping}
      onClick={stopping ? onStop : onReload}
      className={phone ? 'absolute top-1/2 right-0 -translate-y-1/2' : undefined}
    />
  );
  const end = status || trailing || menu;
  return (
    <TooltipProvider delayDuration={CHROME_TOOLTIP_DELAY_MS}>
      <TooltipStillContext.Provider value={tooltipStill ?? null}>
        <div
          data-slot="browser-chrome"
          className={cn(
            'bg-background @container/browser-chrome flex shrink-0 flex-col',
            className
          )}
        >
          <div
            data-slot="browser-chrome-row"
            aria-busy={loading}
            // A phone's 390px: 10 + Back 44 + 6 + field + 6 + pill 44 + ⋯ 44 + 10. A
            // minimum, not a height: a wrapped address grows the row, never clips (DOR-4655),
            // and the 44px controls stay centred.
            className="flex min-h-12 items-center gap-1.5 px-2.5 md:min-h-9 md:gap-1"
          >
            <ChromeButton label="Back" icon={ArrowLeft} disabled={!canBack} onClick={onBack} />
            <ChromeButton
              label="Forward"
              icon={ArrowRight}
              disabled={!canForward}
              onClick={onForward}
              className={menu ? 'hidden @min-[480px]/browser-chrome:inline-flex' : undefined}
            />
            {!phone && reload}
            {/* On a phone the field keeps Reload's 44px plus 44 of host, which
              truncates; below that the pill goes icon-only rather than squeeze it. */}
            <div
              data-slot="browser-chrome-field"
              className="relative flex min-w-0 flex-1 max-md:min-w-22"
            >
              {/* Keyed on the retry so a refused address reopens the field in edit
                mode, holding what was typed rather than the page still open. */}
              <AddressField
                key={retry === null ? 'address' : `retry:${retry.attempt}`}
                url={url}
                openedOverHttp={openedOverHttp}
                focusRequest={focusAddress}
                startEditing={retry !== null}
                initialDraft={retry?.draft}
                busy={busy}
                endButton={phone}
                onSubmit={onSubmit}
              />
              {phone && reload}
            </div>
            {end && (
              <div
                data-slot="browser-chrome-end"
                // `empty:hidden`: a menu with nothing in it renders nothing, and an
                // empty group must not add a gap of its own to the row.
                className="flex shrink-0 items-center gap-0 empty:hidden md:gap-1"
              >
                {status}
                {trailing}
                {menu}
              </div>
            )}
          </div>
          <div
            aria-hidden
            data-slot="browser-chrome-seam"
            data-agent-driving={agentDriving || undefined}
            className={cn(
              'h-0.5 shrink-0',
              agentDriving && SEAM_SHOWS_AGENT_DRIVING ? 'bg-brand' : 'bg-foreground/5'
            )}
          />
          {notice && (
            <p
              role="alert"
              className="text-foreground flex min-h-7 shrink-0 items-center gap-1.5 px-2.5 py-1 text-xs"
            >
              {/* The glyph is what makes it read as a refusal rather than a hint (spec §6).
                  Only it is red: muted words would read weaker than the refusal is (spec §2). */}
              <CircleAlert aria-hidden className="text-destructive size-4 shrink-0" />
              <span className="min-w-0">{notice}</span>
            </p>
          )}
        </div>
      </TooltipStillContext.Provider>
    </TooltipProvider>
  );
}

/**
 * One 28px ghost icon button (44px on a phone), named by its `aria-label` and
 * shown in a tooltip. With no handler it stays disabled. Over a page that needs
 * a still, the tooltip's words appear only once the still is in place, and
 * without one the button falls back to a plain `title` hint for that hover.
 *
 * Radix keeps its own open state, so its delay bookkeeping (and the quick
 * reopen while moving along the row) stays right; this only holds back the
 * content until the page under it is safe to cover.
 */
export function ChromeButton({
  label,
  icon: Icon,
  disabled,
  onClick,
  className,
}: {
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  const still = useContext(TooltipStillContext);
  const [ready, setReady] = useState(false);
  const [hintOnly, setHintOnly] = useState(false);
  // The latest request for a still; an older answer, or one after closing, is ignored.
  const request = useRef(0);
  const holding = useRef(false);
  const stillRef = useRef(still);
  useEffect(() => {
    stillRef.current = still;
  }, [still]);
  const giveBack = () => {
    request.current += 1;
    setReady(false);
    if (holding.current) {
      holding.current = false;
      stillRef.current?.release();
    }
  };
  // A button that goes away mid-hover gives its still back, so no old picture lingers.
  useEffect(
    () => () => {
      request.current += 1;
      if (holding.current) stillRef.current?.release();
    },
    []
  );
  const onOpenChange = (open: boolean) => {
    if (!still) return;
    if (!open) {
      giveBack();
      setHintOnly(false);
      return;
    }
    const mine = ++request.current;
    holding.current = true;
    void still.prepare().then((drawn) => {
      if (mine !== request.current) return;
      if (drawn) {
        setReady(true);
        return;
      }
      // No still: keep the page and name the button the plain way instead.
      holding.current = false;
      still.release();
      setHintOnly(true);
    });
  };
  return (
    <Tooltip onOpenChange={onOpenChange} disableHoverableContent={still !== null}>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          title={hintOnly ? label : undefined}
          disabled={onClick === undefined || disabled}
          onClick={onClick}
          className={cn('text-muted-foreground hover:text-foreground md:size-7', className)}
        >
          <Icon aria-hidden />
        </Button>
      </TooltipTrigger>
      {(still === null || ready) && <TooltipContent>{label}</TooltipContent>}
    </Tooltip>
  );
}
