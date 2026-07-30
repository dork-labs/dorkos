/**
 * Communities subsystem barrel (spec `community-adapter`).
 *
 * The server-side half of the `CommunityAdapter` port: the registry that
 * dispatches `(community, roomId)`, the ADR-0310 aggregation that lists rooms
 * across communities with per-community degradation, and the credential
 * discipline every machine-managed adapter resolves through.
 *
 * No concrete adapter lives here. Local rooms, a read-only Buzz relay and
 * `apps/community` are separate tickets, in that order, and each ships with its
 * own `communityConformance` registration.
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
export {
  CommunityNotRegisteredError,
  CommunityRegistry,
  communityRegistry,
  type RegisteredCommunity,
} from './registry.js';
