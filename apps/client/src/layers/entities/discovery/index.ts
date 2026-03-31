/**
 * Discovery entity — shared discovery scan state, hooks, utilities, and UI primitives.
 *
 * Provides a Zustand store (`useDiscoveryStore`) for cross-feature scan state,
 * a `useDiscoveryScan` hook that wraps the Transport `scan()` method, shared
 * utilities for registration and acted-path tracking, and the `CandidateCard`
 * UI component for rendering discovered agent candidates.
 *
 * @module entities/discovery
 */
export { useDiscoveryStore } from './model/discovery-store';
export type { DiscoveryState, DiscoveryActions } from './model/discovery-store';
export { useDiscoveryScan } from './model/use-discovery-scan';
export { useActedPaths } from './model/use-acted-paths';
export { buildRegistrationOverrides } from './lib/build-registration-overrides';
export { sortCandidates } from './lib/sort-candidates';
export { CandidateCard } from './ui/CandidateCard';
export { ExistingAgentCard } from './ui/ExistingAgentCard';
export { ScanRootInput } from './ui/ScanRootInput';
