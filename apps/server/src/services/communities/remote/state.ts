/**
 * One local protected connection store shared by the pairing routes and the
 * later remote adapter. Constructed lazily after DORK_HOME is resolved at boot.
 *
 * @module services/communities/remote/state
 */
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { RemoteConnectionStore } from './connection-store.js';
import { RemoteCommunityPairingService } from './pairing-service.js';

let store: RemoteConnectionStore | undefined;
let pairing: RemoteCommunityPairingService | undefined;

/** The encrypted credential and owner-scoped metadata store for remote communities. */
export function getRemoteConnectionStore(): RemoteConnectionStore {
  return (store ??= new RemoteConnectionStore(resolveDorkHome()));
}

/** The production pairing service over the same protected connection store. */
export function getRemotePairingService(): RemoteCommunityPairingService {
  return (pairing ??= new RemoteCommunityPairingService(getRemoteConnectionStore()));
}
