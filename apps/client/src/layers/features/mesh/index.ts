/**
 * Mesh feature — agent discovery, registry, and observability UI.
 *
 * Exports topology and health components for composition on the Team page,
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
export { TopologyPreview } from './ui/TopologyPreview';
// The topology's own health vocabulary. Exported because the dev playground
// mirrors these node cards, and a showcase that re-spelled the colours would be
// exactly the second source of truth this map exists to remove.
export { HEALTH_DISPLAY } from './lib/health-display';
export { ScanRootInput } from '@/layers/entities/discovery';
