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
  approvalStubs,
  marketplaceStubs,
  shapeStubs,
  workspaceStubs,
  roomStubs,
  cloudStubs,
  connectorStubs,
  mcpManagementStubs,
  teamStubs,
  profileStubs,
} from '../embedded-mode-stubs';
import { createLocalReadCursorMethods } from './read-cursor-methods';

/** Create the stubbed Transport surface for server-only subsystems. */
export function createEmbeddedStubMethods() {
  return {
    ...serverOnlyStubs,
    ...tasksStubs,
    ...relayStubs,
    ...adapterStubs,
    ...bindingStubs,
    ...activityStubs,
    ...approvalStubs,
    ...meshStubs,
    ...marketplaceStubs,
    ...shapeStubs,
    ...workspaceStubs,
    ...roomStubs,
    // Read state is NOT stubbed: the embed keeps its own cursors in this
    // browser, so the unread rule works there too (see the module's TSDoc).
    ...createLocalReadCursorMethods(),
    ...cloudStubs,
    ...connectorStubs,
    ...mcpManagementStubs,
    ...teamStubs,
    ...profileStubs,
  };
}
