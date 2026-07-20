/**
 * Mesh feature — agent discovery, registry, and observability UI.
 *
 * Exports topology and health components for composition on the Agents page,
 * plus discovery components. Internal components (TopologyGraph, AgentNode,
 * CandidateCard, RegisterAgentDialog, AdapterNode, BindingEdge, etc.) remain
 * encapsulated. The binding dialog + form model now live in entities/binding.
 *
 * @module features/mesh
 */
export { DiscoveryView } from './ui/DiscoveryView';
export { ImportProjectsDialog } from './ui/ImportProjectsDialog';
export { TopologyPanel } from './ui/TopologyPanel';
export { AgentHealthDetail } from './ui/AgentHealthDetail';
export { MeshEmptyState } from './ui/MeshEmptyState';
export { ScanRootInput } from '@/layers/entities/discovery';
