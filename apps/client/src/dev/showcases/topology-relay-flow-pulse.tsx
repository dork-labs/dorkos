import { useState } from 'react';
import { ReactFlow, ReactFlowProvider, Position, type Node, type Edge } from '@xyflow/react';
import { Button } from '@/layers/shared/ui/button';
import { BindingEdge } from '@/layers/features/mesh/ui/BindingEdge';
import { useRelayFlowStore } from '@/layers/features/mesh/model/relay-flow-store';

/**
 * Dev Playground showcase for the relay-flow pulse (DOR-167).
 *
 * Renders the real `BindingEdge` component inside a minimal, static React
 * Flow canvas and drives it with synthetic `useRelayFlowStore` writes —
 * bypassing the SSE stream entirely. This is the honest visual-QA path: a
 * real end-to-end pulse needs a live external adapter delivering through a
 * binding to a running agent, which is not reliably drivable in a test
 * environment (see the spec's Testing Strategy, "E2E — not driven, stated
 * honestly"). The synthetic trigger exercises the exact same store + render
 * path a real delivery would.
 */

const NODES: Node[] = [
  {
    id: 'adapter-demo',
    position: { x: 0, y: 60 },
    data: { label: 'Telegram' },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    draggable: false,
    selectable: false,
  },
  {
    id: 'agent-demo-a',
    position: { x: 280, y: 0 },
    data: { label: 'code-reviewer' },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    draggable: false,
    selectable: false,
  },
  {
    id: 'agent-demo-b',
    position: { x: 280, y: 120 },
    data: { label: 'deploy-bot' },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    draggable: false,
    selectable: false,
  },
];

const EDGES: Edge[] = [
  {
    id: 'binding:demo-edge-a',
    source: 'adapter-demo',
    target: 'agent-demo-a',
    type: 'binding',
    data: { label: 'Per Chat' },
  },
  {
    id: 'binding:demo-edge-b',
    source: 'adapter-demo',
    target: 'agent-demo-b',
    type: 'binding',
    data: { label: 'Per User' },
  },
];

const EDGE_TYPES = { binding: BindingEdge };

/** Static, non-interactive canvas hosting the two demo binding edges. */
function PulseCanvas() {
  return (
    <div className="h-[220px] w-full overflow-hidden rounded-md border">
      <ReactFlowProvider>
        <ReactFlow
          nodes={NODES}
          edges={EDGES}
          edgeTypes={EDGE_TYPES}
          defaultViewport={{ x: 40, y: 20, zoom: 1 }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
        />
      </ReactFlowProvider>
    </div>
  );
}

/**
 * Fires synthetic `relay_flow` pulses directly on {@link useRelayFlowStore},
 * the same store `useRelayFlowSubscription` writes to from the real SSE
 * stream. Demonstrates per-edge coalescing (rapid clicks on one edge
 * collapse to a single pulse) and cross-edge concurrency (both edges pulse
 * independently).
 */
export function RelayFlowPulseDemo() {
  const [burstCount, setBurstCount] = useState(0);

  function pulseEdgeA() {
    useRelayFlowStore.getState().pulse('binding:demo-edge-a', 'inbound');
  }

  function pulseEdgeB() {
    useRelayFlowStore.getState().pulse('binding:demo-edge-b', 'inbound');
  }

  function pulseBoth() {
    pulseEdgeA();
    pulseEdgeB();
  }

  /** Fire 5 pulses on edge A back-to-back — coalescing should collapse them to one. */
  function burstEdgeA() {
    for (let i = 0; i < 5; i++) pulseEdgeA();
    setBurstCount((c) => c + 1);
  }

  return (
    <div className="flex flex-col gap-3">
      <PulseCanvas />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={pulseEdgeA}>
          Pulse edge A
        </Button>
        <Button size="sm" variant="outline" onClick={pulseEdgeB}>
          Pulse edge B
        </Button>
        <Button size="sm" variant="outline" onClick={pulseBoth}>
          Pulse both (cross-edge concurrency)
        </Button>
        <Button size="sm" variant="outline" onClick={burstEdgeA}>
          Burst edge A ×5 (coalescing)
        </Button>
        {burstCount > 0 && (
          <span className="text-muted-foreground text-xs">
            Burst fired {burstCount}× — watch edge A pulse only once per burst.
          </span>
        )}
      </div>
    </div>
  );
}
