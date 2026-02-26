import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

/** Data shape for namespace hub nodes rendered by React Flow. */
export interface NamespaceHubData extends Record<string, unknown> {
  namespace: string;
  agentCount: number;
  color: string;
}

/** Compact hub node representing a namespace cluster in the topology graph. */
function NamespaceHubNodeComponent({ data }: NodeProps) {
  const d = data as unknown as NamespaceHubData;

  return (
    <div
      className="flex items-center gap-1.5 rounded-full border px-3 py-1 shadow-sm"
      style={{ backgroundColor: `${d.color}18`, borderColor: d.color }}
    >
      <Handle type="target" position={Position.Left} className="!bg-muted-foreground" />
      <span className="text-xs font-semibold" style={{ color: d.color }}>
        {d.namespace}
      </span>
      <span
        className="flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium text-white"
        style={{ backgroundColor: d.color }}
      >
        {d.agentCount}
      </span>
      <Handle type="source" position={Position.Right} className="!bg-muted-foreground" />
    </div>
  );
}

export const NamespaceHubNode = memo(NamespaceHubNodeComponent);
