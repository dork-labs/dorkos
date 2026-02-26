import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  MarkerType,
  type EdgeProps,
} from '@xyflow/react';

/** Data carried by cross-namespace edges. */
interface CrossNamespaceEdgeData extends Record<string, unknown> {
  label: string;
}

/** Hub-to-hub dashed edge representing a cross-namespace allow rule. */
export function CrossNamespaceEdge(props: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  });

  const label = (props.data as CrossNamespaceEdgeData | undefined)?.label;

  return (
    <>
      <BaseEdge
        id={props.id}
        path={edgePath}
        markerEnd={MarkerType.ArrowClosed}
        style={{ stroke: '#3b82f6', strokeWidth: 1.5, strokeDasharray: '6 3' }}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan rounded border border-blue-300 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:border-blue-700 dark:bg-blue-950 dark:text-blue-300"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: 'all',
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
