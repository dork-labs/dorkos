import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
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
}

const STATUS_COLORS: Record<AgentNodeData['healthStatus'], string> = {
  active: 'bg-green-500',
  inactive: 'bg-amber-500',
  stale: 'bg-zinc-400',
};

/** React Flow custom node that renders a mesh agent with health indicator and capability badges. */
function AgentNodeComponent({ data }: NodeProps) {
  const d = data as unknown as AgentNodeData;
  const dotColor = STATUS_COLORS[d.healthStatus] ?? STATUS_COLORS.stale;

  return (
    <div className="min-w-[140px] rounded-lg border bg-card px-3 py-2 shadow-sm">
      <Handle type="target" position={Position.Left} className="!bg-muted-foreground" />
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dotColor}`} />
        <span className="truncate text-sm font-medium">{d.label}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        <Badge variant="secondary" className="text-[10px]">
          {d.runtime}
        </Badge>
        {d.capabilities.slice(0, 2).map((cap) => (
          <Badge key={cap} variant="outline" className="text-[10px]">
            {cap}
          </Badge>
        ))}
      </div>
      <Handle type="source" position={Position.Right} className="!bg-muted-foreground" />
    </div>
  );
}

export const AgentNode = memo(AgentNodeComponent);
