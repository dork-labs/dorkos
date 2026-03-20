/**
 * ELK-based layout computation for the mesh topology graph.
 *
 * Applies a hierarchical left-to-right layout using the ELK.js library,
 * supporting compound namespace group nodes and layer-constrained adapter nodes.
 *
 * @module features/mesh/lib/elk-layout
 */
import ELK from 'elkjs/lib/elk.bundled.js';
import type { Node, Edge } from '@xyflow/react';

const elk = new ELK();

/** Width of an agent node in layout calculations (ExpandedCard max). */
export const AGENT_NODE_WIDTH = 240;
/** Height of an agent node in layout calculations (ExpandedCard max). */
export const AGENT_NODE_HEIGHT = 150;
/** Padding inside namespace group containers. */
const GROUP_PADDING = 48;

/**
 * Applies ELK layered layout with compound nodes for namespace groups.
 *
 * Adapter nodes are placed in the first (leftmost) layer. Agent nodes are
 * placed in the last (rightmost) layer when adapters are present. When
 * `useGroups` is true, agent nodes are arranged inside namespace group
 * containers using ELK compound layout.
 *
 * @param nodes - React Flow nodes with initial positions (will be overwritten)
 * @param edges - React Flow edges used to guide layout direction
 * @param useGroups - Whether to use compound group layout for namespaces
 * @returns New node array with ELK-computed positions applied
 */
export async function applyElkLayout(
  nodes: Node[],
  edges: Edge[],
  useGroups: boolean
): Promise<Node[]> {
  if (nodes.length === 0) return nodes;

  const groupNodes = nodes.filter((n) => n.type === 'namespace-group');
  const agentNodes = nodes.filter((n) => n.type === 'agent');
  const adapterNodes = nodes.filter((n) => n.type === 'adapter');

  // Adapter nodes are standalone (not inside groups) and placed on the left.
  const adapterElkChildren = adapterNodes.map((a) => ({
    id: a.id,
    width: (a.style?.width as number | undefined) ?? AGENT_NODE_WIDTH,
    height: (a.style?.height as number | undefined) ?? AGENT_NODE_HEIGHT,
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
        // Place agents in the last layer (rightmost) when adapters are present.
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
    if (node.type === 'adapter') {
      const laidNode = laid.children?.find((n) => n.id === node.id);
      if (!laidNode) return node;
      return { ...node, position: { x: laidNode.x ?? 0, y: laidNode.y ?? 0 } };
    }
    // Agent node — find in parent group or root.
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
