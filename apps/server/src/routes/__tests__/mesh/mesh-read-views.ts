/**
 * The mesh routes' own read views, as boot hands them to the registry's doors
 * (`startup/steps/capabilities.ts`), for tests that serve those doors.
 */
import type { MeshReadViews } from '../../../services/mesh/doors/mesh-capability-deps.js';
import {
  projectComputerPlacement,
  projectComputerPlacementById,
} from '../../computer-placement.js';
import { enrichTopology } from '../../mesh-topology.js';

/** What the doors shape their answers with. */
export const meshReadViews: MeshReadViews = {
  enrichTopology,
  projectPlacement: projectComputerPlacement,
  projectPlacementById: projectComputerPlacementById,
};
