import type { ReactNode } from 'react';
import { Pin, PinOff, RotateCcw, MoreHorizontal } from 'lucide-react';
import {
  ResponsivePopover,
  ResponsivePopoverTrigger,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  Button,
  Switch,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useIsMobile } from '@/layers/shared/model';
import {
  getGroupedRegistryItems,
  isPinnable,
  useStatusBarPins,
  type StatusBarItemConfig,
  type StatusBarItemKey,
  type StatusPromotionContext,
} from '../model/status-bar-registry';
import { statusRowValue, type SessionDiagnostics } from '../model/session-diagnostics';
import { CopyDiagnosticsButton } from './CopyDiagnosticsButton';

/** The two settings that live in the panel rather than the line. */
export interface SessionControls {
  /** Whether a sound plays when a turn finishes. */
  sound: boolean;
  /** Flip the sound setting. */
  onToggleSound: () => void;
  /** Whether background refresh is on. */
  refresh: boolean;
  /** Flip the background-refresh setting. */
  onToggleRefresh: () => void;
}

/** An action urgent enough to lead the panel on a phone, where the line has no room for it. */
interface SessionUrgentAction {
  /** Full-sentence button copy, e.g. "Compact conversation — 88% full". */
  label: string;
  /** Run the action. */
  onAction: () => void;
  /** True while it is in flight. */
  pending?: boolean;
}

interface SessionPopoverProps {
  /** Controlled open state. */
  open: boolean;
  /** Called when the panel opens or closes. */
  onOpenChange: (open: boolean) => void;
  /** Everything the panel reports about the session. */
  diagnostics: SessionDiagnostics;
  /** The sound and background-refresh settings. */
  controls: SessionControls;
  /**
   * Live state the registry's severity ranking reads. On a phone the Session rows
   * are ordered by it, so what needs attention is what you see without scrolling.
   */
  promotionContext: StatusPromotionContext;
  /**
   * An action the line had no room for, promoted to a full-width button at the top
   * of the panel. Supplied only when the width budget dropped it from the bar.
   */
  urgentAction?: SessionUrgentAction | null;
  /**
   * How many promoted items the bar's measured width could not afford, shown as
   * `+N` beside the `⋯`. This count is what makes truncation honest rather than
   * silent — the items are all still in here, one tap away.
   */
  overflowCount?: number;
}

/**
 * The Session panel — everything about this session in one place, with a pin
 * beside every row you are allowed to keep in the status line.
 *
 * Owns its own `⋯` trigger — the one anchor it will ever have — and opens as a
 * popover on desktop or a bottom sheet on a phone. It is the whole answer to both
 * "what is everything doing?" and "what do I want to keep an eye on?", which is
 * why there is no separate configure panel.
 *
 * @param props - Open state, session diagnostics, controls, and ordering hints.
 */
export function SessionPopover({
  open,
  onOpenChange,
  diagnostics,
  controls,
  promotionContext,
  urgentAction,
  overflowCount = 0,
}: SessionPopoverProps) {
  const isMobile = useIsMobile();
  const { pins, toggle, reset } = useStatusBarPins();
  const groups = getGroupedRegistryItems();
  // Widened to strings so an un-pinnable row (which has no pin control anyway)
  // can be asked the question without narrowing its key first.
  const pinned = new Set<string>(pins);

  const hidden = overflowCount > 0;

  return (
    <ResponsivePopover open={open} onOpenChange={onOpenChange}>
      <TooltipProvider>
        <Tooltip>
          <ResponsivePopoverTrigger asChild>
            <TooltipTrigger asChild>
              <button
                type="button"
                // The count belongs in the label, not just the glyph: `aria-label`
                // replaces the button's text, so a visible `+2` would be silent.
                aria-label={hidden ? `Session details, ${overflowCount} more` : 'Session details'}
                className="text-muted-foreground/50 hover:text-muted-foreground inline-flex shrink-0 items-center justify-center gap-0.5 transition-colors duration-150 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
              >
                <MoreHorizontal className="size-4" />
                {hidden && <span className="tabular-nums">+{overflowCount}</span>}
              </button>
            </TooltipTrigger>
          </ResponsivePopoverTrigger>
          <TooltipContent side="top">
            {hidden ? `Session details — ${overflowCount} more` : 'Session details'}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <ResponsivePopoverContent side="top" align="end" className="w-80 p-3" aria-label="Session">
        <ResponsivePopoverTitle>Session</ResponsivePopoverTitle>

        {urgentAction && (
          <Button
            variant="secondary"
            className="mb-3 w-full"
            disabled={urgentAction.pending}
            onClick={() => {
              urgentAction.onAction();
              onOpenChange(false);
            }}
          >
            {urgentAction.label}
          </Button>
        )}

        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <section key={group.group} className="space-y-1">
              <h3 className="text-muted-foreground px-1 text-xs font-medium tracking-wide uppercase">
                {group.label}
              </h3>
              {sortRows(group.items, isMobile ? promotionContext : null).map((item) => (
                <SessionRow
                  key={item.key}
                  item={item}
                  value={statusRowValue(item.key, diagnostics)}
                  pinned={pinned.has(item.key)}
                  onTogglePin={isPinnable(item) ? () => toggle(item.key) : null}
                  control={renderControl(item.key, controls)}
                />
              ))}
              {group.group === 'diagnostics' && (
                <>
                  <PlainRow label="Queued messages" value={String(diagnostics.queueDepth)} />
                  <PlainRow label="Session id" value={diagnostics.sessionId || '—'} />
                </>
              )}
            </section>
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between gap-2">
          <CopyDiagnosticsButton diagnostics={diagnostics} />
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground gap-1.5 text-xs"
            disabled={pins.length === 0}
            onClick={reset}
          >
            <RotateCcw className="size-3.5" aria-hidden />
            Reset pins
          </Button>
        </div>
      </ResponsivePopoverContent>
    </ResponsivePopover>
  );
}

/**
 * Order rows most-urgent-first against live state, or keep registry order when no
 * context is supplied (desktop, where there is room for all of it).
 *
 * @internal
 */
function sortRows(
  items: StatusBarItemConfig[],
  ctx: StatusPromotionContext | null
): StatusBarItemConfig[] {
  if (!ctx) return items;
  return [...items].sort((a, b) => b.severity(ctx) - a.severity(ctx));
}

/** The Controls group's own switches — every other row has no control. */
function renderControl(key: StatusBarItemKey, controls: SessionControls): ReactNode {
  if (key === 'sound') {
    return (
      <Switch
        checked={controls.sound}
        onCheckedChange={controls.onToggleSound}
        aria-label="Play a sound when a turn finishes"
      />
    );
  }
  if (key === 'polling') {
    return (
      <Switch
        checked={controls.refresh}
        onCheckedChange={controls.onToggleRefresh}
        aria-label="Keep checking for updates in the background"
      />
    );
  }
  return null;
}

/**
 * One registry row: icon and label left, live value and pin right.
 *
 * @internal
 */
function SessionRow({
  item,
  value,
  pinned,
  onTogglePin,
  control,
}: {
  item: StatusBarItemConfig;
  value: string | null;
  pinned: boolean;
  onTogglePin: (() => void) | null;
  control: ReactNode;
}) {
  const Icon = item.icon;
  return (
    <div
      data-testid={`session-row-${item.key}`}
      className="flex items-center gap-2 px-1 py-1 text-sm"
    >
      <Icon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
      <span className="shrink-0">{item.label}</span>
      <span className="min-w-0 flex-1" />
      <span className="text-muted-foreground truncate text-xs" title={value ?? undefined}>
        {value ?? '—'}
      </span>
      {control}
      {onTogglePin && (
        <button
          type="button"
          onClick={onTogglePin}
          aria-pressed={pinned}
          aria-label={
            pinned
              ? `Stop keeping ${item.label} in the status bar`
              : `Keep ${item.label} in the status bar`
          }
          className={cn(
            'hover:text-foreground inline-flex size-6 shrink-0 items-center justify-center rounded-md transition-colors duration-150',
            pinned ? 'text-foreground' : 'text-muted-foreground/50'
          )}
        >
          {pinned ? <Pin className="size-3.5" /> : <PinOff className="size-3.5" />}
        </button>
      )}
    </div>
  );
}

/**
 * A system-managed row with no registry entry and, deliberately, no pin.
 *
 * @internal
 */
function PlainRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 px-1 py-1 text-sm">
      <span className="w-3.5 shrink-0" aria-hidden />
      <span className="shrink-0">{label}</span>
      <span className="min-w-0 flex-1" />
      <span className="text-muted-foreground truncate text-xs" title={value}>
        {value}
      </span>
    </div>
  );
}
