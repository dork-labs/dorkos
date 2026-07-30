/**
 * Communities subsystem barrel (spec `community-adapter`).
 *
 * The server-side half of the `CommunityAdapter` port: the registry that
 * dispatches `(community, roomId)`, the ADR-0310 aggregation that lists rooms
 * across communities with per-community degradation, and the credential
 * discipline every machine-managed adapter resolves through.
 *
 * The first concrete adapter lives in `local/` — this machine's own SQLite
 * rooms, wrapped rather than rewritten. A read-only Buzz relay and
 * `apps/community` follow, in that order, and each ships with its own
 * `communityConformance` registration.
 *
 * @module server/services/communities
 */
export {
  aggregateCommunityRooms,
  LIST_ROOMS_TIMEOUT_MS,
  type CommunityListingSource,
} from './aggregate-community-rooms.js';
export {
  communityCredentialEnvVar,
  communityDir,
  repairCommunityCredentialPermissions,
  resolveCommunityCredential,
} from './credentials.js';
// Only the startup wiring leaves this domain — the adapter itself is reached
// through the registry, the way every other backend behind this port will be.
export { registerLocalCommunity } from './local/register-local-community.js';
export {
  CommunityNotRegisteredError,
  CommunityRegistry,
  communityRegistry,
  type RegisteredCommunity,
} from './registry.js';
