import { randomUUID } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { RoomRepoSidecarSchema, type RoomRepoSidecar } from '@dorkos/shared/room-repo';
import {
  checkInstallationRoomMutationTarget,
  readInstallationRoomStoreRoots,
  type InstallationRoomMutationContext,
} from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import {
  ROOM_REPO_SIDECAR_FILENAME,
  captureRoomRepoPersistenceMetadata,
  serializeBoundedRoomRepoSidecar,
} from './room-repo-sidecar-data.js';
import {
  readOriginalRoomRepoPublicationView,
  requireRoomRepoStoreDatabase,
} from '../room-repo-store.js';

/** Publish only through the original constructor-owned store turn and unchanged native operation checks. */
export async function publishOriginalRoomRepoSidecar(
  owner: object,
  context: InstallationRoomMutationContext,
  input: RoomRepoSidecar
): Promise<void> {
  const facet = readOriginalRoomRepoPublicationView(owner);
  const captured = captureRoomRepoPersistenceMetadata(input);
  const sidecar = Object.freeze(RoomRepoSidecarSchema.parse(captured));
  const serialized = serializeBoundedRoomRepoSidecar(sidecar);
  const roots = readInstallationRoomStoreRoots(context, facet.store, facet.db),
    dir = roots.home;
  facet.requireOriginalStoreOperation(facet.store, facet.db, context, sidecar.roomId);
  const installation = await fs.lstat(roots.installation);
  if (
    !installation.isDirectory() ||
    installation.isSymbolicLink() ||
    (await fs.realpath(roots.installation)) !== roots.canonicalInstallation
  )
    throw new Error('Room installation root changed.');
  facet.requireOriginalStoreOperation(facet.store, facet.db, context, sidecar.roomId);
  for (const directory of [roots.root, dir]) {
    const parentPath = path.dirname(directory),
      parentBefore = await fs.lstat(parentPath);
    if (
      !parentBefore.isDirectory() ||
      parentBefore.isSymbolicLink() ||
      (await fs.realpath(parentPath)) !==
        path.join(roots.canonicalInstallation, path.relative(roots.installation, parentPath))
    )
      throw new Error('Room sidecar directory parent is not its actual directory.');
    let before: Stats | undefined;
    try {
      before = await fs.lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
    if (before && (!before.isDirectory() || before.isSymbolicLink()))
      throw new Error('Room sidecar directory is not its actual directory.');
    if (
      !facet.sameStoreInode(parentBefore, await fs.lstat(parentPath)) ||
      !facet.sameStoreInode(installation, await fs.lstat(roots.installation))
    )
      throw new Error('Room sidecar directory parent replaced before acquisition.');
    facet.requireOriginalStoreOperation(facet.store, facet.db, context, sidecar.roomId);
    if (!before) await fs.mkdir(directory);
    const stat = await fs.lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (before && !facet.sameStoreInode(before, stat)) ||
      (await fs.realpath(directory)) !==
        path.join(roots.canonicalInstallation, path.relative(roots.installation, directory)) ||
      !facet.sameStoreInode(parentBefore, await fs.lstat(parentPath)) ||
      !facet.sameStoreInode(installation, await fs.lstat(roots.installation))
    )
      throw new Error('Room sidecar parent is not its actual directory.');
    facet.requireOriginalStoreOperation(facet.store, facet.db, context, sidecar.roomId);
  }
  const parent = await fs.lstat(dir),
    target = path.join(dir, ROOM_REPO_SIDECAR_FILENAME),
    tmp = path.join(dir, `.${randomUUID()}.tmp`);
  const previousRow = facet.readOwner(facet.store)!.read(sidecar.roomId);
  let previousTarget: Stats | undefined;
  try {
    previousTarget = await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  if (previousTarget && (!previousTarget.isFile() || previousTarget.isSymbolicLink()))
    throw new Error('Room sidecar destination is not its actual regular file.');
  await checkInstallationRoomMutationTarget(context, target);
  facet.requireOriginalStoreOperation(facet.store, facet.db, context, sidecar.roomId);
  let file: FileHandle | undefined, acquired: Stats | undefined;
  let failed = false,
    cause: unknown;
  // Join this scope to its captured cleanup before returning or reporting failure.
  const drainOriginalCleanup = async () => {
    if (file) {
      try {
        await file.close();
      } catch (error) {
        if (!failed) {
          failed = true;
          cause = error;
        }
      }
    }
    // Acquired cleanup custody only: no new forward permission or pathname inference.
    // Scope lifetime remains held by the original caller until this finally returns.
    if (acquired) {
      try {
        const currentParent = await fs.lstat(dir),
          currentInstallation = await fs.lstat(roots.installation);
        let currentFile: Stats | undefined;
        try {
          currentFile = await fs.lstat(tmp);
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
        }
        if (currentFile) {
          if (
            !facet.sameStoreInode(parent, currentParent) ||
            !facet.sameStoreInode(installation, currentInstallation) ||
            !facet.sameStoreInode(acquired, currentFile)
          )
            throw new Error('Room sidecar cleanup refuses a foreign file/parent.');
          requireRoomRepoStoreDatabase(facet.store, facet.db);
          await fs.unlink(tmp);
        }
      } catch (error) {
        if (!failed) {
          failed = true;
          cause = error;
        }
      }
    }
  };
  try {
    await checkInstallationRoomMutationTarget(context, tmp);
    if (
      !facet.sameStoreInode(parent, await fs.lstat(dir)) ||
      !facet.sameStoreInode(installation, await fs.lstat(roots.installation))
    )
      throw new Error('Room sidecar parent replaced before acquisition.');
    facet.requireOriginalStoreOperation(facet.store, facet.db, context, sidecar.roomId);
    file = await fs.open(
      tmp,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600
    );
    acquired = await file.stat();
    if (!acquired.isFile()) throw new Error('Room sidecar temporary acquisition is not a file.');
    await checkInstallationRoomMutationTarget(context, tmp);
    await file.writeFile(serialized);
    await checkInstallationRoomMutationTarget(context, tmp);
    await file.sync();
    await checkInstallationRoomMutationTarget(context, tmp);
    if (
      !facet.sameStoreInode(acquired, await file.stat()) ||
      !facet.sameStoreInode(acquired, await fs.lstat(tmp)) ||
      !facet.sameStoreInode(parent, await fs.lstat(dir)) ||
      !facet.sameStoreInode(installation, await fs.lstat(roots.installation))
    )
      throw new Error('Room sidecar publication lost its acquired file/parent.');
    let currentTarget: Stats | undefined;
    try {
      currentTarget = await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
    if (
      (previousTarget === undefined) !== (currentTarget === undefined) ||
      (previousTarget &&
        currentTarget &&
        (!currentTarget.isFile() ||
          currentTarget.isSymbolicLink() ||
          !facet.sameStoreInode(previousTarget, currentTarget)))
    )
      throw new Error('Room sidecar destination replaced before publication.');
    // Repeat parent/acquired identity after the awaited destination observation.
    if (
      !facet.sameStoreInode(parent, await fs.lstat(dir)) ||
      !facet.sameStoreInode(installation, await fs.lstat(roots.installation)) ||
      !facet.sameStoreInode(acquired, await file.stat()) ||
      !facet.sameStoreInode(acquired, await fs.lstat(tmp))
    )
      throw new Error('Room sidecar publication lost its acquired file/parent.');
    facet.requireOriginalStoreOperation(facet.store, facet.db, context, sidecar.roomId);
    // These identity checks refuse observed replacement; pathname rename still has an external race.
    await fs.rename(tmp, target);
    // Record only our acquired inode; a later seed refusal may retract this exact publication.
    facet.publications.set(context, {
      sidecar,
      installation: roots.installation,
      installationStat: installation,
      parent: dir,
      parentStat: parent,
      target,
      acquired,
      previousRow,
      newTarget: previousTarget === undefined,
    });
    await checkInstallationRoomMutationTarget(context, target);
    if (
      !facet.sameStoreInode(acquired, await fs.lstat(target)) ||
      !facet.sameStoreInode(parent, await fs.lstat(dir))
    )
      throw new Error('Room sidecar readback lost its acquired publication.');
    facet.upsertOwned(context, sidecar);
  } catch (error) {
    failed = true;
    cause = error;
  } finally {
    await drainOriginalCleanup();
  }
  if (failed) throw cause;
}
