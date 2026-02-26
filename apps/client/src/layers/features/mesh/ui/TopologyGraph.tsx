import { useMemo, useCallback } from 'react';
import {
  ReactFlow,
  Controls,
  type Node,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
} from '@xyflow/react';
import dagre from 'dagre';
import { Loader2 } from 'lucide-react';
import { AgentNode, type AgentNodeData } from './AgentNode';
import { NamespaceHubNode } from './NamespaceHubNode';
import { NamespaceEdge } from './NamespaceEdge';
import { CrossNamespaceEdge } from './CrossNamespaceEdge';
import { TopologyLegend } from './TopologyLegend';
import { getNamespaceColor } from '../lib/namespace-colors';
import { useTopology } from '@/layers/entities/mesh';

const AGENT_NODE_WIDTH = 180;
const AGENT_NODE_HEIGHT = 60;
const HUB_NODE_WIDTH = 120;
const HUB_NODE_HEIGHT = 36;

const NODE_TYPES: NodeTypes = {
  agent: AgentNode,
  'namespace-hub': NamespaceHubNode,
};

const EDGE_TYPES: EdgeTypes = {
  'namespace-internal': NamespaceEdge,
  'cross-namespace': CrossNamespaceEdge,
};

/** Applies a left-to-right dagre layout, sizing hub and agent nodes differently. */
function applyDagreLayout(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 50, ranksep: 100 });

  for (const node of nodes) {
    const isHub = node.type === 'namespace-hub';
    const w = isHub ? HUB_NODE_WIDTH : AGENT_NODE_WIDTH;
    const h = isHub ? HUB_NODE_HEIGHT : AGENT_NODE_HEIGHT;
    g.setNode(node.id, { width: w, height: h });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    const isHub = node.type === 'namespace-hub';
    const w = isHub ? HUB_NODE_WIDTH : AGENT_NODE_WIDTH;
    const h = isHub ? HUB_NODE_HEIGHT : AGENT_NODE_HEIGHT;
    return { ...node, position: { x: pos.x - w / 2, y: pos.y - h / 2 } };
  });
}

interface TopologyGraphProps {
  /** Called with the agent ID when a node is clicked. */
  onSelectAgent?: (agentId: string) => void;
}

/**
 * Renders the mesh network topology as an interactive React Flow graph.
 * Agents are grouped by namespace via hub nodes, with spoke and cross-namespace edges.
 */
export function TopologyGraph({ onSelectAgent }: TopologyGraphProps) {
  const { data: topology, isLoading, isError, refetch } = useTopology();

  const namespaces = topology?.namespaces;
  const accessRules = topology?.accessRules;

  const { nodes, edges, legendEntries } = useMemo(() => {
    if (!namespaces?.length)
      return { nodes: [] as Node[], edges: [] as Edge[], legendEntries: [] };

    const rawNodes: Node[] = [];
    const rawEdges: Edge[] = [];
    const legend: { namespace: string; color: string }[] = [];

    // Determine if we can skip the hub (single namespace with 1 agent)
    const isTrivial = namespaces.length === 1 && namespaces[0].agentCount <= 1;

    for (let nsIdx = 0; nsIdx < namespaces.length; nsIdx++) {
      const ns = namespaces[nsIdx];
      const color = getNamespaceColor(nsIdx);
      legend.push({ namespace: ns.namespace, color });
      const hubId = `hub:${ns.namespace}`;

      if (!isTrivial) {
        rawNodes.push({
          id: hubId,
          type: 'namespace-hub',
          position: { x: 0, y: 0 },
          data: { namespace: ns.namespace, agentCount: ns.agentCount, color },
        });
      }

      for (const agent of ns.agents) {
        rawNodes.push({
          id: agent.id,
          type: 'agent',
          position: { x: 0, y: 0 },
          data: {
            label: agent.name,
            runtime: agent.runtime,
            healthStatus:
              ((agent as Record<string, unknown>).healthStatus as AgentNodeData['healthStatus']) ??
              'stale',
            capabilities: agent.capabilities ?? [],
            namespace: ns.namespace,
            namespaceColor: color,
          } satisfies AgentNodeData,
        });

        // Spoke edge: agent -> hub
        if (!isTrivial) {
          rawEdges.push({
            id: `e:${agent.id}-${hubId}`,
            source: agent.id,
            target: hubId,
            type: 'namespace-internal',
          });
        }
      }
    }

    // Cross-namespace edges (hub-to-hub) for allow rules only
    for (const rule of accessRules ?? []) {
      if (rule.action !== 'allow') continue;
      const sourceHub = `hub:${rule.sourceNamespace}`;
      const targetHub = `hub:${rule.targetNamespace}`;
      rawEdges.push({
        id: `e:${sourceHub}-${targetHub}`,
        source: sourceHub,
        target: targetHub,
        type: 'cross-namespace',
        animated: true,
        data: { label: `${rule.sourceNamespace} \u203a ${rule.targetNamespace}` },
      });
    }

    return {
      nodes: rawNodes.length > 1 ? applyDagreLayout(rawNodes, rawEdges) : rawNodes,
      edges: rawEdges,
      legendEntries: legend,
    };
  }, [namespaces, accessRules]);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      // Only select agent nodes, not hub nodes
      if (node.type === 'agent') {
        onSelectAgent?.(node.id);
      }
    },
    [onSelectAgent],
  );

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        <span>Failed to load topology</span>
        <button
          onClick={() => refetch()}
          className="rounded-md border px-3 py-1 text-xs hover:bg-muted"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!nodes.length) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No agents discovered yet
      </div>
    );
  }

  return (
    <div className="absolute inset-0">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodeClick={handleNodeClick}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Controls showInteractive={false} />
        <TopologyLegend namespaces={legendEntries} />
      </ReactFlow>
    </div>
  );
}
