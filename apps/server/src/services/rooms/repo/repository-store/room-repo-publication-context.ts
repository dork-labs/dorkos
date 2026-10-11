import type { Stats } from 'node:fs';
import type { Db, roomRepos } from '@dorkos/db';
import type { RoomRepoSidecar } from '@dorkos/shared/room-repo';
import type { RoomRepoStore } from '../room-repo-store.js';
import type { createIsolatedRoomRepoOwnerCustody } from './room-repo-owner-custody.js';
import type { InstallationRoomMutationContext } from '../../../canvas/doc-channel/writes/installation-room-writes.js';

/** Exact original publication cells; writable views require the inaccessible constructor key. */
export interface OriginalRoomRepoPublicationView {
  readonly store: RoomRepoStore;
  readonly db: Db;
  readonly publications: WeakMap<
    InstallationRoomMutationContext,
    {
      sidecar: RoomRepoSidecar;
      installation: string;
      installationStat: Stats;
      parent: string;
      parentStat: Stats;
      target: string;
      acquired: Stats;
      previousRow: Readonly<typeof roomRepos.$inferSelect> | null;
      newTarget: boolean;
    }
  >;
  readonly readOwner: ReturnType<typeof createIsolatedRoomRepoOwnerCustody>['readOwner'];
  requireOriginalStoreOperation: ReturnType<
    typeof createIsolatedRoomRepoOwnerCustody
  >['requireOriginalStoreOperation'];
  sameStoreInode(left: Stats, right: Stats): boolean;
  upsertOwned(context: InstallationRoomMutationContext, sidecar: RoomRepoSidecar): void;
}
