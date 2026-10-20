/**
 * The production space settings reader: one per process, reading through the encrypted
 * connection store and keeping its last answers beside the connections (DOR-3005).
 *
 * @module services/communities/remote/settings
 */
import { resolveDorkHome } from '../../../../lib/dork-home.js';
import { getRemoteConnectionStore } from '../state.js';
import { SpaceSettingsCache } from './space-settings-cache.js';
import { SpaceSettingsReader } from './space-settings-reader.js';

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

/** Reads a connected space's settings through its own grant. */
export function getSpaceSettingsReader(): SpaceSettingsReader {
  return (reader ??= new SpaceSettingsReader(
    {
      async place(ref, owner) {
        const record = await getRemoteConnectionStore().get(ref, owner);
        return { pinnedOrigin: record.pinnedOrigin, remoteCommunityId: record.remoteCommunityId };
      },
      credential: (ref, owner) => getRemoteConnectionStore().personalToken(ref, owner),
    },
    getSpaceSettingsCache()
  ));
}
