/**
 * The agent registry's doors on `/api/mesh/*` (DOR-4978) for the conformance
 * suite: an empty registry, shaped by the mesh routes' own read views, as boot
 * wires them (`startup/steps/capabilities.ts`).
 */
import type { CapabilityDeps } from '../capability-definition.js';
import { meshReadViews } from '../../../../routes/__tests__/mesh/mesh-read-views.js';

/** The registry's deps over an empty registry. */
export const conformanceMeshDeps: NonNullable<CapabilityDeps['meshDeps']> = {
  meshCore: {
    listWithPaths: () => [],
    listWithHealth: () => [],
    get: () => undefined,
    getProjectPath: () => undefined,
    getStatus: () => ({ totalAgents: 0, activeCount: 0, inactiveCount: 0, staleCount: 0 }),
    getTopology: () => ({ callerNamespace: '*', namespaces: [], accessRules: [] }),
  } as unknown as NonNullable<CapabilityDeps['meshDeps']>['meshCore'],
  views: meshReadViews,
};
