/**
 * One local protected connection store shared by the pairing routes and the
 * later remote adapter. Constructed lazily after DORK_HOME is resolved at boot.
 *
 * @module services/communities/remote/state
 */
import type { Db } from '@dorkos/db';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { RemoteConnectionStore } from './connection-store.js';
import { RemoteCommunityPairingService } from './pairing-service.js';
import { RemoteCommunityAdapter } from './remote-community-adapter.js';
import { CommunityAgentEnrollmentStore } from './agent-enrollment-store.js';

let store: RemoteConnectionStore | undefined;
let pairing: RemoteCommunityPairingService | undefined;
let db: Db | undefined;
let enrollments: CommunityAgentEnrollmentStore | undefined;
let lifecycle: RemoteCommunityLifecycle | undefined;
const adapters = new Map<string, RemoteCommunityAdapter>();

/** The locally durable stop surface; it never requires the remote service to be reachable. */
export interface RemoteCommunityLifecycle {
  haltRoom(
    communityRef: CommunityRef,
    remoteRoomId: string,
    ownerAuthorId: string
  ): Promise<number>;
  haltAgent(
    communityRef: CommunityRef,
    localAgentId: string,
    ownerAuthorId: string
  ): Promise<number>;
}

/** The encrypted credential and owner-scoped metadata store for remote communities. */
export function getRemoteConnectionStore(): RemoteConnectionStore {
  return (store ??= new RemoteConnectionStore(resolveDorkHome()));
}

/** The production pairing service over the same protected connection store. */
export function getRemotePairingService(): RemoteCommunityPairingService {
  return (pairing ??= new RemoteCommunityPairingService(getRemoteConnectionStore()));
}

/** Bind the consolidated SQLite database before any remote lifecycle route starts. */
export function setRemoteCommunityDb(database: Db): void {
  db = database;
  enrollments = new CommunityAgentEnrollmentStore(database);
}

/** Read durable owner-scoped native agent enrollment state. */
export function getRemoteCommunityEnrollmentStore(): CommunityAgentEnrollmentStore {
  if (!enrollments || !db)
    throw new Error('Remote community enrollment store requires startup database wiring');
  return enrollments;
}

/** Bind the production mirror lifecycle after the room subsystem is constructed. */
export function setRemoteCommunityLifecycle(next: RemoteCommunityLifecycle): void {
  lifecycle = next;
}

/** Read the native stop lifecycle. Startup wiring is required before routes serve requests. */
export function getRemoteCommunityLifecycle(): RemoteCommunityLifecycle {
  if (!lifecycle) throw new Error('Remote community lifecycle requires startup wiring');
  return lifecycle;
}

/** Construct the one native adapter shape used by connection lifecycle and qualified routes. */
export function getRemoteCommunityAdapter(
  ref: CommunityRef,
  ownerAuthorId: string
): RemoteCommunityAdapter {
  const key = `${ref}:${ownerAuthorId}`;
  let adapter = adapters.get(key);
  if (!adapter) {
    adapter = new RemoteCommunityAdapter(
      ref,
      ownerAuthorId,
      getRemoteConnectionStore(),
      getRemoteCommunityEnrollmentStore()
    );
    adapters.set(key, adapter);
  }
  return adapter;
}
