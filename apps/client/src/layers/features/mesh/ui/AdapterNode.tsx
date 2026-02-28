import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { MessageSquare, Webhook, Bot } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { Badge } from '@/layers/shared/ui/badge';

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

/** Resolve the platform icon for a given adapter type, falling back to Bot. */
function resolveIcon(adapterType: string): React.ElementType {
  return PLATFORM_ICONS[adapterType] ?? Bot;
}

/** Resolve the status indicator color, falling back to zinc. */
function resolveStatusColor(status: string): string {
  return STATUS_COLORS[status] ?? 'bg-zinc-400';
}

/** React Flow custom node representing a relay adapter in the topology graph. */
function AdapterNodeInner({ data, selected }: NodeProps) {
  const d = data as unknown as AdapterNodeData;
  const Icon = resolveIcon(d.adapterType);
  const statusColor = resolveStatusColor(d.adapterStatus);

  return (
    <div
      className={cn(
        'rounded-xl border bg-card p-4 shadow-soft transition-shadow duration-150',
        selected && 'ring-2 ring-primary',
      )}
      style={{ width: ADAPTER_NODE_WIDTH, minHeight: ADAPTER_NODE_HEIGHT }}
    >
      <Handle type="source" position={Position.Right} isConnectable />

      {/* Header row: status dot + icon + name */}
      <div className="flex items-center gap-2">
        <span className={cn('size-2.5 shrink-0 rounded-full', statusColor)} />
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium">{d.adapterName}</span>
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
