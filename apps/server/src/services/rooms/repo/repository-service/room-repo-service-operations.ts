/** Original repo operation windows and their complete context retirement order. */
import type {
  RoomMainRepair,
  RoomMainRepairResult,
  EnableRoomRepoResult,
} from './room-repo-service-contracts.js';
import { RoomError } from '../../data/room-errors.js';
import { readOwnedRoomRepoSource } from '../room-repo-store.js';
import {
  withRecognizedInstallationRoomRepo,
  readInstallationRoomRepoMutationContext,
} from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import {
  readDocHttpRoomRepoCaller,
  checkDocHttpRoomRepoCaller,
} from '../../../canvas/doc-channel/http-composition.js';
import { DocChannelNotFoundError } from '../../../canvas/doc-channel/authorization.js';
import { readOriginalRoomRepoServiceView } from '../room-repo-service.js';

/** Execute the original private executeEnable operation after root membership. */
export async function executeEnable(
  engineOwner: object,
  handle: object
): Promise<EnableRoomRepoResult> {
  const facet = readOriginalRoomRepoServiceView(engineOwner);
  const owning = facet.owning;
  if (!owning) throw new DocChannelNotFoundError();
  facet.requireEnabled();
  const caller = readDocHttpRoomRepoCaller(owning.owner, facet.originalService, handle, 'enable');
  await checkDocHttpRoomRepoCaller(handle);
  return withRecognizedInstallationRoomRepo(owning.writer, caller.roomId, async (scope) => {
    const context = readInstallationRoomRepoMutationContext(
      owning.writer,
      caller.roomId,
      scope,
      facet.originalService,
      'enable',
      handle
    );
    facet.operations.set(context, {
      service: facet.originalService,
      handle,
      owning,
      store: facet.deps.store,
      mutex: facet.deps.mutex,
      roomId: caller.roomId,
      operation: 'enable',
    });
    try {
      return await facet.enableUnderLock(caller.roomId, caller.authorId, context);
    } finally {
      facet.operations.delete(context);
    }
  });
}

/** Execute the original private executeRepair operation after root membership. */
export async function executeRepair(
  engineOwner: object,
  handle: object,
  repair: RoomMainRepair
): Promise<RoomMainRepairResult> {
  const facet = readOriginalRoomRepoServiceView(engineOwner);
  const owning = facet.owning;
  if (!owning) throw new DocChannelNotFoundError();
  const caller = readDocHttpRoomRepoCaller(owning.owner, facet.originalService, handle, 'repair');
  const roomId = caller.roomId,
    callerAuthorId = caller.authorId;
  await checkDocHttpRoomRepoCaller(handle);
  if (!facet.deps.enabled()) {
    throw new RoomError(
      'ROOM_REPOS_DISABLED',
      'Rooms cannot have files of their own on this install. Turn that back on in Settings first.'
    );
  }
  // The room first, so a caller who cannot see it learns nothing else; then
  // the operator gate — the same order `enable` takes.
  if (!facet.deps.getRoom(roomId, callerAuthorId)) {
    throw new RoomError('ROOM_NOT_FOUND', 'No such room');
  }
  if (!facet.deps.isOwnerAuthor(callerAuthorId)) {
    throw new RoomError('OPERATOR_ONLY', 'Only you can decide what happens to those changes');
  }
  if (
    readOwnedRoomRepoSource(facet.deps.store, owning.db, roomId).row === null ||
    !(await facet.repoIsInitialised(roomId))
  ) {
    throw new RoomError('ROOM_HAS_NO_REPO', 'This room does not have files of its own.');
  }

  await checkDocHttpRoomRepoCaller(handle);
  facet.requireEnabled();
  return withRecognizedInstallationRoomRepo(owning.writer, roomId, async (scope) => {
    const context = readInstallationRoomRepoMutationContext(
      owning.writer,
      roomId,
      scope,
      facet.originalService,
      'repair',
      handle
    );
    facet.operations.set(context, {
      service: facet.originalService,
      handle,
      owning,
      store: facet.deps.store,
      mutex: facet.deps.mutex,
      roomId,
      operation: 'repair',
    });
    try {
      return await facet.repairUnderLock(roomId, repair, context);
    } finally {
      facet.operations.delete(context);
    }
  });
}
