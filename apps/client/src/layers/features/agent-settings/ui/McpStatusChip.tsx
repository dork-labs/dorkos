import { Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';

/** Presentation for one live status: the dot color, a short label, and a tooltip. */
interface StatusMeta {
  /** The short chip label a person reads at a glance. */
  label: string;
  /** The fuller sentence the tooltip expands to. */
  tooltip: string;
  /** The dot's color class. */
  dot: string;
}

// Live MCP status presentation, keyed by the status a runtime reports. Before
// DOR-943 this was a color-only dot with `aria-hidden` and no label — legible to
// nobody using a screen reader and cryptic to everyone else.
const MCP_STATUS_META: Partial<Record<string, StatusMeta>> = {
  connected: {
    label: 'Connected',
    tooltip: 'Connected — this server’s tools are available to the agent.',
    dot: 'bg-green-500',
  },
  failed: {
    label: 'Failed',
    tooltip: 'The server could not be reached. Use Test for the reason.',
    dot: 'bg-red-500',
  },
  'needs-auth': {
    label: 'Needs sign-in',
    tooltip: 'Sign in to let this agent use the server.',
    dot: 'bg-amber-500',
  },
  pending: {
    label: 'Connecting…',
    tooltip: 'Connecting to the server.',
    dot: 'bg-amber-500',
  },
  disabled: {
    label: 'Disabled',
    tooltip: 'Turned off — its tools are not injected.',
    dot: 'bg-muted-foreground/20',
  },
};

/** Fallback for a server whose runtime has not reported a status yet. */
const UNKNOWN_STATUS_META: StatusMeta = {
  label: 'Unknown',
  tooltip: 'No status reported yet.',
  dot: 'bg-muted-foreground/40',
};

/**
 * A labeled status chip (dot + text) with a tooltip for a managed or discovered
 * server's live connection state. The text label carries the accessible name;
 * the dot is decorative (`aria-hidden`).
 *
 * @param props.statusKey - The live status a runtime reports, or `undefined`.
 */
export function StatusChip({ statusKey }: { statusKey: string | undefined }) {
  const meta = MCP_STATUS_META[statusKey ?? ''] ?? UNKNOWN_STATUS_META;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex shrink-0 items-center gap-1.5" aria-label={`Status: ${meta.label}`}>
          <span className={cn('size-2 shrink-0 rounded-full', meta.dot)} aria-hidden />
          <span className="text-muted-foreground text-xs">{meta.label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{meta.tooltip}</TooltipContent>
    </Tooltip>
  );
}
