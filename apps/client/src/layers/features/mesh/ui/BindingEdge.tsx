import { memo, useState } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
  useStore,
  type ReactFlowState,
} from '@xyflow/react';
import { X } from 'lucide-react';
import { cn } from '@/layers/shared/lib';

const zoomSelector = (s: ReactFlowState) => s.transform[2];

/**
 * Data carried by binding edges in the topology graph.
 * The index signature satisfies @xyflow/react's `Record<string, unknown>` constraint.
 */
export interface BindingEdgeData extends Record<string, unknown> {
  /** Human-readable label shown on the edge. Falls back to sessionStrategy. */
  label?: string;
  /** Session strategy for the binding (per-chat, per-user, stateless). */
  sessionStrategy?: string;
  /** Called with the edge ID when the delete button is clicked. */
  onDelete?: (edgeId: string) => void;
}

/** Resolve the display label: prefer explicit label, then sessionStrategy, then 'Binding'. */
function resolveDisplayLabel(data: BindingEdgeData | undefined): string {
  if (data?.label) return data.label;
  if (data?.sessionStrategy) return data.sessionStrategy;
  return 'Binding';
}

/** React Flow custom edge for adapter-agent bindings with hover-to-reveal label. */
function BindingEdgeInner({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps) {
  const d = data as BindingEdgeData | undefined;
  const zoom = useStore(zoomSelector);
  const [hovered, setHovered] = useState(false);

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const displayLabel = resolveDisplayLabel(d);
  const showLabel = (hovered || selected) && zoom >= 0.7;

  function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    d?.onDelete?.(id);
  }

  return (
    <>
      {/* Invisible wider hit area for hover detection */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={12}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      <BaseEdge
        id={id}
        path={edgePath}
        className={cn(
          'transition-colors duration-150',
          selected ? 'stroke-primary stroke-2' : 'stroke-primary/60 stroke-2',
        )}
      />
      {showLabel && (
        <EdgeLabelRenderer>
          <div
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: 'all',
              transition: 'opacity 150ms ease-out',
            }}
            className="nodrag nopan flex max-w-[100px] items-center gap-1 rounded-md bg-background/90 px-1.5 py-0.5 shadow-sm"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
          >
            <span className="truncate text-[10px] text-muted-foreground">{displayLabel}</span>
            {selected && d?.onDelete && (
              <button
                onClick={handleDelete}
                className="ml-0.5 shrink-0 rounded-sm p-0.5 text-destructive/60 hover:bg-destructive/10 hover:text-destructive"
                aria-label="Delete binding"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/** Memoized React Flow custom edge for adapter-agent bindings. */
export const BindingEdge = memo(BindingEdgeInner);
