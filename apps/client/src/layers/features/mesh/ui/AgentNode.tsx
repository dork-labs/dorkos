import { memo, useCallback } from 'react';
import { Handle, Position, NodeToolbar, type NodeProps } from '@xyflow/react';
import { AnimatePresence, motion } from 'motion/react';
import { Zap, Clock, UserRound, Heart, Copy, MessageCircle } from 'lucide-react';
import { usePrefersReducedMotion } from '../lib/use-reduced-motion';
import { useLodBand } from '../lib/use-lod-band';
import { cn, formatRelativeTime, useCopyFeedback } from '@/layers/shared/lib';
import { Badge } from '@/layers/shared/ui/badge';
import { Button } from '@/layers/shared/ui/button';
import { AgentAvatar } from '@/layers/entities/agent';
import { HEALTH_DISPLAY } from '../lib/health-display';

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
  taskCount?: number;
  lastSeenAt?: string | null;
  behavior?: { responseMode: string };
  color?: string | null;
  /** Resolved agent visual color (from resolveAgentVisual) for the AgentAvatar. */
  avatarColor: string;
  emoji: string;
  /** Absolute filesystem path for the agent's project directory. */
  projectPath?: string;
  /** View this agent's profile — the toolbar's door to everything about it. */
  onViewProfile?: (agentId: string) => void;
  /** Select the agent — opens its health/detail panel (wired to onSelectAgent). */
  onSelectAgent?: (agentId: string) => void;
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
 * The agent's mesh health, said where mesh health is the subject.
 *
 * It used to be a coloured ring around the disc, drawn by `AgentAvatar` — which
 * meant every list row in the cockpit carried it, and this page, the one that
 * actually needs it, carried it no more loudly than a table cell did. The ring
 * is gone; this dot is the topology's own answer, and it holds still, because
 * "seen within the last hour" is not a thing happening right now.
 *
 * `aria-hidden`: the node's own `aria-label` already ends in "status active".
 */
function HealthDot({ status }: { status: AgentNodeData['healthStatus'] }) {
  return (
    <span
      aria-hidden
      title={HEALTH_DISPLAY[status].label}
      className={cn('size-1.5 shrink-0 rounded-full', HEALTH_DISPLAY[status].dot)}
    />
  );
}

/**
 * Shared card header used by both DefaultCard and ExpandedCard.
 * Renders the AgentAvatar, the agent name with its health dot, and the
 * runtime + capability badge row.
 */
function CardHeader({ d }: { d: AgentNodeData }) {
  const overflowCount = Math.max(0, d.capabilities.length - 3);

  return (
    <>
      {/* Header row: avatar + name */}
      <div className="flex items-center gap-2">
        <AgentAvatar color={d.avatarColor} emoji={d.emoji} size="sm" />
        <span className="text-foreground truncate text-sm font-medium">{d.label}</span>
        <HealthDot status={d.healthStatus} />
      </div>

      {/* Runtime + capability badges */}
      <div className="mt-1 flex flex-wrap gap-1">
        <Badge size="xs" variant="secondary">
          {d.runtime}
        </Badge>
        {d.capabilities.slice(0, 3).map((cap) => (
          <Badge size="xs" key={cap} variant="outline">
            {cap}
          </Badge>
        ))}
        {overflowCount > 0 && (
          <Badge size="xs" tone="neutral" variant="outline">
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
      <AgentAvatar color={d.avatarColor} emoji={d.emoji} size="xs" />
      <span className="text-foreground truncate text-xs font-medium">{d.label}</span>
      <HealthDot status={d.healthStatus} />
      <Handle type="source" position={Position.Right} className="bg-muted-foreground!" />
    </div>
  );
}

/** Default card rendered when zoom is 0.6-1.2 (~200x72px). */
function DefaultCard({ d, selected }: { d: AgentNodeData; selected?: boolean }) {
  const borderColor = resolveBorderColor(d);
  const hasRelay = d.relayAdapters && d.relayAdapters.length > 0;
  const hasTasks = d.taskCount != null && d.taskCount > 0;

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
      {(hasRelay || hasTasks) && (
        <div className="text-muted-foreground mt-1.5 flex items-center gap-2">
          {hasRelay && <Zap className="size-3" />}
          {hasTasks && (
            <span className="flex items-center gap-0.5">
              <Clock className="size-3" />
              <span className="text-3xs">{d.taskCount}</span>
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
  const hasTasks = d.taskCount != null && d.taskCount > 0;

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

      {/* Relay adapters + Tasks schedule count */}
      {(hasRelay || hasTasks) && (
        <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-2">
          {hasRelay &&
            d.relayAdapters!.map((adapter) => (
              <span key={adapter} className="flex items-center gap-0.5">
                <Zap className="size-3" />
                <span className="text-3xs">{adapter}</span>
              </span>
            ))}
          {hasTasks && (
            <span className="flex items-center gap-0.5">
              <Clock className="size-3" />
              <span className="text-3xs">{d.taskCount}</span>
            </span>
          )}
        </div>
      )}

      {/* Bottom row: last seen + behavior mode */}
      <div className="mt-1 flex items-center gap-2">
        {d.lastSeenAt && (
          <span className="text-muted-foreground text-3xs">{formatRelativeTime(d.lastSeenAt)}</span>
        )}
        {d.behavior && (
          <Badge size="xs" variant="outline">
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
    <Button
      variant="ghost"
      size="icon-xs"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="text-muted-foreground hover:text-foreground"
    >
      <Icon />
    </Button>
  );
}

/** React Flow custom node that renders a mesh agent with contextual zoom LOD. */
function AgentNodeComponent({ data, selected, id }: NodeProps) {
  const d = data as unknown as AgentNodeData;
  const band = useLodBand();
  const prefersReducedMotion = usePrefersReducedMotion();

  // The toolbar's node stays mounted, but the button itself has no room to
  // morph a check into — the toast fallback (`useCopyFeedback`'s TSDoc).
  const { copy: copyId } = useCopyFeedback({ toastOnSettle: true });
  const handleCopyId = useCallback(() => void copyId(id), [copyId, id]);

  const toolbar = (
    <NodeToolbar position={Position.Top} isVisible={selected}>
      <div className="bg-card flex items-center gap-0.5 rounded-lg border px-1 py-0.5 shadow-md">
        {d.onViewProfile && (
          <ToolbarButton
            icon={UserRound}
            label="View profile"
            onClick={() => d.onViewProfile?.(id)}
          />
        )}
        {d.onSelectAgent && (
          <ToolbarButton icon={Heart} label="Health" onClick={() => d.onSelectAgent?.(id)} />
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
