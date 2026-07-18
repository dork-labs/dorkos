/**
 * Embedded-mode stub methods factory — composes the server-only subsystem
 * stubs (Tasks, Relay, Mesh registry, Marketplace, tunnel/admin, activity)
 * into a single method bag for `DirectTransport`.
 *
 * These subsystems only exist on the server; see `embedded-mode-stubs.ts`
 * for the individual stub implementations.
 *
 * @module shared/lib/direct/stub-methods
 */
import {
  tasksStubs,
  relayStubs,
  adapterStubs,
  bindingStubs,
  meshStubs,
  serverOnlyStubs,
  activityStubs,
  marketplaceStubs,
  shapeStubs,
  workspaceStubs,
  cloudStubs,
} from '../embedded-mode-stubs';

/** Create the stubbed Transport surface for server-only subsystems. */
export function createEmbeddedStubMethods() {
  return {
    ...serverOnlyStubs,
    ...tasksStubs,
    ...relayStubs,
    ...adapterStubs,
    ...bindingStubs,
    ...activityStubs,
    ...meshStubs,
    ...marketplaceStubs,
    ...shapeStubs,
    ...workspaceStubs,
    ...cloudStubs,
  };
}
