/**
 * The `/api` chain's own steps a WebSocket upgrade asks too, handed to the
 * upgrade router (`services/core/streams/upgrade-router.ts`) so that service
 * imports no middleware (DOR-4922). Built once here; `index.ts` passes it to
 * every listener's router.
 *
 * @module startup/upgrade-guards
 */
import { resolveAgentIdentityFromHeaders } from '../middleware/agent-identity.js';
import { bypassesManagedIngress } from '../middleware/managed-host-guard.js';
import {
  refusedByRemoteAccessSwitch,
  trackRemoteStream,
} from '../middleware/remote-access-switch.js';
import type { UpgradeGuards } from '../services/core/streams/upgrade-router.js';

/** The chain's managed-host guard, Remote Access switch and agent-identity resolver. */
export const upgradeGuards: UpgradeGuards = {
  bypassesManagedIngress,
  refusedByRemoteAccessSwitch,
  trackRemoteStream,
  resolveAgentIdentity: resolveAgentIdentityFromHeaders,
};
