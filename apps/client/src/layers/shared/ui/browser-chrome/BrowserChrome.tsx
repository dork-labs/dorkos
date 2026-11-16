import type { ReactNode } from 'react';
import { ArrowLeft, ArrowRight, CircleAlert, RotateCw, X, type LucideIcon } from 'lucide-react';
import { cn } from '@/layers/shared/lib/utils';
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

/** Props for {@link BrowserChrome}. */
export interface BrowserChromeProps {
  /** The address open now, drawn simply at rest. */
  url: string;
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
 * into it.
 */
export function BrowserChrome({
  url,
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
  status,
  menu,
  trailing,
  className,
}: BrowserChromeProps) {
  const stopping = loading && onStop !== undefined;
  return (
    <TooltipProvider>
      <div
        data-slot="browser-chrome"
        className={cn('bg-background @container/browser-chrome flex shrink-0 flex-col', className)}
      >
        <div
          data-slot="browser-chrome-row"
          aria-busy={loading}
          className="flex h-12 items-center gap-1 px-2.5 md:h-9"
        >
          <ChromeButton label="Back" icon={ArrowLeft} disabled={!canBack} onClick={onBack} />
          <ChromeButton
            label="Forward"
            icon={ArrowRight}
            disabled={!canForward}
            onClick={onForward}
            className={menu ? 'hidden @min-[480px]/browser-chrome:inline-flex' : undefined}
          />
          <ChromeButton
            label={stopping ? 'Stop' : 'Reload'}
            icon={stopping ? X : RotateCw}
            disabled={busy && !stopping}
            onClick={stopping ? onStop : onReload}
          />
          {/* Keyed on the retry so a refused address reopens the field in edit
              mode, holding what was typed rather than the page still open. */}
          <AddressField
            key={retry === null ? 'address' : `retry:${retry.attempt}`}
            url={url}
            startEditing={retry !== null}
            initialDraft={retry?.draft}
            busy={busy}
            onSubmit={onSubmit}
          />
          {status}
          {trailing}
          {menu}
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
            className="text-muted-foreground flex min-h-7 shrink-0 items-center gap-1.5 px-2.5 py-1 text-xs"
          >
            {/* The glyph is what makes it read as a refusal rather than a hint (spec §6). */}
            <CircleAlert aria-hidden className="text-destructive size-4 shrink-0" />
            <span className="min-w-0">{notice}</span>
          </p>
        )}
      </div>
    </TooltipProvider>
  );
}

/**
 * One 28px ghost icon button (44px on a phone), named by its `aria-label` and
 * shown in a tooltip. With no handler it stays disabled.
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
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          disabled={onClick === undefined || disabled}
          onClick={onClick}
          className={cn('text-muted-foreground hover:text-foreground md:size-7', className)}
        >
          <Icon aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
