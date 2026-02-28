import { memo, useCallback } from 'react';
import {
  Handle,
  Position,
  NodeToolbar,
  type NodeProps,
  useStore,
  type ReactFlowState,
} from '@xyflow/react';
import { Zap, Clock, Settings, Heart, Copy } from 'lucide-react';
import { usePrefersReducedMotion } from '../lib/use-reduced-motion';
import { toast } from 'sonner';
import { Badge } from '@/layers/shared/ui/badge';

/**
 * Data shape stored in each agent node for React Flow rendering.
 * The index signature satisfies @xyflow/react's `Record<string, unknown>` constraint on Node<T>.
 */
export interface AgentNodeData extends Record<string, unknown> {
  label: string;
  runtime: string;
  healthStatus: 'active' | 'inactive' | 'stale';
  capabilities: string[];
  namespace?: string;
  namespaceColor?: string;
  description?: string;
  relayAdapters?: string[];
  relaySubject?: string | null;
  pulseScheduleCount?: number;
  lastSeenAt?: string | null;
  lastSeenEvent?: string | null;
  budget?: { maxHopsPerMessage: number; maxCallsPerHour: number };
  behavior?: { responseMode: string };
  color?: string | null;
  emoji?: string | null;
  /** Working directory path for the agent, used when creating bindings. */
  agentDir?: string;
  onOpenSettings?: (agentId: string) => void;
  onViewHealth?: (agentId: string) => void;
}

const STATUS_COLORS: Record<AgentNodeData['healthStatus'], string> = {
  active: 'bg-green-500',
  inactive: 'bg-amber-500',
  stale: 'bg-zinc-400',
};

const ZOOM_COMPACT = 0.6;
const ZOOM_EXPANDED = 1.2;

const zoomSelector = (s: ReactFlowState) => s.transform[2];

/** Convert an ISO timestamp to a relative time string like "2m ago" or "3d ago". */
function relativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;

  if (Number.isNaN(diffMs) || diffMs < 0) return 'just now';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Resolve the left-border color: agent color overrides namespace color. */
function resolveBorderColor(d: AgentNodeData): string | undefined {
  return d.color ?? d.namespaceColor ?? undefined;
}

/** Compact pill rendered when zoom < 0.6 (~120x28px). */
function CompactPill({ d, dotColor }: { d: AgentNodeData; dotColor: string }) {
  const borderColor = resolveBorderColor(d);

  return (
    <div
      className="flex w-[120px] items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 shadow-sm transition-all duration-150 ease-in-out"
      style={borderColor ? { borderLeft: `3px solid ${borderColor}` } : undefined}
    >
      <Handle type="target" position={Position.Left} className="!bg-muted-foreground" />
      <span className={`h-2 w-2 shrink-0 rounded-full ${dotColor}`} />
      <span className="truncate text-xs font-medium">
        {d.emoji ? `${d.emoji} ` : ''}
        {d.label}
      </span>
      <Handle type="source" position={Position.Right} className="!bg-muted-foreground" />
    </div>
  );
}

/** Default card rendered when zoom is 0.6-1.2 (~200x72px). */
function DefaultCard({
  d,
  dotColor,
  prefersReducedMotion,
}: {
  d: AgentNodeData;
  dotColor: string;
  prefersReducedMotion: boolean;
}) {
  const borderColor = resolveBorderColor(d);
  const hasRelay = d.relayAdapters && d.relayAdapters.length > 0;
  const hasPulse = d.pulseScheduleCount != null && d.pulseScheduleCount > 0;
  const overflowCount = Math.max(0, d.capabilities.length - 3);

  return (
    <div
      className="w-[200px] rounded-lg border bg-card px-3 py-2 shadow-sm transition-all duration-150 ease-in-out"
      style={borderColor ? { borderLeft: `3px solid ${borderColor}` } : undefined}
    >
      <Handle type="target" position={Position.Left} className="!bg-muted-foreground" />

      {/* Header row: health dot + name + runtime icon */}
      <div className="flex items-center gap-2">
        <span className="relative flex shrink-0">
          <span className={`h-2.5 w-2.5 rounded-full ${dotColor}`} />
          {d.healthStatus === 'active' && !prefersReducedMotion && (
            <span className="absolute inset-0 animate-ping rounded-full bg-green-500 opacity-30" />
          )}
        </span>
        <span className="truncate text-sm font-medium">
          {d.emoji ? `${d.emoji} ` : ''}
          {d.label}
        </span>
        <Badge variant="secondary" className="ml-auto shrink-0 text-[10px]">
          {d.runtime}
        </Badge>
      </div>

      {/* Capability badges */}
      <div className="mt-1 flex flex-wrap gap-1">
        {d.capabilities.slice(0, 3).map((cap) => (
          <Badge key={cap} variant="outline" className="text-[10px]">
            {cap}
          </Badge>
        ))}
        {overflowCount > 0 && (
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            +{overflowCount}
          </Badge>
        )}
      </div>

      {/* Bottom indicator row */}
      {(hasRelay || hasPulse) && (
        <div className="mt-1.5 flex items-center gap-2 text-muted-foreground">
          {hasRelay && <Zap className="size-3" />}
          {hasPulse && (
            <span className="flex items-center gap-0.5">
              <Clock className="size-3" />
              <span className="text-[10px]">{d.pulseScheduleCount}</span>
            </span>
          )}
        </div>
      )}

      <Handle type="source" position={Position.Right} className="!bg-muted-foreground" />
    </div>
  );
}

/** Expanded card rendered when zoom > 1.2 (~240x120px). */
function ExpandedCard({
  d,
  dotColor,
  prefersReducedMotion,
}: {
  d: AgentNodeData;
  dotColor: string;
  prefersReducedMotion: boolean;
}) {
  const borderColor = resolveBorderColor(d);
  const hasRelay = d.relayAdapters && d.relayAdapters.length > 0;
  const hasPulse = d.pulseScheduleCount != null && d.pulseScheduleCount > 0;
  const overflowCount = Math.max(0, d.capabilities.length - 3);

  return (
    <div
      className="w-[240px] rounded-lg border bg-card px-3 py-2 shadow-sm transition-all duration-150 ease-in-out"
      style={borderColor ? { borderLeft: `3px solid ${borderColor}` } : undefined}
    >
      <Handle type="target" position={Position.Left} className="!bg-muted-foreground" />

      {/* Header row */}
      <div className="flex items-center gap-2">
        <span className="relative flex shrink-0">
          <span className={`h-2.5 w-2.5 rounded-full ${dotColor}`} />
          {d.healthStatus === 'active' && !prefersReducedMotion && (
            <span className="absolute inset-0 animate-ping rounded-full bg-green-500 opacity-30" />
          )}
        </span>
        <span className="truncate text-sm font-medium">
          {d.emoji ? `${d.emoji} ` : ''}
          {d.label}
        </span>
        <Badge variant="secondary" className="ml-auto shrink-0 text-[10px]">
          {d.runtime}
        </Badge>
      </div>

      {/* Capability badges */}
      <div className="mt-1 flex flex-wrap gap-1">
        {d.capabilities.slice(0, 3).map((cap) => (
          <Badge key={cap} variant="outline" className="text-[10px]">
            {cap}
          </Badge>
        ))}
        {overflowCount > 0 && (
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            +{overflowCount}
          </Badge>
        )}
      </div>

      {/* Description */}
      {d.description && (
        <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">{d.description}</p>
      )}

      {/* Relay adapters + Pulse schedule count */}
      {(hasRelay || hasPulse) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-muted-foreground">
          {hasRelay &&
            d.relayAdapters!.map((adapter) => (
              <span key={adapter} className="flex items-center gap-0.5">
                <Zap className="size-3" />
                <span className="text-[10px]">{adapter}</span>
              </span>
            ))}
          {hasPulse && (
            <span className="flex items-center gap-0.5">
              <Clock className="size-3" />
              <span className="text-[10px]">{d.pulseScheduleCount}</span>
            </span>
          )}
        </div>
      )}

      {/* Budget display */}
      {d.budget && (
        <p className="mt-1 text-[10px] text-muted-foreground">
          {d.budget.maxCallsPerHour} calls/hr &middot; {d.budget.maxHopsPerMessage} max hops
        </p>
      )}

      {/* Bottom row: last seen + behavior mode */}
      <div className="mt-1 flex items-center gap-2">
        {d.lastSeenAt && (
          <span className="text-[10px] text-muted-foreground">{relativeTime(d.lastSeenAt)}</span>
        )}
        {d.behavior && (
          <Badge variant="outline" className="text-[10px]">
            {d.behavior.responseMode}
          </Badge>
        )}
      </div>

      <Handle type="source" position={Position.Right} className="!bg-muted-foreground" />
    </div>
  );
}

/** Small icon button used in the NodeToolbar. */
function ToolbarButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <Icon className="size-3.5" />
    </button>
  );
}

/** React Flow custom node that renders a mesh agent with contextual zoom LOD. */
function AgentNodeComponent({ data, selected, id }: NodeProps) {
  const d = data as unknown as AgentNodeData;
  const dotColor = STATUS_COLORS[d.healthStatus] ?? STATUS_COLORS.stale;
  const zoom = useStore(zoomSelector);

  const prefersReducedMotion = usePrefersReducedMotion();

  const handleCopyId = useCallback(() => {
    void navigator.clipboard.writeText(id);
    toast.success('Agent ID copied');
  }, [id]);

  const toolbar = (
    <NodeToolbar position={Position.Top} isVisible={selected}>
      <div className="flex items-center gap-0.5 rounded-lg border bg-card px-1 py-0.5 shadow-md">
        {d.onOpenSettings && (
          <ToolbarButton icon={Settings} label="Settings" onClick={() => d.onOpenSettings?.(id)} />
        )}
        {d.onViewHealth && (
          <ToolbarButton icon={Heart} label="Health" onClick={() => d.onViewHealth?.(id)} />
        )}
        <ToolbarButton icon={Copy} label="Copy ID" onClick={handleCopyId} />
      </div>
    </NodeToolbar>
  );

  if (zoom < ZOOM_COMPACT) {
    return (
      <>
        {toolbar}
        <CompactPill d={d} dotColor={dotColor} />
      </>
    );
  }

  if (zoom > ZOOM_EXPANDED) {
    return (
      <>
        {toolbar}
        <ExpandedCard d={d} dotColor={dotColor} prefersReducedMotion={prefersReducedMotion} />
      </>
    );
  }

  return (
    <>
      {toolbar}
      <DefaultCard d={d} dotColor={dotColor} prefersReducedMotion={prefersReducedMotion} />
    </>
  );
}

export const AgentNode = memo(AgentNodeComponent);
