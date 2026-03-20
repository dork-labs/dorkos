/**
 * Renders the mesh network topology as an interactive React Flow graph.
 *
 * Agents are grouped inside namespace containers using ELK compound layout.
 * When Relay is enabled, adapter nodes appear on the left with binding edges
 * connecting them to agent nodes on the right.
 *
 * @module features/mesh/ui/TopologyGraph
 */
import { useMemo, useEffect, useRef } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  MiniMap,
  Controls,
  type NodeTypes,
  type EdgeTypes,
} from '@xyflow/react';
import { Loader2, RotateCcw } from 'lucide-react';
import { AgentNode } from './AgentNode';
import { AdapterNode } from './AdapterNode';
import { BindingEdge } from './BindingEdge';
import { BindingDialog } from './BindingDialog';
import { NamespaceGroupNode } from './NamespaceGroupNode';
import { CrossNamespaceEdge } from './CrossNamespaceEdge';
import { DenyEdge } from './DenyEdge';
import { TopologyLegend } from './TopologyLegend';
import { TopologyEmptyState } from './TopologyEmptyState';
import { useTopologyHandlers } from './use-topology-handlers';
import { applyElkLayout } from '../lib/elk-layout';
import { buildTopologyElements } from '../lib/build-topology-elements';
import { useTopology } from '@/layers/entities/mesh';
import { useBindings, useCreateBinding, useDeleteBinding } from '@/layers/entities/binding';
import { useRelayAdapters, useRelayEnabled } from '@/layers/entities/relay';
import './topology-graph.css';

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

interface TopologyGraphProps {
  /** Called with the agent ID and project path when a node is clicked. */
  onSelectAgent?: (agentId: string, projectPath: string) => void;
  /** Called when the Settings action is triggered from the NodeToolbar. */
  onOpenSettings?: (agentId: string, projectPath: string) => void;
  /** Called to switch to the Discovery tab from the empty state. */
  onGoToDiscovery?: () => void;
  /** Called when the Chat action is triggered from the NodeToolbar. */
  onOpenChat?: (projectPath: string) => void;
  /** Called when the ghost adapter placeholder is clicked (opens adapter catalog). */
  onOpenAdapterCatalog?: () => void;
}

/**
 * Wraps TopologyGraphInner in a ReactFlowProvider so child hooks
 * (useReactFlow, fly-to selection) have access to the flow context.
 */
export function TopologyGraph(props: TopologyGraphProps) {
  return (
    <ReactFlowProvider>
      <TopologyGraphInner {...props} />
    </ReactFlowProvider>
  );
}

function TopologyGraphInner({
  onSelectAgent,
  onOpenSettings,
  onGoToDiscovery,
  onOpenChat,
  onOpenAdapterCatalog,
}: TopologyGraphProps) {
  const { data: topology, isLoading, isError, refetch } = useTopology();

  const namespaces = topology?.namespaces;
  const accessRules = topology?.accessRules;

  // Adapter & binding data (only fetched when Relay is enabled).
  const relayEnabled = useRelayEnabled();
  const { data: adapters } = useRelayAdapters(relayEnabled);
  const { data: bindings } = useBindings();
  const { mutate: createBindingMutate } = useCreateBinding();
  const { mutate: deleteBindingMutate } = useDeleteBinding();

  // Stable refs for callback props prevent useMemo re-creation on each render,
  // which would trigger ELK layout unnecessarily and risk infinite re-render loops.
  const onOpenSettingsRef = useRef(onOpenSettings);
  onOpenSettingsRef.current = onOpenSettings;
  const onSelectAgentRef = useRef(onSelectAgent);
  onSelectAgentRef.current = onSelectAgent;
  const onOpenChatRef = useRef(onOpenChat);
  onOpenChatRef.current = onOpenChat;
  const onOpenAdapterCatalogRef = useRef(onOpenAdapterCatalog);
  onOpenAdapterCatalogRef.current = onOpenAdapterCatalog;

  /** Pre-compute binding counts per adapter for O(1) lookup in buildTopologyElements. */
  const bindingCountByAdapter = useMemo(() => {
    const counts = new Map<string, number>();
    for (const b of bindings ?? []) {
      counts.set(b.adapterId, (counts.get(b.adapterId) ?? 0) + 1);
    }
    return counts;
  }, [bindings]);

  // Stable ref forwarding for handleDeleteBinding — declared before useMemo so
  // the closure below can call it without adding a changing value to dep array.
  // Initialized to a no-op; updated after the hook provides the real function.
  const handleDeleteBindingRef = useRef<(edgeId: string) => void>(() => undefined);

  const { rawNodes, rawEdges, legendEntries, useGroups } = useMemo(() => {
    return buildTopologyElements(
      namespaces ?? [],
      accessRules ?? [],
      relayEnabled,
      adapters,
      bindings,
      bindingCountByAdapter,
      // Calls via ref so this useMemo doesn't take handleDeleteBinding as a dep
      // (which would recompute nodes/edges on every layout pass).
      (edgeId) => handleDeleteBindingRef.current(edgeId),
      {
        onOpenSettings: (id, path) => onOpenSettingsRef.current?.(id, path),
        onSelectAgent: (id, path) => onSelectAgentRef.current?.(id, path),
        onOpenChat: (path) => onOpenChatRef.current?.(path),
        onGhostClick: () => onOpenAdapterCatalogRef.current?.(),
      }
    );
  }, [namespaces, accessRules, relayEnabled, adapters, bindings, bindingCountByAdapter]);

  const {
    layoutedNodes,
    setLayoutedNodes,
    layoutedEdges,
    setLayoutedEdges,
    layoutedNodesRef,
    isLayouting,
    setIsLayouting,
    manualPositions,
    layoutVersion,
    pendingConnection,
    setPendingConnection,
    connectingFrom,
    hasDraggedNodes,
    handleDeleteBinding,
    handleNodesChange,
    handleNodeDragStop,
    handleEdgesChange,
    handleResetLayout,
    handleNodeClick,
    isValidConnection,
    handleConnect,
    handleBindingConfirm,
    handleConnectStart,
    handleConnectEnd,
  } = useTopologyHandlers({ rawNodes, deleteBindingMutate, createBindingMutate });

  // Keep the ref current so the useMemo closure (above) always dispatches to
  // the latest stable version of handleDeleteBinding from the hook.
  handleDeleteBindingRef.current = handleDeleteBinding;

  // Stable fingerprint so ELK only re-runs when the graph structure actually
  // changes, not when useTopology refetch creates new object references.
  const topologyFingerprint = useMemo(() => {
    const nodeIds = rawNodes
      .map((n) => `${n.id}:${n.type}:${n.parentId ?? ''}`)
      .sort()
      .join('|');
    const edgeIds = rawEdges
      .map((e) => `${e.source}->${e.target}:${e.type}`)
      .sort()
      .join('|');
    return `${nodeIds}::${edgeIds}`;
  }, [rawNodes, rawEdges]);

  useEffect(() => {
    let cancelled = false;
    setIsLayouting(true);
    applyElkLayout(rawNodes, rawEdges, useGroups)
      .then((positioned) => {
        if (!cancelled) {
          // Merge manual position overrides from user drags.
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
        if (!cancelled) setIsLayouting(false);
      });
    return () => {
      cancelled = true;
    };
    // topologyFingerprint replaces rawNodes/rawEdges — ELK only re-runs when
    // the structural identity changes. layoutVersion triggers re-layout on reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topologyFingerprint, useGroups, layoutVersion]);

  // Keep the ref in sync so handleNodeClick always sees current node positions.
  useEffect(() => {
    layoutedNodesRef.current = layoutedNodes;
  }, [layoutedNodes, layoutedNodesRef]);

  // Capability flags derived from the current data state.
  const hasAdapters = relayEnabled && (adapters?.length ?? 0) > 0;
  const hasBindings = (bindings?.length ?? 0) > 0;
  const hasAgents = rawNodes.some((n) => n.type === 'agent');

  if (isLoading || isLayouting) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 text-sm">
        <span>Failed to load topology</span>
        <button
          type="button"
          onClick={() => refetch()}
          className="hover:bg-muted rounded-md border px-3 py-1 text-xs"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!rawNodes.length) {
    return <TopologyEmptyState onGoToDiscovery={onGoToDiscovery} />;
  }

  const agentCount = rawNodes.filter((n) => n.type === 'agent').length;
  const adapterCount = rawNodes.filter((n) => n.type === 'adapter').length;
  const bindingCount = rawEdges.filter((e) => e.type === 'binding').length;

  return (
    <div
      className={`topology-container absolute inset-0${connectingFrom ? 'is-connecting' : ''}`}
      role="img"
      aria-roledescription="network topology graph"
    >
      {/* Screen-reader summary */}
      <div className="sr-only">
        Network topology: {agentCount} agent{agentCount !== 1 ? 's' : ''}, {adapterCount} adapter
        {adapterCount !== 1 ? 's' : ''}, {bindingCount} binding{bindingCount !== 1 ? 's' : ''}
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
        <Background
          variant={BackgroundVariant.Dots}
          gap={16}
          size={1}
          color="hsl(var(--muted-foreground) / 0.15)"
        />
        <MiniMap
          nodeColor={(node) => {
            if (node.type === 'adapter') return 'hsl(var(--muted-foreground) / 0.4)';
            if (node.type === 'namespace-group') return 'transparent';
            // Agent nodes: use namespace color if available
            const data = node.data as Record<string, unknown>;
            return (data.namespaceColor as string) ?? 'hsl(var(--primary))';
          }}
          maskColor="hsl(var(--background) / 0.8)"
          pannable
          zoomable
          className="!right-2 !bottom-2"
          style={{ height: 80 }}
        />
        <Controls showInteractive={false} />
        {hasDraggedNodes && (
          <div className="absolute bottom-2 left-2 z-10">
            <button
              type="button"
              onClick={handleResetLayout}
              title="Reset Layout"
              className="bg-card text-muted-foreground hover:bg-muted hover:text-foreground flex items-center gap-1 rounded-md border px-2 py-1 text-xs shadow-sm"
            >
              <RotateCcw className="size-3" />
              Reset Layout
            </button>
          </div>
        )}
        <TopologyLegend namespaces={legendEntries} />
      </ReactFlow>
      {/* Contextual hints for adapter/binding onboarding */}
      {relayEnabled && hasAgents && !hasAdapters && (
        <div className="bg-muted/80 text-muted-foreground pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md px-3 py-1.5 text-xs">
          Add adapters from the Relay panel to connect them to agents
        </div>
      )}
      {hasAdapters && hasAgents && !hasBindings && (
        <div className="bg-muted/80 text-muted-foreground pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md px-3 py-1.5 text-xs">
          Drag from an adapter to an agent to create a binding
        </div>
      )}
      <BindingDialog
        open={!!pendingConnection}
        onOpenChange={(open) => {
          if (!open) setPendingConnection(null);
        }}
        adapterName={pendingConnection?.sourceAdapterName ?? ''}
        agentName={pendingConnection?.targetAgentName ?? ''}
        onConfirm={handleBindingConfirm}
      />
    </div>
  );
}
