import { useMemo, useCallback, useState, useEffect, useRef } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  Background,
  BackgroundVariant,
  MiniMap,
  Controls,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type IsValidConnection,
} from '@xyflow/react';
import ELK from 'elkjs/lib/elk.bundled.js';
import { Loader2, Globe, RotateCcw } from 'lucide-react';
import { AgentNode, type AgentNodeData } from './AgentNode';
import { AdapterNode, type AdapterNodeData, ADAPTER_NODE_WIDTH, ADAPTER_NODE_HEIGHT } from './AdapterNode';
import { BindingEdge, type BindingEdgeData } from './BindingEdge';
import { BindingDialog } from './BindingDialog';
import { NamespaceGroupNode } from './NamespaceGroupNode';
import { CrossNamespaceEdge } from './CrossNamespaceEdge';
import { DenyEdge } from './DenyEdge';
import { TopologyLegend } from './TopologyLegend';
import { getNamespaceColor } from '../lib/namespace-colors';
import { useTopology } from '@/layers/entities/mesh';
import { useBindings, useCreateBinding, useDeleteBinding } from '@/layers/entities/binding';
import { useRelayAdapters, useRelayEnabled } from '@/layers/entities/relay';
import type { SessionStrategy } from '@dorkos/shared/relay-schemas';
import type { TopologyAgent } from '@dorkos/shared/mesh-schemas';
import './topology-graph.css';

const elk = new ELK();

// Layout dimensions match the largest LOD (ExpandedCard: 240x~150px)
// so nodes never overlap regardless of zoom level.
const AGENT_NODE_WIDTH = 240;
const AGENT_NODE_HEIGHT = 150;
const GROUP_PADDING = 48;

const NODE_TYPES: NodeTypes = {
  agent: AgentNode,
  adapter: AdapterNode,
  'namespace-group': NamespaceGroupNode,
};

const EDGE_TYPES: EdgeTypes = {
  binding: BindingEdge,
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
  const adapterNodes = nodes.filter((n) => n.type === 'adapter');

  // Build ELK children: adapter nodes are standalone (not inside groups)
  const adapterElkChildren = adapterNodes.map((a) => ({
    id: a.id,
    width: ADAPTER_NODE_WIDTH,
    height: ADAPTER_NODE_HEIGHT,
    // Place adapters in the first layer (leftmost)
    layoutOptions: {
      'elk.layered.layering.layerConstraint': 'FIRST',
    },
  }));

  const agentElkChildren = useGroups
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
        // Place agents in the last layer (rightmost) when adapters are present
        ...(adapterNodes.length > 0
          ? { layoutOptions: { 'elk.layered.layering.layerConstraint': 'LAST' } }
          : {}),
      }));

  const elkChildren = [...adapterElkChildren, ...agentElkChildren];

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
    // Adapter node — find in root children
    if (node.type === 'adapter') {
      const laidNode = laid.children?.find((n) => n.id === node.id);
      if (!laidNode) return node;
      return { ...node, position: { x: laidNode.x ?? 0, y: laidNode.y ?? 0 } };
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
  /** Called to switch to the Discovery tab from the empty state. */
  onGoToDiscovery?: () => void;
  /** Called when the Chat action is triggered from the NodeToolbar. */
  onOpenChat?: (agentDir: string) => void;
}

/**
 * Renders the mesh network topology as an interactive React Flow graph.
 * Agents are grouped inside namespace containers using ELK compound layout.
 * When Relay is enabled, adapter nodes appear on the left with binding edges
 * connecting them to agent nodes on the right.
 * Wrapped in ReactFlowProvider for fly-to selection animation via useReactFlow.
 */
export function TopologyGraph(props: TopologyGraphProps) {
  return (
    <ReactFlowProvider>
      <TopologyGraphInner {...props} />
    </ReactFlowProvider>
  );
}

/** Empty state shown when no agents have been discovered yet. */
function TopologyEmptyState({ onGoToDiscovery }: { onGoToDiscovery?: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <Globe className="size-10 text-muted-foreground/50" />
      <div>
        <h3 className="text-sm font-medium">No agents discovered yet</h3>
        <p className="mt-1 max-w-[240px] text-xs text-muted-foreground">
          Discover agents from your workspace to see them on the topology graph.
        </p>
      </div>
      {onGoToDiscovery && (
        <button
          type="button"
          onClick={onGoToDiscovery}
          className="mt-1 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
        >
          Go to Discovery
        </button>
      )}
    </div>
  );
}

/** Pending connection state for the BindingDialog. */
interface PendingConnection {
  sourceAdapterId: string;
  sourceAdapterName: string;
  targetAgentId: string;
  targetAgentName: string;
  targetAgentDir: string;
}

function TopologyGraphInner({ onSelectAgent, onOpenSettings, onGoToDiscovery, onOpenChat }: TopologyGraphProps) {
  const { setCenter, getZoom } = useReactFlow();
  const { data: topology, isLoading, isError, refetch } = useTopology();

  const namespaces = topology?.namespaces;
  const accessRules = topology?.accessRules;

  // Adapter & binding data (only fetched when Relay is enabled)
  const relayEnabled = useRelayEnabled();
  const { data: adapters } = useRelayAdapters(relayEnabled);
  const { data: bindings } = useBindings();
  const { mutate: createBindingMutate } = useCreateBinding();
  const { mutate: deleteBindingMutate } = useDeleteBinding();

  const [layoutedNodes, setLayoutedNodes] = useState<Node[]>([]);
  const [layoutedEdges, setLayoutedEdges] = useState<Edge[]>([]);
  const [isLayouting, setIsLayouting] = useState(true);
  const [pendingConnection, setPendingConnection] = useState<PendingConnection | null>(null);
  // Track drag-to-connect state for visual feedback
  const [connectingFrom, setConnectingFrom] = useState<string | null>(null);
  // Track whether user has manually dragged any nodes (for Reset Layout button)
  const [hasDraggedNodes, setHasDraggedNodes] = useState(false);

  // Stable refs for callback props to prevent useMemo re-creation on each render.
  // Without refs, new callback references cause the node/edge useMemo to recompute,
  // which triggers the ELK layout useEffect, creating an infinite re-render loop.
  const onOpenSettingsRef = useRef(onOpenSettings);
  onOpenSettingsRef.current = onOpenSettings;
  const onSelectAgentRef = useRef(onSelectAgent);
  onSelectAgentRef.current = onSelectAgent;
  const onOpenChatRef = useRef(onOpenChat);
  onOpenChatRef.current = onOpenChat;

  // Track manual position overrides from user drag (session-only, not persisted)
  const manualPositions = useRef<Map<string, { x: number; y: number }>>(new Map());
  // Counter to force re-layout when reset is clicked
  const [layoutVersion, setLayoutVersion] = useState(0);

  /** Count bindings for a given adapter ID. */
  const bindingCountByAdapter = useMemo(() => {
    const counts = new Map<string, number>();
    for (const b of bindings ?? []) {
      counts.set(b.adapterId, (counts.get(b.adapterId) ?? 0) + 1);
    }
    return counts;
  }, [bindings]);

  /** Extract binding UUID from a binding edge ID. */
  const extractBindingId = useCallback((edgeId: string) => edgeId.replace(/^binding:/, ''), []);

  /** Delete a binding by its edge ID. Used by both edge change handler and BindingEdge UI. */
  const handleDeleteBinding = useCallback(
    (edgeId: string) => {
      deleteBindingMutate(extractBindingId(edgeId));
    },
    [deleteBindingMutate, extractBindingId],
  );

  /**
   * Handle node changes (drag, selection) in controlled mode.
   * React Flow requires this for ANY node interactivity when using controlled `nodes` prop.
   */
  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setLayoutedNodes((prev) => applyNodeChanges(changes, prev));
    },
    [],
  );

  /** Capture manual position when user finishes dragging a node. */
  const handleNodeDragStop = useCallback(
    (_: React.MouseEvent, node: Node) => {
      manualPositions.current.set(node.id, node.position);
      setHasDraggedNodes(true);
    },
    [],
  );

  /**
   * Handle edge changes (selection, removal via keyboard) in controlled mode.
   * Intercepts `remove` changes for binding edges to delete via API instead of local state.
   */
  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      // Intercept binding edge removals — delete via API, don't apply locally
      const nonBindingChanges: EdgeChange[] = [];
      for (const change of changes) {
        if (change.type === 'remove') {
          const edgeId = change.id;
          if (edgeId.startsWith('binding:')) {
            deleteBindingMutate(extractBindingId(edgeId));
            continue; // Skip — API deletion triggers data refetch
          }
        }
        nonBindingChanges.push(change);
      }
      // Apply non-binding changes (selection, etc.) to local state
      if (nonBindingChanges.length > 0) {
        setLayoutedEdges((prev) => applyEdgeChanges(nonBindingChanges, prev));
      }
    },
    [deleteBindingMutate, extractBindingId],
  );

  /** Clear all manual position overrides and re-run ELK layout. */
  const handleResetLayout = useCallback(() => {
    manualPositions.current.clear();
    setHasDraggedNodes(false);
    setLayoutVersion((v) => v + 1);
  }, []);

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

    // --- Adapter nodes (left side) ---
    if (relayEnabled && adapters?.length) {
      for (const adapter of adapters) {
        nodes.push({
          id: `adapter:${adapter.config.id}`,
          type: 'adapter',
          position: { x: 0, y: 0 },
          data: {
            adapterName: adapter.status.displayName,
            adapterType: adapter.config.type,
            adapterStatus: adapter.status.state === 'connected'
              ? 'running'
              : adapter.status.state === 'error'
                ? 'error'
                : 'stopped',
            bindingCount: bindingCountByAdapter.get(adapter.config.id) ?? 0,
          } satisfies AdapterNodeData,
        });
      }
    }

    // Skip group wrappers for single-namespace topologies
    const multiNamespace = namespaces.length > 1;

    for (let nsIdx = 0; nsIdx < namespaces.length; nsIdx++) {
      const ns = namespaces[nsIdx];
      const color = getNamespaceColor(nsIdx);
      legend.push({ namespace: ns.namespace, color });
      const groupId = `group:${ns.namespace}`;

      const activeCount = ns.agents.filter((a) => {
        const typedAgent = a as TopologyAgent;
        return typedAgent.healthStatus === 'active';
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
        const typedAgent = agent as TopologyAgent & { dir?: string; agentDir?: string };
        const agentNode: Node = {
          id: agent.id,
          type: 'agent',
          position: { x: 0, y: 0 },
          data: {
            label: agent.name,
            runtime: agent.runtime,
            healthStatus: typedAgent.healthStatus ?? 'stale',
            capabilities: agent.capabilities ?? [],
            namespace: ns.namespace,
            namespaceColor: color,
            description: agent.description || undefined,
            relayAdapters: typedAgent.relayAdapters ?? [],
            relaySubject: typedAgent.relaySubject ?? null,
            pulseScheduleCount: typedAgent.pulseScheduleCount ?? 0,
            lastSeenAt: typedAgent.lastSeenAt ?? null,
            lastSeenEvent: typedAgent.lastSeenEvent ?? null,
            budget: agent.budget
              ? {
                  maxHopsPerMessage: agent.budget.maxHopsPerMessage,
                  maxCallsPerHour: agent.budget.maxCallsPerHour,
                }
              : undefined,
            behavior: agent.behavior
              ? { responseMode: agent.behavior.responseMode }
              : undefined,
            color: typedAgent.color ?? null,
            emoji: typedAgent.icon ?? null,
            // Store agentDir for binding creation
            agentDir: typedAgent.dir ?? typedAgent.agentDir ?? '',
            onOpenSettings: (id: string) => onOpenSettingsRef.current?.(id),
            onViewHealth: (id: string) => onSelectAgentRef.current?.(id),
            onOpenChat: (_id: string, dir: string) => onOpenChatRef.current?.(dir),
          } satisfies AgentNodeData,
        };

        if (multiNamespace) {
          agentNode.parentId = groupId;
          agentNode.extent = 'parent';
        }

        nodes.push(agentNode);
      }
    }

    // --- Binding edges (adapter -> agent) ---
    if (relayEnabled && bindings?.length) {
      for (const binding of bindings) {
        const sourceId = `adapter:${binding.adapterId}`;
        const targetId = binding.agentId;
        // Only create edge if both source and target nodes exist
        const hasSource = nodes.some((n) => n.id === sourceId);
        const hasTarget = nodes.some((n) => n.id === targetId);
        if (!hasSource || !hasTarget) continue;

        edges.push({
          id: `binding:${binding.id}`,
          source: sourceId,
          target: targetId,
          type: 'binding',
          deletable: true,
          data: {
            label: binding.label || undefined,
            sessionStrategy: binding.sessionStrategy,
            onDelete: handleDeleteBinding,
          } satisfies BindingEdgeData,
        });
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
        deletable: false,
        data: { label: `${rule.sourceNamespace} \u203a ${rule.targetNamespace}` },
      });
    }

    return { rawNodes: nodes, rawEdges: edges, legendEntries: legend, useGroups: multiNamespace };
  }, [namespaces, accessRules, relayEnabled, adapters, bindings, bindingCountByAdapter, handleDeleteBinding]);

  useEffect(() => {
    let cancelled = false;
    setIsLayouting(true);
    applyElkLayout(rawNodes, rawEdges, useGroups)
      .then((positioned) => {
        if (!cancelled) {
          // Merge manual position overrides from user drags
          const merged = positioned.map((node) => {
            const manual = manualPositions.current.get(node.id);
            return manual ? { ...node, position: manual } : node;
          });
          setLayoutedNodes(merged);
          setLayoutedEdges(rawEdges);
          setIsLayouting(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIsLayouting(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // layoutVersion triggers re-layout when "Reset Layout" is clicked
  }, [rawNodes, rawEdges, useGroups, layoutVersion]);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (node.type !== 'agent') return;
      onSelectAgentRef.current?.(node.id);

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
    [setCenter, getZoom, layoutedNodes],
  );

  /** Only allow connections from adapter nodes to agent nodes. */
  const isValidConnection: IsValidConnection = useCallback(
    (connection: Edge | Connection) => {
      const sourceNode = rawNodes.find((n) => n.id === connection.source);
      const targetNode = rawNodes.find((n) => n.id === connection.target);
      return sourceNode?.type === 'adapter' && targetNode?.type === 'agent';
    },
    [rawNodes],
  );

  /** Open the BindingDialog when a valid adapter-to-agent connection is made. */
  const handleConnect = useCallback(
    (connection: Connection) => {
      const sourceNode = rawNodes.find((n) => n.id === connection.source);
      const targetNode = rawNodes.find((n) => n.id === connection.target);
      if (sourceNode?.type !== 'adapter' || targetNode?.type !== 'agent') return;

      const adapterData = sourceNode.data as AdapterNodeData;
      const agentData = targetNode.data as AgentNodeData;

      setPendingConnection({
        sourceAdapterId: sourceNode.id.replace(/^adapter:/, ''),
        sourceAdapterName: adapterData.adapterName,
        targetAgentId: targetNode.id,
        targetAgentName: agentData.label,
        targetAgentDir: agentData.agentDir ?? '',
      });
    },
    [rawNodes],
  );

  /** Create the binding when the dialog is confirmed. */
  const handleBindingConfirm = useCallback(
    (opts: { sessionStrategy: SessionStrategy; label: string }) => {
      if (!pendingConnection) return;
      createBindingMutate({
        adapterId: pendingConnection.sourceAdapterId,
        agentId: pendingConnection.targetAgentId,
        agentDir: pendingConnection.targetAgentDir,
        sessionStrategy: opts.sessionStrategy,
        label: opts.label,
      });
      setPendingConnection(null);
    },
    [pendingConnection, createBindingMutate],
  );

  /** Track when a drag-to-connect starts from an adapter. */
  const handleConnectStart = useCallback(
    (_: MouseEvent | TouchEvent, params: { nodeId: string | null }) => {
      if (!params.nodeId) return;
      const sourceNode = rawNodes.find((n) => n.id === params.nodeId);
      if (sourceNode?.type === 'adapter') {
        setConnectingFrom(params.nodeId);
      }
    },
    [rawNodes],
  );

  /** Clear drag-to-connect state when connection ends. */
  const handleConnectEnd = useCallback(() => {
    setConnectingFrom(null);
  }, []);

  // Determine if the canvas should allow connections (only when adapters exist)
  const hasAdapters = relayEnabled && (adapters?.length ?? 0) > 0;
  const hasBindings = (bindings?.length ?? 0) > 0;
  const hasAgents = rawNodes.some((n) => n.type === 'agent');

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
          type="button"
          onClick={() => refetch()}
          className="rounded-md border px-3 py-1 text-xs hover:bg-muted"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!rawNodes.length) {
    return <TopologyEmptyState onGoToDiscovery={onGoToDiscovery} />;
  }

  // Count nodes for a11y summary
  const agentCount = rawNodes.filter((n) => n.type === 'agent').length;
  const adapterCount = rawNodes.filter((n) => n.type === 'adapter').length;
  const bindingCount = rawEdges.filter((e) => e.type === 'binding').length;

  return (
    <div
      className={`topology-container absolute inset-0${connectingFrom ? ' is-connecting' : ''}`}
      role="img"
      aria-roledescription="network topology graph"
    >
      {/* Screen-reader summary */}
      <div className="sr-only">
        Network topology: {agentCount} agent{agentCount !== 1 ? 's' : ''}, {adapterCount} adapter{adapterCount !== 1 ? 's' : ''}, {bindingCount} binding{bindingCount !== 1 ? 's' : ''}
      </div>
      <ReactFlow
        nodes={layoutedNodes}
        edges={layoutedEdges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onNodeClick={handleNodeClick}
        onNodeDragStop={handleNodeDragStop}
        onConnect={hasAdapters ? handleConnect : undefined}
        onConnectStart={hasAdapters ? handleConnectStart : undefined}
        onConnectEnd={hasAdapters ? handleConnectEnd : undefined}
        isValidConnection={hasAdapters ? isValidConnection : undefined}
        nodesConnectable={hasAdapters}
        nodesFocusable
        edgesFocusable
        fitView
        fitViewOptions={{ duration: 400, padding: 0.15 }}
        colorMode="system"
        onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--color-border)" />
        <MiniMap
          nodeColor={(n) => {
            if (n.type === 'adapter') return '#6366f1'; // indigo for adapters
            // Color-code agents by health status
            const health = n.data?.healthStatus as string | undefined;
            if (health === 'active') return '#22c55e'; // green
            if (health === 'inactive') return '#f59e0b'; // amber
            return '#94a3b8'; // gray for stale/unknown
          }}
          pannable
          zoomable
          className="!bg-card/80 !backdrop-blur-sm"
          style={{ height: 80 }}
        />
        <Controls showInteractive={false} />
        {hasDraggedNodes && (
          <div className="absolute bottom-2 left-2 z-10">
            <button
              type="button"
              onClick={handleResetLayout}
              title="Reset Layout"
              className="flex items-center gap-1 rounded-md border bg-card px-2 py-1 text-xs text-muted-foreground shadow-sm hover:bg-muted hover:text-foreground"
            >
              <RotateCcw className="size-3" />
              Reset Layout
            </button>
          </div>
        )}
        <TopologyLegend namespaces={legendEntries} />
      </ReactFlow>
      {/* Empty state hints for adapter/binding scenarios */}
      {relayEnabled && hasAgents && !hasAdapters && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md bg-muted/80 px-3 py-1.5 text-xs text-muted-foreground">
          Add adapters from the Relay panel to connect them to agents
        </div>
      )}
      {hasAdapters && hasAgents && !hasBindings && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md bg-muted/80 px-3 py-1.5 text-xs text-muted-foreground">
          Drag from an adapter to an agent to create a binding
        </div>
      )}
      <BindingDialog
        open={!!pendingConnection}
        onOpenChange={(open) => { if (!open) setPendingConnection(null); }}
        adapterName={pendingConnection?.sourceAdapterName ?? ''}
        agentName={pendingConnection?.targetAgentName ?? ''}
        onConfirm={handleBindingConfirm}
      />
    </div>
  );
}
