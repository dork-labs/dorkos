import { memo, useCallback } from 'react';
import { Handle, Position, NodeToolbar, type NodeProps } from '@xyflow/react';
import { AnimatePresence, motion } from 'motion/react';
import { Zap, Clock, Settings, Heart, Copy, MessageCircle } from 'lucide-react';
import { usePrefersReducedMotion } from '../lib/use-reduced-motion';
import { useLodBand } from '../lib/use-lod-band';
import { relativeTime } from '../lib/relative-time';
import { toast } from 'sonner';
import { cn } from '@/layers/shared/lib';
import { Badge } from '@/layers/shared/ui/badge';
import { AgentAvatar } from '@/layers/entities/agent';

/**
 * Data shape stored in each agent node for React Flow rendering.
 * The index signature satisfies @xyflow/react's `Record<string, unknown>` constraint on Node<T>.
 */
export interface AgentNodeData extends Record<string, unknown> {
  label: string;
  runtime: string;
  healthStatus: 'active' | 'inactive' | 'stale' | 'unreachable';
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
  /** Resolved agent visual color (from resolveAgentVisual) for the AgentAvatar. */
  avatarColor: string;
  emoji: string;
  /** Absolute filesystem path for the agent's project directory. */
  projectPath?: string;
  onOpenSettings?: (agentId: string) => void;
  onViewHealth?: (agentId: string) => void;
  onOpenChat?: (agentId: string, projectPath: string) => void;
}

/** Resolve the left-border color: agent color overrides namespace color. */
function resolveBorderColor(d: AgentNodeData): string | undefined {
  return d.color ?? d.namespaceColor ?? undefined;
}

/** Duration for LOD cross-fade animations (seconds). */
const LOD_FADE_DURATION = 0.2;

/** Duration for LOD width resize animation (seconds). */
const LOD_RESIZE_DURATION = 0.25;

/** Width per LOD band (px), matching the inner card widths. */
const AGENT_BAND_WIDTHS: Record<string, number> = {
  compact: 120,
  default: 200,
  expanded: 240,
};

/**
 * Shared card header used by both DefaultCard and ExpandedCard.
 * Renders the AgentAvatar (with health ring), agent name, and the
 * runtime + capability badge row.
 */
function CardHeader({ d }: { d: AgentNodeData }) {
  const overflowCount = Math.max(0, d.capabilities.length - 3);

  return (
    <>
      {/* Header row: avatar + name */}
      <div className="flex items-center gap-2">
        <AgentAvatar
          color={d.avatarColor}
          emoji={d.emoji}
          healthStatus={d.healthStatus}
          size="sm"
        />
        <span className="text-foreground truncate text-sm font-medium">{d.label}</span>
      </div>

      {/* Runtime + capability badges */}
      <div className="mt-1 flex flex-wrap gap-1">
        <Badge variant="secondary" className="text-[10px]">
          {d.runtime}
        </Badge>
        {d.capabilities.slice(0, 3).map((cap) => (
          <Badge key={cap} variant="outline" className="text-[10px]">
            {cap}
          </Badge>
        ))}
        {overflowCount > 0 && (
          <Badge variant="outline" className="text-muted-foreground text-[10px]">
            +{overflowCount}
          </Badge>
        )}
      </div>
    </>
  );
}

/** Compact pill rendered when zoom < 0.6 (~120x28px). */
function CompactPill({ d, selected }: { d: AgentNodeData; selected?: boolean }) {
  const borderColor = resolveBorderColor(d);

  return (
    <div
      className={cn(
        'bg-card flex w-[120px] items-center gap-1.5 rounded-full border px-2 py-0.5 shadow-sm',
        selected && 'ring-primary ring-2'
      )}
      style={borderColor ? { borderLeft: `3px solid ${borderColor}` } : undefined}
    >
      <Handle type="target" position={Position.Left} className="bg-muted-foreground!" />
      <AgentAvatar color={d.avatarColor} emoji={d.emoji} healthStatus={d.healthStatus} size="xs" />
      <span className="text-foreground truncate text-xs font-medium">{d.label}</span>
      <Handle type="source" position={Position.Right} className="bg-muted-foreground!" />
    </div>
  );
}

/** Default card rendered when zoom is 0.6-1.2 (~200x72px). */
function DefaultCard({ d, selected }: { d: AgentNodeData; selected?: boolean }) {
  const borderColor = resolveBorderColor(d);
  const hasRelay = d.relayAdapters && d.relayAdapters.length > 0;
  const hasPulse = d.pulseScheduleCount != null && d.pulseScheduleCount > 0;

  return (
    <div
      className={cn(
        'bg-card w-[200px] rounded-lg border px-3 py-2 shadow-sm hover:shadow-md',
        selected && 'ring-primary ring-2'
      )}
      style={borderColor ? { borderLeft: `3px solid ${borderColor}` } : undefined}
    >
      <Handle type="target" position={Position.Left} className="bg-muted-foreground!" />

      <CardHeader d={d} />

      {/* Bottom indicator row */}
      {(hasRelay || hasPulse) && (
        <div className="text-muted-foreground mt-1.5 flex items-center gap-2">
          {hasRelay && <Zap className="size-3" />}
          {hasPulse && (
            <span className="flex items-center gap-0.5">
              <Clock className="size-3" />
              <span className="text-[10px]">{d.pulseScheduleCount}</span>
            </span>
          )}
        </div>
      )}

      <Handle type="source" position={Position.Right} className="bg-muted-foreground!" />
    </div>
  );
}

/** Expanded card rendered when zoom > 1.2 (~240x120px). */
function ExpandedCard({ d, selected }: { d: AgentNodeData; selected?: boolean }) {
  const borderColor = resolveBorderColor(d);
  const hasRelay = d.relayAdapters && d.relayAdapters.length > 0;
  const hasPulse = d.pulseScheduleCount != null && d.pulseScheduleCount > 0;

  return (
    <div
      className={cn(
        'bg-card w-[240px] rounded-lg border px-3 py-2 shadow-sm hover:shadow-md',
        selected && 'ring-primary ring-2'
      )}
      style={borderColor ? { borderLeft: `3px solid ${borderColor}` } : undefined}
    >
      <Handle type="target" position={Position.Left} className="bg-muted-foreground!" />

      <CardHeader d={d} />

      {/* Description */}
      {d.description && (
        <p className="text-muted-foreground mt-1.5 line-clamp-2 text-xs">{d.description}</p>
      )}

      {/* Relay adapters + Pulse schedule count */}
      {(hasRelay || hasPulse) && (
        <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-2">
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
        <p className="text-muted-foreground mt-1 text-[10px]">
          {d.budget.maxCallsPerHour} calls/hr &middot; {d.budget.maxHopsPerMessage} max hops
        </p>
      )}

      {/* Bottom row: last seen + behavior mode */}
      <div className="mt-1 flex items-center gap-2">
        {d.lastSeenAt && (
          <span className="text-muted-foreground text-[10px]">{relativeTime(d.lastSeenAt)}</span>
        )}
        {d.behavior && (
          <Badge variant="outline" className="text-[10px]">
            {d.behavior.responseMode}
          </Badge>
        )}
      </div>

      <Handle type="source" position={Position.Right} className="bg-muted-foreground!" />
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
      className="text-muted-foreground hover:bg-muted hover:text-foreground rounded-md p-1.5"
    >
      <Icon className="size-3.5" />
    </button>
  );
}

/** React Flow custom node that renders a mesh agent with contextual zoom LOD. */
function AgentNodeComponent({ data, selected, id }: NodeProps) {
  const d = data as unknown as AgentNodeData;
  const band = useLodBand();
  const prefersReducedMotion = usePrefersReducedMotion();

  const handleCopyId = useCallback(() => {
    void navigator.clipboard.writeText(id);
    toast.success('Agent ID copied');
  }, [id]);

  const toolbar = (
    <NodeToolbar position={Position.Top} isVisible={selected}>
      <div className="bg-card flex items-center gap-0.5 rounded-lg border px-1 py-0.5 shadow-md">
        {d.onOpenSettings && (
          <ToolbarButton icon={Settings} label="Settings" onClick={() => d.onOpenSettings?.(id)} />
        )}
        {d.onViewHealth && (
          <ToolbarButton icon={Heart} label="Health" onClick={() => d.onViewHealth?.(id)} />
        )}
        <ToolbarButton icon={Copy} label="Copy ID" onClick={handleCopyId} />
        {d.onOpenChat && d.projectPath && (
          <ToolbarButton
            icon={MessageCircle}
            label="Chat"
            onClick={() => d.onOpenChat?.(id, d.projectPath ?? '')}
          />
        )}
      </div>
    </NodeToolbar>
  );

  const ariaLabel = `Agent: ${d.label}, status ${d.healthStatus}`;

  let content: React.ReactNode;
  if (band === 'compact') {
    content = <CompactPill d={d} selected={selected} />;
  } else if (band === 'expanded') {
    content = <ExpandedCard d={d} selected={selected} />;
  } else {
    content = <DefaultCard d={d} selected={selected} />;
  }

  return (
    <div aria-label={ariaLabel}>
      {toolbar}
      <motion.div
        animate={{ width: AGENT_BAND_WIDTHS[band] }}
        transition={{
          width: {
            duration: prefersReducedMotion ? 0 : LOD_RESIZE_DURATION,
            ease: 'easeInOut',
          },
        }}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={band}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: prefersReducedMotion ? 0 : LOD_FADE_DURATION }}
          >
            {content}
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

export const AgentNode = memo(AgentNodeComponent);
