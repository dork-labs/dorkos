import { checkOriginalHttpRoomSessionPlacement } from '../../../http-composition.js';
import { readOriginalRoomRunnerLaunch } from '../../../../../rooms/room-turn-runner.js';
import { readOriginalRoomTriggerLaunch } from '../../../../../rooms/room-trigger.js';
import {
  readRoomServiceOriginalFileRequest,
  type RoomService,
} from '../../../../../rooms/room-service.js';
import type { RoomTurnRequest } from '../../../../../rooms/room-turn-port.js';
import type { RoomWorktreeManager } from '../../../../../rooms/repo/room-worktree-manager.js';
import { requireOriginalHttpRoomWorktreeOwner } from '../../../http-composition.js';
import { readOriginalRoomPlacementFacts } from '../../../../../rooms/service/room-core.js';
import type { RoomStore } from '../../../../../rooms/room-store.js';
import path from 'node:path';
import type { Db } from '@dorkos/db';
import {
  readDocHttpRoomRepoCaller,
  requireDocHttpRoomRepoCaller,
  checkDocHttpRoomRepoCaller,
  requireDocHttpRoomFileWriteCurrent,
  checkDocHttpRoomFileWriteCurrent,
} from '../../../http-composition.js';
import {
  requireOriginalRoomNativeMergeCurrent,
  type RoomMergeService,
} from '../../../../../rooms/repo/room-merge-service.js';
import { readRoomRepoConfig } from '../../../../../rooms/repo/room-repo-config.js';
import {
  readOriginalRoomRepoMaintenanceSource,
  type RoomRepoReconciler,
} from '../../../../../rooms/repo/room-repo-reconciler.js';
import { RoomError } from '../../../../../rooms/data/room-errors.js';
import {
  readOwnedRoomRepoSource,
  type RoomRepoStore,
} from '../../../../../rooms/repo/room-repo-store.js';
import type { InstallationRoomWrites } from '../../installation-room-writes.js';
import { readOriginalInstallationRoomMutationPorts } from '../../installation-room-writes.js';
import type { InstallationRoomMutationContext } from './installation-room-custody-types.js';
/** Read the original installation Room mutation context. */
export function readInstallationRoomMutationContext(
  owner: object,
  writer: InstallationRoomWrites,
  roomId: string,
  handle: object
): InstallationRoomMutationContext {
  const ports = readOriginalInstallationRoomMutationPorts(owner);
  const { mutationContexts, requireInstallationRoomNamespaceCurrent } = ports;
  requireInstallationRoomNamespaceCurrent(writer, roomId, handle);
  const context = Object.freeze({});
  mutationContexts.set(context, { writer, roomId, handle });
  return context;
}

/** HTTP variant binds the actual original private caller; no supplied checker or actor DTO. */
export function readInstallationRoomHttpMutationContext(
  owner: object,
  writer: InstallationRoomWrites,
  roomId: string,
  handle: object,
  httpCaller: object
): InstallationRoomMutationContext {
  const ports = readOriginalInstallationRoomMutationPorts(owner);
  const { mutationContexts, scopeOf, requireInstallationRoomNamespaceCurrent } = ports;
  const scope = scopeOf(writer, roomId, handle);
  requireInstallationRoomNamespaceCurrent(writer, roomId, handle);
  requireDocHttpRoomFileWriteCurrent(scope.binding.owner, roomId, httpCaller);
  requireInstallationRoomNamespaceCurrent(writer, roomId, handle);
  const context = Object.freeze({});
  mutationContexts.set(context, { writer, roomId, handle, httpCaller });
  return context;
}

/** Repo variant consumes only a real captured service/request operation; this is still exclusion/data. */
export function readInstallationRoomRepoMutationContext(
  owner: object,
  writer: InstallationRoomWrites,
  roomId: string,
  handle: object,
  service:
    | import('../../../../../rooms/repo/room-repo-service.js').RoomRepoService
    | import('../../../../../rooms/repo/room-merge-service.js').RoomMergeService,
  operation: 'enable' | 'repair' | 'merge',
  repoCaller: object
): InstallationRoomMutationContext {
  const ports = readOriginalInstallationRoomMutationPorts(owner);
  const { mutationContexts, scopeOf, requireInstallationRoomNamespaceCurrent } = ports;
  const scope = scopeOf(writer, roomId, handle);
  requireInstallationRoomNamespaceCurrent(writer, roomId, handle);
  const caller = readDocHttpRoomRepoCaller(scope.binding.owner, service, repoCaller, operation);
  if (caller.roomId !== roomId) throw new Error('Room repo request belongs to another room.');
  requireInstallationRoomNamespaceCurrent(writer, roomId, handle);
  const context = Object.freeze({});
  mutationContexts.set(context, { writer, roomId, handle, repoCaller });
  return context;
}

/** Native variant requires a fixed original Merge operation; the context grants only exclusion/data. */
export function readInstallationRoomNativeMergeMutationContext(
  owner: object,
  writer: InstallationRoomWrites,
  roomId: string,
  handle: object,
  service: RoomMergeService,
  operation: object
): InstallationRoomMutationContext {
  const ports = readOriginalInstallationRoomMutationPorts(owner);
  const { mutationContexts, requireInstallationRoomNamespaceCurrent } = ports;
  requireInstallationRoomNamespaceCurrent(writer, roomId, handle);
  requireOriginalRoomNativeMergeCurrent(service, operation, roomId);
  requireInstallationRoomNamespaceCurrent(writer, roomId, handle);
  const context = Object.freeze({});
  mutationContexts.set(context, { writer, roomId, handle, nativeMerge: { service, operation } });
  return context;
}

/** Original dispatcher placement proof is separate from exclusion/data; no caller-owned checker. */
export function readInstallationRoomPlacementMutationContext(
  owner: object,
  writer: InstallationRoomWrites,
  roomId: string,
  handle: object,
  placement: object,
  store: RoomStore
): InstallationRoomMutationContext {
  const ports = readOriginalInstallationRoomMutationPorts(owner);
  const { mutationContexts, scopeOf, requireInstallationRoomNamespaceCurrent } = ports;
  const scope = scopeOf(writer, roomId, handle);
  requireInstallationRoomNamespaceCurrent(writer, roomId, handle);
  const facts = readOriginalRoomPlacementFacts(placement, scope.binding.db, store);
  if (!facts || facts.roomId !== roomId || scope.source.row?.mode !== 'owned')
    throw new Error('Room placement lost its original construction/current facts.');
  requireInstallationRoomNamespaceCurrent(writer, roomId, handle);
  const context = Object.freeze({});
  mutationContexts.set(context, {
    writer,
    roomId,
    handle,
    placement: { token: placement, store, facts: JSON.stringify(facts) },
  });
  return context;
}

/** Genuine original Runner launch is a separate permission origin; the scope still supplies exclusion/data only. */
export function readInstallationRoomLaunchMutationContext(
  owner: object,
  writer: InstallationRoomWrites,
  roomId: string,
  handle: object,
  request: RoomTurnRequest,
  manager: RoomWorktreeManager,
  rooms: RoomService,
  store: RoomStore
): InstallationRoomMutationContext {
  const ports = readOriginalInstallationRoomMutationPorts(owner);
  const { mutationContexts, scopeOf, requireInstallationRoomNamespaceCurrent } = ports;
  const scope = scopeOf(writer, roomId, handle);
  requireInstallationRoomNamespaceCurrent(writer, roomId, handle);
  const launch = readOriginalRoomRunnerLaunch(request);
  const input = launch && readOriginalRoomTriggerLaunch(request, launch.runner);
  const facts =
    launch &&
    readRoomServiceOriginalFileRequest(rooms, scope.binding.db, store, request, launch.runner);
  if (
    !launch ||
    !input ||
    !facts ||
    input.manager !== manager ||
    input.roomId !== roomId ||
    facts.roomId !== roomId ||
    scope.source.row?.mode !== 'owned'
  )
    throw new Error('Room launch lacks its original owning request/native source.');
  requireOriginalHttpRoomWorktreeOwner(scope.binding.owner, manager, scope.binding.db, rooms);
  const context = Object.freeze({});
  mutationContexts.set(context, {
    writer,
    roomId,
    handle,
    launch: {
      request,
      manager,
      rooms,
      store,
      facts: JSON.stringify(facts),
      sessionId: launch.sessionId,
    },
  });
  contextOf(owner, context);
  return context;
}

/** Original internal maintenance origin is constructor/HTTP bound, not user permission. */
export function readInstallationRoomMaintenanceMutationContext(
  owner: object,
  writer: InstallationRoomWrites,
  roomId: string,
  handle: object,
  reconciler: RoomRepoReconciler,
  operation: object
): InstallationRoomMutationContext {
  const ports = readOriginalInstallationRoomMutationPorts(owner);
  const { mutationContexts, requireInstallationRoomNamespaceCurrent } = ports;
  requireInstallationRoomNamespaceCurrent(writer, roomId, handle);
  readOriginalRoomRepoMaintenanceSource(operation, reconciler, writer, roomId);
  requireInstallationRoomNamespaceCurrent(writer, roomId, handle);
  const context = Object.freeze({});
  mutationContexts.set(context, { writer, roomId, handle, maintenance: { reconciler, operation } });
  return context;
}

function contextOf(owner: object, context: InstallationRoomMutationContext) {
  const ports = readOriginalInstallationRoomMutationPorts(owner);
  const { mutationContexts, scopeOf, requireInstallationRoomNamespaceCurrent } = ports;
  const actual = mutationContexts.get(context);
  if (!actual) throw new Error('Unknown room mutation context.');
  if (!actual.maintenance && !readRoomRepoConfig().enabled)
    throw new RoomError(
      'ROOM_REPOS_DISABLED',
      'Rooms cannot have files of their own on this install. Turn that back on in Settings first.'
    );
  requireInstallationRoomNamespaceCurrent(actual.writer, actual.roomId, actual.handle);
  if (actual.maintenance) {
    readOriginalRoomRepoMaintenanceSource(
      actual.maintenance.operation,
      actual.maintenance.reconciler,
      actual.writer,
      actual.roomId
    );
    requireInstallationRoomNamespaceCurrent(actual.writer, actual.roomId, actual.handle);
  }
  if (actual.httpCaller) {
    const scope = scopeOf(actual.writer, actual.roomId, actual.handle);
    requireDocHttpRoomFileWriteCurrent(scope.binding.owner, actual.roomId, actual.httpCaller);
    requireInstallationRoomNamespaceCurrent(actual.writer, actual.roomId, actual.handle);
  }
  if (actual.repoCaller) {
    requireDocHttpRoomRepoCaller(actual.repoCaller);
    requireInstallationRoomNamespaceCurrent(actual.writer, actual.roomId, actual.handle);
  }
  if (actual.nativeMerge) {
    requireOriginalRoomNativeMergeCurrent(
      actual.nativeMerge.service,
      actual.nativeMerge.operation,
      actual.roomId
    );
    requireInstallationRoomNamespaceCurrent(actual.writer, actual.roomId, actual.handle);
  }
  if (actual.placement) {
    const scope = scopeOf(actual.writer, actual.roomId, actual.handle);
    const facts = readOriginalRoomPlacementFacts(
      actual.placement.token,
      scope.binding.db,
      actual.placement.store
    );
    const source = readOwnedRoomRepoSource(scope.binding.repos, scope.binding.db, actual.roomId);
    if (
      !facts ||
      facts.roomId !== actual.roomId ||
      JSON.stringify(facts) !== actual.placement.facts ||
      source.row?.mode !== 'owned' ||
      JSON.stringify(source.row) !== JSON.stringify(scope.source.row)
    )
      throw new Error('Room placement is foreign, changed or retired.');
    requireInstallationRoomNamespaceCurrent(actual.writer, actual.roomId, actual.handle);
  }
  if (actual.launch) {
    const scope = scopeOf(actual.writer, actual.roomId, actual.handle),
      origin = actual.launch;
    const launch = readOriginalRoomRunnerLaunch(origin.request);
    const input = launch && readOriginalRoomTriggerLaunch(origin.request, launch.runner);
    const facts =
      launch &&
      readRoomServiceOriginalFileRequest(
        origin.rooms,
        scope.binding.db,
        origin.store,
        origin.request,
        launch.runner
      );
    const source = readOwnedRoomRepoSource(scope.binding.repos, scope.binding.db, actual.roomId);
    if (
      !launch ||
      !input ||
      !facts ||
      launch.sessionId !== origin.sessionId ||
      input.manager !== origin.manager ||
      input.roomId !== actual.roomId ||
      JSON.stringify(facts) !== origin.facts ||
      JSON.stringify(source.row) !== JSON.stringify(scope.source.row) ||
      source.row?.mode !== 'owned'
    )
      throw new Error('Room launch original request/member/session/source changed or retired.');
    requireOriginalHttpRoomWorktreeOwner(
      scope.binding.owner,
      origin.manager,
      scope.binding.db,
      origin.rooms
    );
    requireInstallationRoomNamespaceCurrent(actual.writer, actual.roomId, actual.handle);
  }
  return actual;
}

/** Finite original launch target recognition. A namespace-only context supplies no retirement permission. */
export function requireInstallationRoomLaunchTarget(
  owner: object,
  context: InstallationRoomMutationContext,
  manager: RoomWorktreeManager,
  roomId: string,
  worktree: string,
  agentPath: string
): undefined {
  readOriginalInstallationRoomMutationPorts(owner);
  const actual = contextOf(owner, context),
    origin = actual.launch;
  const launch = origin && readOriginalRoomRunnerLaunch(origin.request);
  const input = launch && readOriginalRoomTriggerLaunch(origin!.request, launch.runner);
  if (
    !origin ||
    !input ||
    origin.manager !== manager ||
    actual.roomId !== roomId ||
    input.worktree !== worktree ||
    input.agentPath !== agentPath
  )
    throw new Error('Room retirement lacks its original captured launch target.');
  requireInstallationRoomMutationTarget(owner, context, worktree);
  return undefined;
}

/** Read roots retained by the original installation Room mutation context. */
export function readInstallationRoomMutationRoots(
  owner: object,
  context: InstallationRoomMutationContext
): Readonly<{ homePath: string; repoPath: string }> {
  const ports = readOriginalInstallationRoomMutationPorts(owner);
  const { scopeOf } = ports;
  const actual = contextOf(owner, context),
    scope = scopeOf(actual.writer, actual.roomId, actual.handle);
  return Object.freeze({ homePath: scope.source.home, repoPath: scope.source.repo });
}

/** Read roots from the original installation Room store. */
export function readInstallationRoomStoreRoots(
  owner: object,
  context: InstallationRoomMutationContext,
  repos: RoomRepoStore,
  db: Db
): Readonly<{ root: string; home: string; installation: string; canonicalInstallation: string }> {
  const ports = readOriginalInstallationRoomMutationPorts(owner);
  const { scopeOf } = ports;
  const actual = contextOf(owner, context),
    scope = scopeOf(actual.writer, actual.roomId, actual.handle);
  if (scope.binding.repos !== repos || scope.binding.db !== db)
    throw new Error('Room Store roots require their exact original source.');
  return Object.freeze({
    root: scope.source.root,
    home: scope.source.home,
    installation: path.dirname(scope.source.root),
    canonicalInstallation: scope.owned.roots[0]!.canonicalPath,
  });
}

/** Last synchronous fence/native/lease/lexical-target guard. Existing canonical/symlink guards still apply. */
export function requireInstallationRoomMutationTarget(
  owner: object,
  context: InstallationRoomMutationContext,
  target: string
): undefined {
  const ports = readOriginalInstallationRoomMutationPorts(owner);
  const { scopeOf, within, requireInstallationRoomNamespaceCurrent } = ports;
  const actual = contextOf(owner, context),
    scope = scopeOf(actual.writer, actual.roomId, actual.handle);
  if (
    typeof target !== 'string' ||
    !path.isAbsolute(target) ||
    !within(scope.source.home, path.resolve(target))
  )
    throw new Error('Room mutation target escaped the actual owning home.');
  requireInstallationRoomNamespaceCurrent(actual.writer, actual.roomId, actual.handle);
  return undefined;
}

/** Check the current target of the original installation Room mutation. */
export async function checkInstallationRoomMutationTarget(
  owner: object,
  context: InstallationRoomMutationContext,
  target: string
): Promise<void> {
  const ports = readOriginalInstallationRoomMutationPorts(owner);
  const { scopeOf, checkInstallationRoomScope } = ports;
  const actual = contextOf(owner, context);
  await checkInstallationRoomScope(actual.writer, actual.roomId, actual.handle);
  if (actual.httpCaller) {
    const scope = scopeOf(actual.writer, actual.roomId, actual.handle);
    await checkDocHttpRoomFileWriteCurrent(scope.binding.owner, actual.roomId, actual.httpCaller);
  }
  if (actual.repoCaller) await checkDocHttpRoomRepoCaller(actual.repoCaller);
  if (actual.placement) await checkOriginalHttpRoomSessionPlacement(actual.placement.token);
  requireInstallationRoomMutationTarget(owner, context, target);
}

/** Fixed staging data from the actual original installation, not caller input or permission. */
export function readInstallationRoomUploadStagingRoot(
  owner: object,
  context: InstallationRoomMutationContext
): Readonly<{ root: string; canonicalInstallation: string }> {
  const ports = readOriginalInstallationRoomMutationPorts(owner);
  const { scopeOf } = ports;
  const actual = contextOf(owner, context),
    scope = scopeOf(actual.writer, actual.roomId, actual.handle);
  return Object.freeze({
    root: path.join(path.dirname(scope.source.root), '.temp', 'room-uploads'),
    canonicalInstallation: scope.owned.roots[0]!.canonicalPath,
  });
}
