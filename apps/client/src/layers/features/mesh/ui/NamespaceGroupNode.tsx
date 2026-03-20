import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { usePrefersReducedMotion } from '../lib/use-reduced-motion';

/** Data shape for namespace group container nodes rendered by React Flow. */
export interface NamespaceGroupData extends Record<string, unknown> {
  namespace: string;
  agentCount: number;
  activeCount: number;
  color: string;
}

/** Group container node that visually contains agent nodes within a namespace. */
function NamespaceGroupNodeComponent({ data }: NodeProps) {
  const d = data as unknown as NamespaceGroupData;
  const prefersReducedMotion = usePrefersReducedMotion();

  return (
    <div
      className="bg-card/50 rounded-xl border-2"
      style={{
        borderColor: `${d.color}40`,
        backgroundColor: `${d.color}08`,
        width: '100%',
        height: '100%',
      }}
    >
      <div
        className="flex items-center gap-2 rounded-t-[10px] px-3 py-1.5"
        style={{ backgroundColor: `${d.color}15` }}
      >
        <span className="text-xs font-semibold" style={{ color: d.color }}>
          {d.namespace}
        </span>
        <span className="text-muted-foreground text-[10px]">
          {d.activeCount}/{d.agentCount} agents
        </span>
        {d.activeCount > 0 && (
          <span
            className={`h-1.5 w-1.5 rounded-full ${prefersReducedMotion ? '' : 'animate-pulse'}`}
            style={{ backgroundColor: d.color }}
          />
        )}
      </div>
    </div>
  );
}

export const NamespaceGroupNode = memo(NamespaceGroupNodeComponent);
