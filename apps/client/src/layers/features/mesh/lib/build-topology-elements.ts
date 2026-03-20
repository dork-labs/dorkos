/**
 * Build React Flow nodes and edges from mesh topology data.
 *
 * Pure function — no React hooks. Suitable for use inside useMemo.
 *
 * @module features/mesh/lib/build-topology-elements
 */
import type { Node, Edge } from '@xyflow/react';
import type { NamespaceInfo, CrossNamespaceRule, TopologyAgent } from '@dorkos/shared/mesh-schemas';
import type { AdapterListItem } from '@dorkos/shared/transport';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';
import type { AgentNodeData } from '../ui/AgentNode';
import type { AdapterNodeData } from '../ui/AdapterNode';
import type { BindingEdgeData } from '../ui/BindingEdge';
import { getNamespaceColor } from './namespace-colors';

/** Structured result from building topology elements. */
export interface TopologyElements {
  /** React Flow nodes (agents, adapters, namespace groups). */
  rawNodes: Node[];
  /** React Flow edges (bindings, cross-namespace rules). */
  rawEdges: Edge[];
  /** Legend entries for namespace color display. */
  legendEntries: { namespace: string; color: string }[];
  /** Whether namespace group containers should be used. */
  useGroups: boolean;
}

/** Callbacks injected into agent node data — use stable ref values to avoid re-renders. */
export interface AgentNodeCallbacks {
  onOpenSettings?: (agentId: string, projectPath: string) => void;
  onSelectAgent?: (agentId: string, projectPath: string) => void;
  onOpenChat?: (projectPath: string) => void;
  /** Called when the ghost adapter placeholder is clicked. */
  onGhostClick?: () => void;
}

/**
 * Build React Flow nodes and edges from raw mesh topology data.
 *
 * Constructs adapter nodes (left side), namespace group containers
 * (multi-namespace only), agent nodes, binding edges, and cross-namespace
 * access rule edges.
 *
 * @param namespaces - Namespace topology from the server
 * @param accessRules - Cross-namespace access rules
 * @param relayEnabled - Whether Relay is enabled (controls adapter nodes)
 * @param adapters - Registered relay adapters
 * @param bindings - Active adapter-agent bindings
 * @param bindingCountByAdapter - Pre-computed binding counts keyed by adapter ID
 * @param handleDeleteBinding - Stable callback to delete a binding by edge ID
 * @param callbacks - Stable agent interaction callbacks (use ref.current values)
 */
export function buildTopologyElements(
  namespaces: NamespaceInfo[],
  accessRules: CrossNamespaceRule[],
  relayEnabled: boolean,
  adapters: AdapterListItem[] | undefined,
  bindings: AdapterBinding[] | undefined,
  bindingCountByAdapter: Map<string, number>,
  handleDeleteBinding: (edgeId: string) => void,
  callbacks: AgentNodeCallbacks
): TopologyElements {
  if (!namespaces.length) {
    return {
      rawNodes: [] as Node[],
      rawEdges: [] as Edge[],
      legendEntries: [],
      useGroups: false,
    };
  }

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const legend: { namespace: string; color: string }[] = [];

  // --- Adapter nodes (left side) ---
  // Filter out CCA — it's an internal runtime, not a relay topology node.
  const externalAdapters = adapters?.filter((a) => a.config.type !== 'claude-code') ?? [];

  if (relayEnabled && externalAdapters.length > 0) {
    for (const adapter of externalAdapters) {
      nodes.push({
        id: `adapter:${adapter.config.id}`,
        type: 'adapter',
        position: { x: 0, y: 0 },
        data: {
          adapterName: adapter.status.displayName,
          adapterType: adapter.config.type,
          adapterStatus:
            adapter.status.state === 'connected'
              ? 'running'
              : adapter.status.state === 'error'
                ? 'error'
                : 'stopped',
          bindingCount: bindingCountByAdapter.get(adapter.config.id) ?? 0,
          label: adapter.config.label,
        } satisfies AdapterNodeData,
      });
    }
  }

  // Ghost placeholder when relay is on but no external adapters exist.
  if (relayEnabled && externalAdapters.length === 0) {
    nodes.push({
      id: 'ghost-adapter',
      type: 'adapter',
      position: { x: 0, y: 0 },
      data: {
        adapterName: 'Add Adapter',
        adapterType: 'ghost',
        adapterStatus: 'stopped',
        bindingCount: 0,
        isGhost: true,
        onGhostClick: () => callbacks.onGhostClick?.(),
      } satisfies AdapterNodeData,
    });
  }

  // Always show namespace containers — teaches the concept before users scale up.
  const useGroups = namespaces.length >= 1;

  for (let nsIdx = 0; nsIdx < namespaces.length; nsIdx++) {
    const ns = namespaces[nsIdx];
    const color = getNamespaceColor(nsIdx);
    legend.push({ namespace: ns.namespace, color });
    const groupId = `group:${ns.namespace}`;

    const activeCount = ns.agents.filter((a) => {
      const typedAgent = a as TopologyAgent;
      return typedAgent.healthStatus === 'active';
    }).length;

    if (useGroups) {
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
      const typedAgent = agent as TopologyAgent;
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
          behavior: agent.behavior ? { responseMode: agent.behavior.responseMode } : undefined,
          color: typedAgent.color ?? null,
          emoji: typedAgent.icon ?? null,
          projectPath: typedAgent.projectPath ?? '',
          onOpenSettings: (id: string) =>
            callbacks.onOpenSettings?.(id, typedAgent.projectPath ?? ''),
          onViewHealth: (id: string) => callbacks.onSelectAgent?.(id, typedAgent.projectPath ?? ''),
          onOpenChat: (_id: string, path: string) => callbacks.onOpenChat?.(path),
        } satisfies AgentNodeData,
      };

      if (useGroups) {
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
      // Only create edge if both source and target nodes exist.
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
          chatId: binding.chatId || undefined,
          channelType: binding.channelType || undefined,
          onDelete: handleDeleteBinding,
        } satisfies BindingEdgeData,
      });
    }
  }

  // Cross-namespace edges connect between group nodes.
  for (const rule of accessRules) {
    const sourceId = useGroups
      ? `group:${rule.sourceNamespace}`
      : (namespaces[0]?.agents[0]?.id ?? '');
    const targetId = useGroups
      ? `group:${rule.targetNamespace}`
      : (namespaces[0]?.agents[0]?.id ?? '');
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

  return { rawNodes: nodes, rawEdges: edges, legendEntries: legend, useGroups };
}
