/** Actual original exclusion/context for production Git primitive controls on fixture trees.
 * This owns no human/runtime permission and does not register a caller issuer.
 */
import { tmpdir } from 'node:os';
import type { Db } from '@dorkos/db';
import { initBoundary } from '../../../../lib/boundary.js';
import { DocChannelStore } from '../../../canvas/doc-channel/store.js';
import {
  InstallationFileWrites,
  readInstallationFileRoomWrites,
  stopInstallationFileWrites,
} from '../../../canvas/doc-channel/writes/installation-file-writes.js';
import {
  withRecognizedInstallationRoomNamespace,
  readInstallationRoomMutationContext,
  type InstallationRoomMutationContext,
} from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import { RoomRepoMutex } from '../room-repo-mutex.js';
import type { RoomRepoStore } from '../room-repo-store.js';
import {
  commitAll,
  stagePaths,
  removeWorktree,
  mergeNoFf,
  type GitIdentity,
} from '../room-repo-git.js';
import { afterFailedWrite } from '../room-worktree-refresh.js';

type Assembly = {
  owner: InstallationFileWrites;
  channels: DocChannelStore;
  writer: ReturnType<typeof readInstallationFileRoomWrites>;
  repos: RoomRepoStore;
};
const owners = new WeakMap<Db, Promise<Assembly>>();
function owning(db: Db, repos: RoomRepoStore): Promise<Assembly> {
  let result = owners.get(db);
  if (!result) {
    // Install the one-use construction promise before native/host observation.
    result = Promise.resolve().then(async () => {
      await initBoundary(tmpdir());
      const channels = new DocChannelStore(db);
      const owner = new InstallationFileWrites({
        db,
        store: channels,
        roomRepos: repos,
        roomMutex: new RoomRepoMutex(),
      });
      return {
        owner,
        channels,
        writer: readInstallationFileRoomWrites(owner, db, channels, repos),
        repos,
      };
    });
    owners.set(db, result);
  }
  return result;
}
async function mutation<T>(
  db: Db,
  repos: RoomRepoStore,
  roomId: string,
  work: (context: InstallationRoomMutationContext) => Promise<T>
): Promise<T> {
  const actual = await owning(db, repos);
  if (actual.repos !== repos) throw new Error('Original fixture repository changed.');
  return withRecognizedInstallationRoomNamespace(actual.writer, roomId, (scope) =>
    work(readInstallationRoomMutationContext(actual.writer, roomId, scope))
  );
}
/** Must positively drain before the caller closes its Db or removes the fixture tree. */
export async function stopOriginalFixtureRoomMutations(db: Db): Promise<void> {
  const pending = owners.get(db);
  if (!pending) return;
  const actual = await pending;
  await stopInstallationFileWrites(actual.owner, db, actual.channels);
  owners.delete(db);
}
export function ownedFixtureCommitAll(
  db: Db,
  repos: RoomRepoStore,
  roomId: string,
  checkout: string,
  message: string,
  identity: GitIdentity,
  ceiling: string
): Promise<string> {
  return mutation(db, repos, roomId, (context) =>
    commitAll(checkout, message, identity, ceiling, context)
  );
}
export function ownedFixtureStagePaths(
  db: Db,
  repos: RoomRepoStore,
  roomId: string,
  checkout: string,
  paths: readonly string[],
  ceiling: string
): Promise<void> {
  return mutation(db, repos, roomId, (context) => stagePaths(checkout, paths, ceiling, context));
}
export function ownedFixtureRemoveWorktree(
  db: Db,
  repos: RoomRepoStore,
  roomId: string,
  checkout: string,
  worktree: string,
  ceiling: string
): Promise<void> {
  return mutation(db, repos, roomId, (context) =>
    removeWorktree(checkout, worktree, ceiling, context)
  );
}
export function ownedFixtureMergeNoFf(
  db: Db,
  repos: RoomRepoStore,
  roomId: string,
  checkout: string,
  branch: string,
  message: string,
  identity: GitIdentity,
  ceiling: string
): Promise<string> {
  return mutation(db, repos, roomId, (context) =>
    mergeNoFf(checkout, branch, message, identity, ceiling, context)
  );
}
export function ownedFixtureAfterFailedWrite(
  db: Db,
  repos: RoomRepoStore,
  roomId: string,
  lock: string,
  lockedBefore: boolean,
  error: unknown
): Promise<void> {
  return mutation(db, repos, roomId, (context) =>
    afterFailedWrite(lock, lockedBefore, error, context)
  );
}
