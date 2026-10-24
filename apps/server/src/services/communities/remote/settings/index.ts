/**
 * The production space settings reader: one per process, reading through the encrypted
 * connection store and keeping its last answers beside the connections (DOR-3005).
 *
 * @module services/communities/remote/settings
 */
import { resolveDorkHome } from '../../../../lib/dork-home.js';
import { getRemoteConnectionStore, getRemotePairingService } from '../state.js';
import {
  RemoteConnectionAuthorizationError,
  RemoteConnectionNotFoundError,
  type RemoteConnectionStore,
} from '../connection-store.js';
import type { RemoteCommunityPairingService } from '../pairing-service.js';
import { SpaceSettingsCache } from './space-settings-cache.js';
import { SpaceSettingsReader, type SpaceConnectionSource } from './space-settings-reader.js';

export { SpaceSettingsCache } from './space-settings-cache.js';
export {
  SPACE_READ_PATHS,
  SpaceReadRefusedError,
  SpaceSettingsReader,
  type SpaceConnectionSource,
  type SpaceRequest,
} from './space-settings-reader.js';

let cache: SpaceSettingsCache | undefined;
let reader: SpaceSettingsReader | undefined;

/** The last answers each connection's settings reads returned. */
export function getSpaceSettingsCache(): SpaceSettingsCache {
  return (cache ??= new SpaceSettingsCache(resolveDorkHome()));
}

/**
 * Where a connection points and the grant that reads it, from the connection store; after a 401,
 * the pairing service's own access check decides whether the grant was rejected.
 *
 * @param store - The encrypted connection store.
 * @param pairing - The pairing service, whose status check marks a rejected grant.
 */
export function connectionSource(
  store: Pick<RemoteConnectionStore, 'get' | 'personalToken'>,
  pairing: () => Pick<RemoteCommunityPairingService, 'status'>
): SpaceConnectionSource {
  return {
    async place(ref, owner) {
      const record = await store.get(ref, owner);
      if (record.status === 'reconnect-required') throw new RemoteConnectionAuthorizationError();
      if (record.status !== 'connected') throw new RemoteConnectionNotFoundError();
      return { pinnedOrigin: record.pinnedOrigin, remoteCommunityId: record.remoteCommunityId };
    },
    credential: (ref, owner) => store.personalToken(ref, owner),
    async grantRejected(ref, owner) {
      return (await pairing().status(ref, owner)).status === 'reconnect-required';
    },
  };
}

/** Reads a connected space's settings through its own grant. */
export function getSpaceSettingsReader(): SpaceSettingsReader {
  return (reader ??= new SpaceSettingsReader(
    connectionSource(getRemoteConnectionStore(), getRemotePairingService),
    getSpaceSettingsCache()
  ));
}
