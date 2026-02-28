import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { MessageSquare, Webhook, Bot } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { Badge } from '@/layers/shared/ui/badge';
import { useLodBand } from '../lib/use-lod-band';

/**
 * Data shape for adapter nodes in the React Flow topology graph.
 * The index signature satisfies @xyflow/react's `Record<string, unknown>` constraint.
 */
export interface AdapterNodeData extends Record<string, unknown> {
  adapterName: string;
  adapterType: string;
  adapterStatus: 'running' | 'stopped' | 'error';
  bindingCount: number;
}

/** Dimensions used by the ELK layout engine for adapter nodes. */
export const ADAPTER_NODE_WIDTH = 200;
export const ADAPTER_NODE_HEIGHT = 100;

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

/** CSS transition for smooth LOD crossfade. */
const LOD_TRANSITION = 'transition-[opacity,transform] duration-200 ease-out';

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
        LOD_TRANSITION,
        selected && 'ring-2 ring-primary',
      )}
      aria-label={`Adapter: ${d.adapterName}, status ${d.adapterStatus}`}
    >
      <Handle type="source" position={Position.Right} isConnectable />
      <span className={cn('size-2 shrink-0 rounded-full', statusColor)} />
      <PlatformIcon adapterType={d.adapterType} />
      <span className="truncate text-xs font-medium">{d.adapterName}</span>
    </div>
  );
}

/** React Flow custom node representing a relay adapter in the topology graph. */
function AdapterNodeInner({ data, selected }: NodeProps) {
  const d = data as unknown as AdapterNodeData;
  const statusColor = resolveStatusColor(d.adapterStatus);
  const band = useLodBand();

  if (band === 'compact') {
    return <AdapterCompactPill d={d} statusColor={statusColor} selected={selected} />;
  }

  return (
    <div
      className={cn(
        'rounded-xl border bg-card p-4 shadow-soft hover:shadow-md',
        LOD_TRANSITION,
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
        <span className="truncate text-sm font-medium">{d.adapterName}</span>
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

/** Memoized React Flow custom node for relay adapters. */
export const AdapterNode = memo(AdapterNodeInner);
