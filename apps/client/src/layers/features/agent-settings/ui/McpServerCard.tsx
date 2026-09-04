import { useId, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cva } from 'class-variance-authority';
import { Badge, Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { MCP_STATUS_META, type McpCardTone } from '../lib/mcp-card-copy';
import type { McpCardStatus } from '../lib/mcp-server-state';
import { scopeTooltip, type McpServerScope } from '../lib/mcp-scope';

/** The card's frame. */
const cardVariants = cva(
  'border-border/60 relative overflow-hidden rounded-md border px-3 py-2.5 transition-colors',
  {
    variants: {
      /** A server DorkOS does not manage sits on a quieter surface than one it does. */
      managed: {
        true: 'bg-card',
        false: 'bg-muted/30',
      },
      dimmed: {
        true: 'opacity-65',
        false: '',
      },
    },
    defaultVariants: { managed: true, dimmed: false },
  }
);

/**
 * The accent down the card's left side, for the tones that have one.
 *
 * A painted strip rather than a `border-l-*` colour, because a left-border colour
 * has to beat the all-sides `border-border/60` on the same element and which of
 * the two wins is decided by their order in Tailwind's generated stylesheet, not
 * by the order they are written in — it lost, silently, and the accent simply did
 * not appear. It is never the sole carrier of meaning either way: the chip beside
 * it says the state in words.
 */
const accentVariants = cva('pointer-events-none absolute inset-y-0 left-0 w-0.5', {
  variants: {
    tone: {
      calm: 'hidden',
      attention: 'bg-status-warning',
      error: 'bg-status-error',
    },
  },
  defaultVariants: { tone: 'calm' },
});

/** The status chip: a pill whose color echoes the word it already says. */
const chipVariants = cva(
  'shrink-0 rounded-full px-2 py-0.5 text-2xs leading-4 font-medium whitespace-nowrap',
  {
    variants: {
      chip: {
        success: 'bg-status-success-bg text-status-success-fg',
        info: 'bg-status-info-bg text-status-info-fg',
        warning: 'bg-status-warning-bg text-status-warning-fg',
        error: 'bg-status-error-bg text-status-error-fg',
        neutral: 'bg-muted text-muted-foreground',
      },
    },
    defaultVariants: { chip: 'neutral' },
  }
);

/** Which chip color each state wears. */
const CHIP_COLOR: Record<McpCardStatus, 'success' | 'info' | 'warning' | 'error' | 'neutral'> = {
  connected: 'success',
  'signed-in': 'info',
  'needs-sign-in': 'warning',
  'signing-in': 'warning',
  'cant-reach': 'error',
  'setup-problem': 'error',
  'uses-your-key': 'neutral',
  connecting: 'neutral',
  'not-checked': 'neutral',
  off: 'neutral',
};

/**
 * The status chip. The visible label carries the state and its own accessible
 * name, so the tooltip is a supplementary mouse enhancement rather than the only
 * place the state is written — and the chip is not made a focus stop, which on a
 * list of cards would add a spurious tab stop per card.
 *
 * @param props.status - The state to show.
 */
function McpStatusChip({ status }: { status: McpCardStatus }) {
  const meta = MCP_STATUS_META[status];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={chipVariants({ chip: CHIP_COLOR[status] })}>{meta.label}</span>
      </TooltipTrigger>
      <TooltipContent>{meta.tooltip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The neutral badge saying where a server came from. Never status-colored: on
 * this card, color means "how is it doing", and a scope that borrowed it would
 * make a perfectly healthy project server look like a warning.
 *
 * @param props.scope - Which of the four origins this server has.
 * @param props.pluginName - The plugin it ships with, when its name says so.
 */
function McpScopeBadge({
  scope,
  pluginName,
}: {
  scope: McpServerScope;
  pluginName: string | null;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge size="xs" tone="neutral" variant="secondary" className="shrink-0 font-normal">
          {scope}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{scopeTooltip(scope, pluginName)}</TooltipContent>
    </Tooltip>
  );
}

/** Props for {@link McpServerCard}. */
export interface McpServerCardProps {
  /** The server's readable name — parsed, so a plugin id shows clean. */
  displayName: string;
  /** The raw name, used to anchor the card for tests and page objects. */
  rawName: string;
  /** Where the server came from, or `null` when the runtime would not say. */
  scope: McpServerScope | null;
  /** The plugin it ships with, when its name says so. */
  pluginName: string | null;
  /** The state the chip shows. */
  status: McpCardStatus;
  /** The one plain sentence under the name, or `null` when a child says it all. */
  sentence: string | null;
  /** Whether DorkOS manages this server (drives the surface and the dimming). */
  managed: boolean;
  /** The enable switch, rightmost on line 1. Absent for servers DorkOS does not manage. */
  toggle?: ReactNode;
  /** The state's single primary action plus the overflow menu. */
  actions?: ReactNode;
  /** Anything that renders between the sentence and the action row (the sign-in surface). */
  children?: ReactNode;
  /** The Details body. Absent means the card offers no Details at all. */
  details?: ReactNode;
  /**
   * Whether Details starts open. Off everywhere in the product — a panel of
   * cards that all opened themselves would bury the list — and on in the Dev
   * Playground, where the point of the demo IS the open state.
   */
  defaultDetailsOpen?: boolean;
}

/**
 * One MCP server, as a card: name, where it came from, how it is doing, one
 * sentence about what to do, one action, and Details on request.
 *
 * The same shape serves a server DorkOS manages and one it only knows about,
 * because the difference between them is what the card can DO, not what a person
 * needs to read. The tone (and so the left edge) is derived from the status
 * rather than passed in, so a card cannot show an amber edge beside a green chip.
 */
export function McpServerCard({
  displayName,
  rawName,
  scope,
  pluginName,
  status,
  sentence,
  managed,
  toggle,
  actions,
  children,
  details,
  defaultDetailsOpen = false,
}: McpServerCardProps) {
  const [detailsOpen, setDetailsOpen] = useState(defaultDetailsOpen);
  const detailsId = useId();
  const tone: McpCardTone = MCP_STATUS_META[status].tone;

  return (
    <div
      data-mcp-server={rawName}
      className={cn(cardVariants({ managed, dimmed: status === 'off' }), 'mb-2 last:mb-0')}
    >
      <span className={accentVariants({ tone })} aria-hidden />
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{displayName}</span>
        {scope && <McpScopeBadge scope={scope} pluginName={pluginName} />}
        <McpStatusChip status={status} />
        {toggle}
      </div>

      {sentence && <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{sentence}</p>}

      {children}

      {actions && <div className="mt-2 flex items-center gap-1">{actions}</div>}

      {details && (
        <>
          <button
            type="button"
            onClick={() => setDetailsOpen((open) => !open)}
            aria-expanded={detailsOpen}
            aria-controls={detailsId}
            className="text-muted-foreground hover:text-foreground mt-2 flex items-center gap-1 text-xs focus-visible:ring-2"
          >
            <ChevronRight
              className={cn('size-3 transition-transform', detailsOpen && 'rotate-90')}
              aria-hidden
            />
            Details
          </button>
          {detailsOpen && (
            <div id={detailsId}>
              {details}
              <button
                type="button"
                onClick={() => setDetailsOpen(false)}
                className="text-muted-foreground hover:text-foreground mt-2 flex items-center gap-1 text-xs focus-visible:ring-2"
              >
                <ChevronRight className="size-3 -rotate-90" aria-hidden />
                Collapse details
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
