import { Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import type { McpServerEntry } from '@dorkos/shared/transport';

/**
 * Every state a chip can show: the wire contract's own status union — so the two
 * cannot drift — plus `signed-in`, which no runtime reports.
 *
 * `signed-in` exists because holding a token is not the same as having reached
 * the server. It is what a row knows when DorkOS has a sign-in but nothing has
 * contacted the server since; calling that "Connected" would claim a round trip
 * that never happened. `undefined` is not a member: a row with no status at all
 * reads Unknown.
 */
export type McpStatusKey = NonNullable<McpServerEntry['status']> | 'signed-in';

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
// nobody using a screen reader and cryptic to everyone else. Typed as a total
// record so adding a status to the wire contract fails the build here rather
// than silently rendering "Unknown".
const MCP_STATUS_META: Record<McpStatusKey, StatusMeta> = {
  connected: {
    label: 'Connected',
    tooltip: 'Connected — this server’s tools are available to the agent.',
    dot: 'bg-green-500',
  },
  'signed-in': {
    label: 'Signed in',
    tooltip: 'DorkOS has a sign-in for this server. Use Test to check it responds.',
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
 * server's live connection state. The visible text label carries the essential
 * state and its own accessible name (the dot is decorative, `aria-hidden`), so no
 * redundant `aria-label` is added. The tooltip's fuller sentence is a supplementary
 * mouse enhancement — the state a keyboard/screen-reader user needs is already in
 * the label, and making a non-interactive status a focus stop on every row would
 * add spurious tab stops.
 *
 * @param props.statusKey - The status to show, or `undefined` for "Unknown".
 */
export function McpStatusChip({ statusKey }: { statusKey: McpStatusKey | undefined }) {
  const meta = (statusKey && MCP_STATUS_META[statusKey]) || UNKNOWN_STATUS_META;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex shrink-0 items-center gap-1.5">
          <span className={cn('size-2 shrink-0 rounded-full', meta.dot)} aria-hidden />
          <span className="text-muted-foreground text-xs">{meta.label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{meta.tooltip}</TooltipContent>
    </Tooltip>
  );
}
