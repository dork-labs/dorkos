'use client'

import {
  ReactFlow,
  type Node,
  type Edge,
  Position,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

/** Module colors matching the brand palette. */
const MODULE_COLORS: Record<string, string> = {
  pulse: '#CF722B',
  relay: '#8B7BA4',
  mesh: '#4A90A4',
  console: '#E85D04',
  loop: '#B8860B',
  wing: '#228B22',
}

/** Hexagonal layout — 6 nodes arranged in a ring. */
const NODES: Node[] = [
  { id: 'console', position: { x: 250, y: 20 }, data: { label: 'Console' }, sourcePosition: Position.Bottom, targetPosition: Position.Top },
  { id: 'pulse', position: { x: 80, y: 80 }, data: { label: 'Pulse' }, sourcePosition: Position.Right, targetPosition: Position.Left },
  { id: 'relay', position: { x: 420, y: 80 }, data: { label: 'Relay' }, sourcePosition: Position.Left, targetPosition: Position.Right },
  { id: 'mesh', position: { x: 80, y: 200 }, data: { label: 'Mesh' }, sourcePosition: Position.Right, targetPosition: Position.Left },
  { id: 'loop', position: { x: 420, y: 200 }, data: { label: 'Loop' }, sourcePosition: Position.Left, targetPosition: Position.Right },
  { id: 'wing', position: { x: 250, y: 240 }, data: { label: 'Wing' }, sourcePosition: Position.Top, targetPosition: Position.Bottom },
].map((node) => ({
  ...node,
  type: 'default',
  style: {
    background: `${MODULE_COLORS[node.id]}12`,
    border: `1.5px solid ${MODULE_COLORS[node.id]}40`,
    borderRadius: 6,
    padding: '6px 14px',
    fontSize: 11,
    fontFamily: 'var(--font-ibm-plex-mono), monospace',
    fontWeight: 500,
    color: MODULE_COLORS[node.id],
    width: 'auto',
    minWidth: 80,
    textAlign: 'center' as const,
  },
}))

/** Edges showing data flow between modules. */
const EDGES: Edge[] = [
  { id: 'pulse-console', source: 'pulse', target: 'console', animated: true },
  { id: 'relay-console', source: 'relay', target: 'console', animated: true },
  { id: 'pulse-mesh', source: 'pulse', target: 'mesh' },
  { id: 'mesh-relay', source: 'mesh', target: 'relay' },
  { id: 'loop-pulse', source: 'loop', target: 'pulse', animated: true },
  { id: 'wing-mesh', source: 'wing', target: 'mesh' },
  { id: 'wing-loop', source: 'wing', target: 'loop' },
  { id: 'console-pulse', source: 'console', target: 'pulse' },
].map((edge) => ({
  ...edge,
  style: {
    stroke: 'rgba(139, 90, 43, 0.2)',
    strokeWidth: 1.2,
    strokeDasharray: edge.animated ? '5 3' : undefined,
  },
  type: 'default' as const,
}))

/** Non-interactive React Flow topology showing how DorkOS modules relate. */
export function SubsystemTopology() {
  return (
    <ReactFlow
      nodes={NODES}
      edges={EDGES}
      nodesDraggable={false}
      nodesConnectable={false}
      panOnDrag={false}
      zoomOnScroll={false}
      zoomOnPinch={false}
      zoomOnDoubleClick={false}
      preventScrolling={false}
      fitView
      fitViewOptions={{ padding: 0.3 }}
      proOptions={{ hideAttribution: true }}
      style={{ background: 'transparent' }}
    />
  )
}
