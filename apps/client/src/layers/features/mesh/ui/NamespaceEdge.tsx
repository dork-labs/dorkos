import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';

/** Intra-namespace spoke edge connecting an agent node to its namespace hub. */
export function NamespaceEdge(props: EdgeProps) {
  const [edgePath] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  });

  return (
    <BaseEdge
      id={props.id}
      path={edgePath}
      style={{ stroke: 'var(--color-border)', strokeWidth: 1 }}
    />
  );
}
