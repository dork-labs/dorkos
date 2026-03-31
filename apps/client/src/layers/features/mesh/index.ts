/**
 * Mesh feature — agent discovery, registry, and observability UI.
 *
 * Internal components (TopologyGraph, AgentNode, MeshStatsHeader, AgentHealthDetail,
 * CandidateCard, AgentCard, RegisterAgentDialog, BindingDialog, AdapterNode, BindingEdge,
 * etc.) are encapsulated within the feature and accessed only via MeshPanel.
 *
 * @module features/mesh
 */
export { MeshPanel } from './ui/MeshPanel';
export { DiscoveryView } from './ui/DiscoveryView';
export { ScanRootInput } from '@/layers/entities/discovery';
