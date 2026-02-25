import { useMemo, useCallback } from 'react';
import { ReactFlow, Controls, type Node, type Edge, type NodeTypes } from '@xyflow/react';
import dagre from 'dagre';
import { AgentNode, type AgentNodeData } from './AgentNode';
import { useRegisteredAgents } from '@/layers/entities/mesh';

/** Node width used for dagre layout calculations. */
const NODE_WIDTH = 180;

/** Node height used for dagre layout calculations. */
const NODE_HEIGHT = 60;

/**
 * React Flow requires nodeTypes to be defined outside the component to avoid
 * unnecessary re-renders caused by referential inequality on each render.
 */
const NODE_TYPES: NodeTypes = { agent: AgentNode };

/** Applies a left-to-right dagre layout to the provided nodes and edges, returning positioned nodes. */
function applyDagreLayout(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 50, ranksep: 80 });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    return { ...node, position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 } };
  });
}

interface TopologyGraphProps {
  /** Called with the agent ID when a node is clicked. */
  onSelectAgent?: (agentId: string) => void;
}

/**
 * Renders registered mesh agents as an interactive React Flow topology graph
 * with a left-to-right dagre layout. Edges will be added in the Network Topology spec.
 */
export function TopologyGraph({ onSelectAgent }: TopologyGraphProps) {
  const { data: agentsResult } = useRegisteredAgents();
  const agents = agentsResult?.agents ?? [];

  const { nodes, edges } = useMemo(() => {
    if (!agents.length) return { nodes: [] as Node[], edges: [] as Edge[] };

    const rawNodes: Node[] = agents.map((agent) => ({
      id: agent.id,
      type: 'agent',
      // Positions are overwritten by dagre layout; initial values are placeholders.
      position: { x: 0, y: 0 },
      data: {
        label: agent.name,
        runtime: agent.runtime,
        // Health status will be wired to live data in the observability spec.
        healthStatus: 'stale',
        capabilities: agent.capabilities ?? [],
      },
    }));

    // No edges until Spec 3 (Network Topology) introduces connection data.
    const rawEdges: Edge[] = [] as Edge[];

    return { nodes: applyDagreLayout(rawNodes, rawEdges), edges: rawEdges };
  }, [agents]);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      onSelectAgent?.(node.id);
    },
    [onSelectAgent],
  );

  if (!agents.length) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No agents discovered yet
      </div>
    );
  }

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodeClick={handleNodeClick}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
