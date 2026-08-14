/**
 * Communities subsystem barrel (spec `community-adapter`).
 *
 * The server-side half of the `CommunityAdapter` port: the registry that
 * dispatches `(community, roomId)`, the ADR-0310 aggregation that lists rooms
 * across communities with per-community degradation, and the credential
 * discipline every machine-managed adapter resolves through.
 *
 * `GET /api/rooms` is the port's production consumer, through
 * {@link listRoomsAcrossCommunities} — which also says, at length, why this
 * machine's own rooms deliberately do not travel over it.
 *
 * Two concrete adapters live here. `local/` is this machine's own SQLite rooms,
 * wrapped rather than rewritten. `buzz/` is a read-only Buzz relay — the foreign
 * case, kept deliberately unlike ours so the port cannot quietly become a
 * description of our own backend. `apps/community` is the third. Each ships with
 * its own `communityConformance` registration.
 *
 * **The Buzz adapter is not exported here, and not registered at startup.** That
 * is the whole of its wiring story: it needs a relay URL and a label from
 * somebody, which means a user-config surface nobody has built. The room list
 * would carry it the day one exists. Re-exporting it before anything constructs
 * it would be dead code dressed as an API — it is reached at
 * `./buzz/buzz-community-adapter.js`, and it joins this barrel the day something
 * configures a remote community.
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
export { listRoomsAcrossCommunities } from './list-rooms-across-communities.js';
// Only the startup wiring leaves this domain — the adapter itself is reached
// through the registry, the way every other backend behind this port will be.
export { registerLocalCommunity } from './local/register-local-community.js';
export {
  CommunityNotRegisteredError,
  CommunityRegistry,
  communityRegistry,
  type RegisteredCommunity,
} from './registry.js';
