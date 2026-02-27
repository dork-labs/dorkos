import { useMemo, useCallback, useState, useEffect } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  Background,
  BackgroundVariant,
  MiniMap,
  Controls,
  type Node,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
} from '@xyflow/react';
import ELK from 'elkjs/lib/elk.bundled.js';
import { Loader2 } from 'lucide-react';
import { AgentNode, type AgentNodeData } from './AgentNode';
import { NamespaceGroupNode } from './NamespaceGroupNode';
import { CrossNamespaceEdge } from './CrossNamespaceEdge';
import { DenyEdge } from './DenyEdge';
import { TopologyLegend } from './TopologyLegend';
import { getNamespaceColor } from '../lib/namespace-colors';
import { useTopology } from '@/layers/entities/mesh';

const elk = new ELK();

// Layout dimensions match the largest LOD (ExpandedCard: 240×~150px)
// so nodes never overlap regardless of zoom level.
const AGENT_NODE_WIDTH = 240;
const AGENT_NODE_HEIGHT = 150;
const GROUP_PADDING = 48;

const NODE_TYPES: NodeTypes = {
  agent: AgentNode,
  'namespace-group': NamespaceGroupNode,
};

const EDGE_TYPES: EdgeTypes = {
  'cross-namespace': CrossNamespaceEdge,
  'cross-namespace-deny': DenyEdge,
};

/** Applies ELK layered layout with compound nodes for namespace groups. */
async function applyElkLayout(
  nodes: Node[],
  edges: Edge[],
  useGroups: boolean,
): Promise<Node[]> {
  if (nodes.length === 0) return nodes;

  const groupNodes = nodes.filter((n) => n.type === 'namespace-group');
  const agentNodes = nodes.filter((n) => n.type === 'agent');

  const elkChildren = useGroups
    ? groupNodes.map((g) => {
        const children = agentNodes
          .filter((a) => a.parentId === g.id)
          .map((a) => ({
            id: a.id,
            width: AGENT_NODE_WIDTH,
            height: AGENT_NODE_HEIGHT,
          }));
        return {
          id: g.id,
          width: 0,
          height: 0,
          layoutOptions: {
            'elk.padding': `[top=${GROUP_PADDING},left=24,bottom=24,right=24]`,
            'elk.algorithm': 'layered',
            'elk.direction': 'RIGHT',
            'elk.spacing.nodeNode': '60',
          },
          children,
        };
      })
    : agentNodes.map((a) => ({
        id: a.id,
        width: AGENT_NODE_WIDTH,
        height: AGENT_NODE_HEIGHT,
      }));

  const elkEdges = edges.map((edge) => ({
    id: edge.id,
    sources: [edge.source],
    targets: [edge.target],
  }));

  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '80',
      'elk.layered.spacing.nodeNodeBetweenLayers': '120',
    },
    children: elkChildren,
    edges: elkEdges,
  };

  const laid = await elk.layout(graph);

  return nodes.map((node) => {
    if (node.type === 'namespace-group') {
      const laidGroup = laid.children?.find((n) => n.id === node.id);
      if (!laidGroup) return node;
      return {
        ...node,
        position: { x: laidGroup.x ?? 0, y: laidGroup.y ?? 0 },
        style: {
          width: laidGroup.width ?? 300,
          height: laidGroup.height ?? 200,
        },
      };
    }
    // Agent node — find in parent group or root
    if (useGroups && node.parentId) {
      const parentGroup = laid.children?.find((n) => n.id === node.parentId);
      const laidAgent = parentGroup?.children?.find((n) => n.id === node.id);
      if (!laidAgent) return node;
      return { ...node, position: { x: laidAgent.x ?? 0, y: laidAgent.y ?? 0 } };
    }
    const laidNode = laid.children?.find((n) => n.id === node.id);
    if (!laidNode) return node;
    return { ...node, position: { x: laidNode.x ?? 0, y: laidNode.y ?? 0 } };
  });
}

interface TopologyGraphProps {
  /** Called with the agent ID when a node is clicked. */
  onSelectAgent?: (agentId: string) => void;
  /** Called when the Settings action is triggered from the NodeToolbar. */
  onOpenSettings?: (agentId: string) => void;
}

/**
 * Renders the mesh network topology as an interactive React Flow graph.
 * Agents are grouped inside namespace containers using ELK compound layout.
 * Wrapped in ReactFlowProvider for fly-to selection animation via useReactFlow.
 */
export function TopologyGraph(props: TopologyGraphProps) {
  return (
    <ReactFlowProvider>
      <TopologyGraphInner {...props} />
    </ReactFlowProvider>
  );
}

function TopologyGraphInner({ onSelectAgent, onOpenSettings }: TopologyGraphProps) {
  const { setCenter, getZoom } = useReactFlow();
  const { data: topology, isLoading, isError, refetch } = useTopology();

  const namespaces = topology?.namespaces;
  const accessRules = topology?.accessRules;

  const [layoutedNodes, setLayoutedNodes] = useState<Node[]>([]);
  const [isLayouting, setIsLayouting] = useState(true);

  const { rawNodes, rawEdges, legendEntries, useGroups } = useMemo(() => {
    if (!namespaces?.length)
      return {
        rawNodes: [] as Node[],
        rawEdges: [] as Edge[],
        legendEntries: [],
        useGroups: false,
      };

    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const legend: { namespace: string; color: string }[] = [];

    // Skip group wrappers for single-namespace topologies
    const multiNamespace = namespaces.length > 1;

    for (let nsIdx = 0; nsIdx < namespaces.length; nsIdx++) {
      const ns = namespaces[nsIdx];
      const color = getNamespaceColor(nsIdx);
      legend.push({ namespace: ns.namespace, color });
      const groupId = `group:${ns.namespace}`;

      const activeCount = ns.agents.filter((a) => {
        const health = (a as Record<string, unknown>).healthStatus;
        return health === 'active';
      }).length;

      if (multiNamespace) {
        nodes.push({
          id: groupId,
          type: 'namespace-group',
          position: { x: 0, y: 0 },
          data: {
            namespace: ns.namespace,
            agentCount: ns.agentCount,
            activeCount,
            color,
          },
        });
      }

      for (const agent of ns.agents) {
        const enriched = agent as Record<string, unknown>;
        const agentNode: Node = {
          id: agent.id,
          type: 'agent',
          position: { x: 0, y: 0 },
          data: {
            label: agent.name,
            runtime: agent.runtime,
            healthStatus:
              (enriched.healthStatus as AgentNodeData['healthStatus']) ?? 'stale',
            capabilities: agent.capabilities ?? [],
            namespace: ns.namespace,
            namespaceColor: color,
            description: agent.description || undefined,
            relayAdapters: (enriched.relayAdapters as string[]) ?? [],
            relaySubject: (enriched.relaySubject as string | null) ?? null,
            pulseScheduleCount: (enriched.pulseScheduleCount as number) ?? 0,
            lastSeenAt: (enriched.lastSeenAt as string | null) ?? null,
            lastSeenEvent: (enriched.lastSeenEvent as string | null) ?? null,
            budget: agent.budget
              ? {
                  maxHopsPerMessage: agent.budget.maxHopsPerMessage,
                  maxCallsPerHour: agent.budget.maxCallsPerHour,
                }
              : undefined,
            behavior: agent.behavior
              ? { responseMode: agent.behavior.responseMode }
              : undefined,
            color: (enriched.color as string | null) ?? null,
            emoji: (enriched.icon as string | null) ?? null,
            onOpenSettings,
            onViewHealth: onSelectAgent,
          } satisfies AgentNodeData,
        };

        if (multiNamespace) {
          agentNode.parentId = groupId;
          agentNode.extent = 'parent';
        }

        nodes.push(agentNode);
      }
    }

    // Cross-namespace edges connect between group nodes
    for (const rule of accessRules ?? []) {
      const sourceId = multiNamespace
        ? `group:${rule.sourceNamespace}`
        : namespaces[0]?.agents[0]?.id ?? '';
      const targetId = multiNamespace
        ? `group:${rule.targetNamespace}`
        : namespaces[0]?.agents[0]?.id ?? '';
      if (!sourceId || !targetId) continue;

      const isDeny = rule.action === 'deny';
      edges.push({
        id: `e:${rule.sourceNamespace}-${rule.targetNamespace}:${rule.action}`,
        source: sourceId,
        target: targetId,
        type: isDeny ? 'cross-namespace-deny' : 'cross-namespace',
        animated: !isDeny,
        data: { label: `${rule.sourceNamespace} \u203a ${rule.targetNamespace}` },
      });
    }

    return { rawNodes: nodes, rawEdges: edges, legendEntries: legend, useGroups: multiNamespace };
  }, [namespaces, accessRules, onOpenSettings, onSelectAgent]);

  useEffect(() => {
    let cancelled = false;
    setIsLayouting(true);
    applyElkLayout(rawNodes, rawEdges, useGroups).then((positioned) => {
      if (!cancelled) {
        setLayoutedNodes(positioned);
        setIsLayouting(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [rawNodes, rawEdges, useGroups]);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (node.type !== 'agent') return;
      onSelectAgent?.(node.id);

      // Compute absolute center for fly-to (handles grouped child nodes)
      let centerX = node.position.x + AGENT_NODE_WIDTH / 2;
      let centerY = node.position.y + AGENT_NODE_HEIGHT / 2;

      if (node.parentId) {
        const parentNode = layoutedNodes.find((n) => n.id === node.parentId);
        if (parentNode) {
          centerX += parentNode.position.x;
          centerY += parentNode.position.y;
        }
      }

      const targetZoom = Math.max(getZoom(), 1.0);
      setCenter(centerX, centerY, { zoom: targetZoom, duration: 350 });
    },
    [onSelectAgent, setCenter, getZoom, layoutedNodes],
  );

  if (isLoading || isLayouting) {
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

  if (!rawNodes.length) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No agents discovered yet
      </div>
    );
  }

  return (
    <div className="topology-container absolute inset-0">
      <style>{`
        .topology-container .react-flow {
          --xy-background-pattern-dots-color-default: var(--color-border);
          --xy-node-background-color-default: var(--color-card);
          --xy-node-border-default: 1px solid var(--color-border);
          --xy-node-boxshadow-hover-default: 0 0 0 2px var(--color-primary);
          --xy-node-boxshadow-selected-default: 0 0 0 2px var(--color-primary);
          --xy-edge-stroke-default: var(--color-border);
          --xy-edge-stroke-width-default: 1.5;
        }
      `}</style>
      <ReactFlow
        nodes={layoutedNodes}
        edges={rawEdges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodeClick={handleNodeClick}
        fitView
        fitViewOptions={{ duration: 400, padding: 0.15 }}
        colorMode="system"
        onlyRenderVisibleElements
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--color-border)" />
        <MiniMap
          nodeColor={(n) => (n.data?.namespaceColor as string | undefined) ?? '#94a3b8'}
          pannable
          zoomable
          style={{ height: 80 }}
        />
        <Controls showInteractive={false} />
        <TopologyLegend namespaces={legendEntries} />
      </ReactFlow>
    </div>
  );
}
