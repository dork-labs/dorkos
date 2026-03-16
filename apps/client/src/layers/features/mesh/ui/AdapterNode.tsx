import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AnimatePresence, motion } from 'motion/react';
import { MessageSquare, Webhook, Bot, Plus } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { Badge } from '@/layers/shared/ui/badge';
import { useLodBand } from '../lib/use-lod-band';
import { usePrefersReducedMotion } from '../lib/use-reduced-motion';

/**
 * Data shape for adapter nodes in the React Flow topology graph.
 * The index signature satisfies @xyflow/react's `Record<string, unknown>` constraint.
 */
export interface AdapterNodeData extends Record<string, unknown> {
  adapterName: string;
  adapterType: string;
  adapterStatus: 'running' | 'stopped' | 'error';
  bindingCount: number;
  /** User-facing label to distinguish multiple instances of the same adapter type. */
  label?: string;
  /** When true, renders as a dashed-border ghost placeholder. */
  isGhost?: boolean;
  /** Click handler for ghost node — opens the adapter setup wizard. */
  onGhostClick?: () => void;
}

/** Dimensions used by the ELK layout engine for adapter nodes. */
export const ADAPTER_NODE_WIDTH = 200;
export const ADAPTER_NODE_HEIGHT = 100;

/** Duration for LOD cross-fade animations (seconds). */
const LOD_FADE_DURATION = 0.2;

/** Duration for LOD width resize animation (seconds). */
const LOD_RESIZE_DURATION = 0.25;

/** Width per LOD band (px), matching the inner card widths. */
const ADAPTER_BAND_WIDTHS: Record<string, number> = {
  compact: 120,
  default: ADAPTER_NODE_WIDTH,
};

const STATUS_COLORS: Record<string, string> = {
  running: 'bg-green-500',
  stopped: 'bg-zinc-400',
  error: 'bg-red-500',
};

const PLATFORM_ICONS: Record<string, React.ElementType> = {
  telegram: MessageSquare,
  webhook: Webhook,
};

/** Renders the platform icon for an adapter type. Extracted as a component to satisfy React Compiler. */
function PlatformIcon({ adapterType }: { adapterType: string }) {
  const Icon = PLATFORM_ICONS[adapterType] ?? Bot;
  return <Icon className="size-4 shrink-0 text-muted-foreground" />;
}

/** Resolve the status indicator color, falling back to zinc. */
function resolveStatusColor(status: string): string {
  return STATUS_COLORS[status] ?? 'bg-zinc-400';
}

/** Compact pill rendered when zoom < 0.6 (~120x32px). */
function AdapterCompactPill({
  d,
  statusColor,
  selected,
}: {
  d: AdapterNodeData;
  statusColor: string;
  selected?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex w-[120px] items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 shadow-sm',
        selected && 'ring-2 ring-primary',
      )}
      aria-label={`Adapter: ${d.adapterName}, status ${d.adapterStatus}`}
    >
      <Handle type="source" position={Position.Right} isConnectable />
      <span className={cn('size-2 shrink-0 rounded-full', statusColor)} />
      <PlatformIcon adapterType={d.adapterType} />
      <span className="truncate text-xs font-medium text-foreground">{d.label || d.adapterName}</span>
    </div>
  );
}

/** Default/expanded card rendered when zoom >= 0.6. */
function AdapterDefaultCard({
  d,
  statusColor,
  selected,
}: {
  d: AdapterNodeData;
  statusColor: string;
  selected?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border bg-card p-4 shadow-soft hover:shadow-md',
        selected && 'ring-2 ring-primary',
      )}
      style={{ width: ADAPTER_NODE_WIDTH, minHeight: ADAPTER_NODE_HEIGHT }}
      aria-label={`Adapter: ${d.adapterName}, status ${d.adapterStatus}`}
    >
      <Handle type="source" position={Position.Right} isConnectable />

      {/* Header row: status dot + icon + name + type badge */}
      <div className="flex items-center gap-2">
        <span className={cn('size-2.5 shrink-0 rounded-full', statusColor)} />
        <PlatformIcon adapterType={d.adapterType} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-foreground">
            {d.label || d.adapterName}
          </span>
          {d.label && (
            <span className="truncate text-xs text-muted-foreground">
              {d.adapterName}
            </span>
          )}
        </div>
        <Badge variant="outline" className="ml-auto shrink-0 text-[10px] text-muted-foreground">
          Adapter
        </Badge>
      </div>

      {/* Footer row: type label + binding count badge */}
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs capitalize text-muted-foreground">{d.adapterType}</span>
        {d.bindingCount > 0 && (
          <Badge variant="secondary" className="text-xs">
            {d.bindingCount} {d.bindingCount === 1 ? 'binding' : 'bindings'}
          </Badge>
        )}
      </div>
    </div>
  );
}

/** React Flow custom node representing a relay adapter in the topology graph. */
function AdapterNodeInner({ data, selected }: NodeProps) {
  const d = data as unknown as AdapterNodeData;
  const statusColor = resolveStatusColor(d.adapterStatus);
  const band = useLodBand();
  const prefersReducedMotion = usePrefersReducedMotion();

  // Ghost placeholder — dashed border, click-to-add (no LOD transition)
  if (d.isGhost) {
    return (
      <div
        className="flex items-center gap-2 rounded-lg border border-dashed border-muted-foreground/30 bg-card/40 px-3 py-2 opacity-40 transition-opacity hover:opacity-70"
        style={{ width: ADAPTER_NODE_WIDTH, height: ADAPTER_NODE_HEIGHT }}
        onClick={d.onGhostClick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); d.onGhostClick?.(); } }}
        role="button"
        tabIndex={0}
        aria-label="Add adapter"
      >
        <Plus className="size-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Add Adapter</span>
      </div>
    );
  }

  const content = band === 'compact'
    ? <AdapterCompactPill d={d} statusColor={statusColor} selected={selected} />
    : <AdapterDefaultCard d={d} statusColor={statusColor} selected={selected} />;

  const bandKey = band === 'compact' ? 'compact' : 'default';

  return (
    <motion.div
      animate={{ width: ADAPTER_BAND_WIDTHS[bandKey] }}
      transition={{
        width: {
          duration: prefersReducedMotion ? 0 : LOD_RESIZE_DURATION,
          ease: 'easeInOut',
        },
      }}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={bandKey}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: prefersReducedMotion ? 0 : LOD_FADE_DURATION }}
        >
          {content}
        </motion.div>
      </AnimatePresence>
    </motion.div>
  );
}

/** Memoized React Flow custom node for relay adapters. */
export const AdapterNode = memo(AdapterNodeInner);
