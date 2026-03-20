/**
 * Custom hook encapsulating all ReactFlow event handlers for the topology graph.
 *
 * Extracts node/edge change handlers, connection handling, drag tracking, and
 * layout reset logic from TopologyGraphInner to keep the component focused on
 * rendering concerns.
 *
 * @module features/mesh/ui/use-topology-handlers
 */
import { useCallback, useRef, useState } from 'react';
import {
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type IsValidConnection,
} from '@xyflow/react';
import { useReactFlow } from '@xyflow/react';
import type { AgentNodeData } from './AgentNode';
import type { AdapterNodeData } from './AdapterNode';
import { AGENT_NODE_WIDTH, AGENT_NODE_HEIGHT } from '../lib/elk-layout';
import type { SessionStrategy } from '@dorkos/shared/relay-schemas';

/** Pending connection state while the BindingDialog is open. */
export interface PendingConnection {
  sourceAdapterId: string;
  sourceAdapterName: string;
  targetAgentId: string;
  targetAgentName: string;
}

interface UseTopologyHandlersOptions {
  rawNodes: Node[];
  deleteBindingMutate: (bindingId: string) => void;
  createBindingMutate: (opts: {
    adapterId: string;
    agentId: string;
    sessionStrategy: SessionStrategy;
    label: string;
  }) => void;
}

/**
 * Returns all ReactFlow event handlers and derived state for the topology graph.
 */
export function useTopologyHandlers({
  rawNodes,
  deleteBindingMutate,
  createBindingMutate,
}: UseTopologyHandlersOptions) {
  const { setCenter, getZoom } = useReactFlow();

  const [layoutedNodes, setLayoutedNodes] = useState<Node[]>([]);
  const [layoutedEdges, setLayoutedEdges] = useState<Edge[]>([]);
  // Ref mirror of layoutedNodes — avoids stale closure in handleNodeClick
  // without adding layoutedNodes to the useCallback dep array on every layout pass.
  const layoutedNodesRef = useRef<Node[]>([]);
  const [isLayouting, setIsLayouting] = useState(true);
  const [pendingConnection, setPendingConnection] = useState<PendingConnection | null>(null);
  const [connectingFrom, setConnectingFrom] = useState<string | null>(null);
  const [hasDraggedNodes, setHasDraggedNodes] = useState(false);
  // Track manual position overrides from user drags (session-only, not persisted).
  const manualPositions = useRef<Map<string, { x: number; y: number }>>(new Map());
  // Incremented to force a re-layout when "Reset Layout" is clicked.
  const [layoutVersion, setLayoutVersion] = useState(0);

  /** Extract binding UUID from a binding edge ID (strips the "binding:" prefix). */
  const extractBindingId = useCallback((edgeId: string) => edgeId.replace(/^binding:/, ''), []);

  /** Delete a binding by its edge ID. */
  const handleDeleteBinding = useCallback(
    (edgeId: string) => {
      deleteBindingMutate(extractBindingId(edgeId));
    },
    [deleteBindingMutate, extractBindingId]
  );

  /** Handle node changes (drag, selection) in ReactFlow controlled mode. */
  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    setLayoutedNodes((prev) => applyNodeChanges(changes, prev));
  }, []);

  /** Capture manual position when the user finishes dragging a node. */
  const handleNodeDragStop = useCallback((_: React.MouseEvent, node: Node) => {
    manualPositions.current.set(node.id, node.position);
    setHasDraggedNodes(true);
  }, []);

  /**
   * Handle edge changes in controlled mode.
   * Intercepts `remove` changes for binding edges to delete via API rather
   * than applying them to local state (data refetch handles the removal).
   */
  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const nonBindingChanges: EdgeChange[] = [];
      for (const change of changes) {
        if (change.type === 'remove' && change.id.startsWith('binding:')) {
          deleteBindingMutate(extractBindingId(change.id));
          continue;
        }
        nonBindingChanges.push(change);
      }
      if (nonBindingChanges.length > 0) {
        setLayoutedEdges((prev) => applyEdgeChanges(nonBindingChanges, prev));
      }
    },
    [deleteBindingMutate, extractBindingId]
  );

  /** Clear manual position overrides and trigger a fresh ELK layout pass. */
  const handleResetLayout = useCallback(() => {
    manualPositions.current.clear();
    setHasDraggedNodes(false);
    setLayoutVersion((v) => v + 1);
  }, []);

  /** Fly the viewport to center on the clicked agent node. */
  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (node.type !== 'agent') return;
      const nodeData = node.data as unknown as AgentNodeData;
      // onSelectAgent is called via the AgentNodeData callback — no direct call needed here.
      void nodeData;

      let centerX = node.position.x + AGENT_NODE_WIDTH / 2;
      let centerY = node.position.y + AGENT_NODE_HEIGHT / 2;

      if (node.parentId) {
        const parentNode = layoutedNodesRef.current.find((n) => n.id === node.parentId);
        if (parentNode) {
          centerX += parentNode.position.x;
          centerY += parentNode.position.y;
        }
      }

      const targetZoom = Math.max(getZoom(), 1.0);
      setCenter(centerX, centerY, { zoom: targetZoom, duration: 350 });
    },
    [setCenter, getZoom]
  );

  /** Only allow connections from non-ghost adapter nodes to agent nodes. */
  const isValidConnection: IsValidConnection = useCallback(
    (connection: Edge | Connection) => {
      const sourceNode = rawNodes.find((n) => n.id === connection.source);
      const targetNode = rawNodes.find((n) => n.id === connection.target);
      // Cannot connect from ghost adapter node
      if ((sourceNode?.data as Record<string, unknown>)?.isGhost) return false;
      return sourceNode?.type === 'adapter' && targetNode?.type === 'agent';
    },
    [rawNodes]
  );

  /** Open the BindingDialog when a valid adapter-to-agent connection is drawn. */
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
      });
    },
    [rawNodes]
  );

  /** Create the binding when the BindingDialog is confirmed. */
  const handleBindingConfirm = useCallback(
    (opts: { sessionStrategy: SessionStrategy; label: string }) => {
      if (!pendingConnection) return;
      createBindingMutate({
        adapterId: pendingConnection.sourceAdapterId,
        agentId: pendingConnection.targetAgentId,
        sessionStrategy: opts.sessionStrategy,
        label: opts.label,
      });
      setPendingConnection(null);
    },
    [pendingConnection, createBindingMutate]
  );

  /** Track when a drag-to-connect gesture starts from an adapter node. */
  const handleConnectStart = useCallback(
    (_: MouseEvent | TouchEvent, params: { nodeId: string | null }) => {
      if (!params.nodeId) return;
      const sourceNode = rawNodes.find((n) => n.id === params.nodeId);
      if (sourceNode?.type === 'adapter') {
        setConnectingFrom(params.nodeId);
      }
    },
    [rawNodes]
  );

  /** Clear drag-to-connect visual state when the connection gesture ends. */
  const handleConnectEnd = useCallback(() => {
    setConnectingFrom(null);
  }, []);

  return {
    // Controlled node/edge state
    layoutedNodes,
    setLayoutedNodes,
    layoutedEdges,
    setLayoutedEdges,
    layoutedNodesRef,
    isLayouting,
    setIsLayouting,
    manualPositions,
    layoutVersion,
    // Connection / binding dialog state
    pendingConnection,
    setPendingConnection,
    connectingFrom,
    hasDraggedNodes,
    // Handlers
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
  };
}
