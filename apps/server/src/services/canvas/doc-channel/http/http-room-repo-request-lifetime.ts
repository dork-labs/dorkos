import type { Request, Response } from 'express';
import { InstallationFileWrites } from '../writes/installation-file-writes.js';
import { resolveCaller } from '../../../../routes/room-caller.js';
import { recheckAdmittedRequestAuth } from '../../../core/auth/index.js';
import { configManager } from '../../../core/config-manager.js';
import type { RequestUser } from '../../../core/auth/index.js';
import { requireRoomServiceRepoWriteCurrent } from '../../../rooms/room-service.js';
import {
  requireRoomRepoServiceOwner,
  type RoomRepoService,
} from '../../../rooms/repo/room-repo-service.js';
import {
  requireRoomMergeServiceOwner,
  type RoomMergeService,
} from '../../../rooms/repo/room-merge-service.js';
import { DocChannelNotFoundError } from '../authorization.js';
import { readOriginalHttpRequestCustody } from '../http-composition.js';
import {
  type OriginalHttpFileOwner,
  type OriginalHttpRoomRepoCaller,
  type RoomRepoOperation,
  RoomFileRequestAuthError,
} from './http-composition-contracts.js';
import {
  requireOriginalRoomFileBinding,
  sameRoomCredential,
} from './http-room-file-request-lifetime.js';

/** Original request-lifetime helper; private custody recognition precedes its original work. */
export function requireOriginalRepoService(
  httpCustodyOwner: object,
  binding: OriginalHttpFileOwner,
  owner: InstallationFileWrites,
  service: RoomRepoService | RoomMergeService,
  operation: RoomRepoOperation
): void {
  readOriginalHttpRequestCustody(httpCustodyOwner);
  if (operation === 'merge') {
    if (!binding.mergeService || service !== binding.mergeService)
      throw new DocChannelNotFoundError();
    requireRoomMergeServiceOwner(binding.mergeService, owner, binding.db, binding.rooms);
  } else {
    if (!binding.repoService || service !== binding.repoService)
      throw new DocChannelNotFoundError();
    requireRoomRepoServiceOwner(binding.repoService, owner, binding.db, binding.rooms);
  }
}

/** Original request-lifetime helper; private custody recognition precedes its original work. */
export function repoCallerOf(httpCustodyOwner: object, handle: object): OriginalHttpRoomRepoCaller {
  const facet = readOriginalHttpRequestCustody(httpCustodyOwner);
  const current = facet.originalHttpRoomRepoCallers.get(handle);
  if (!current?.active || facet.originalHttpFileOwners.get(current.owner) !== current.binding)
    throw new DocChannelNotFoundError();
  const { binding, owner } = current;
  requireOriginalRoomFileBinding(httpCustodyOwner, owner, binding);
  requireOriginalRepoService(httpCustodyOwner, binding, owner, current.service, current.operation);
  if (
    current.req.aborted ||
    Boolean(configManager.get('auth')?.enabled) !== current.login ||
    current.req.headers.cookie !== current.headers.cookie ||
    current.req.headers.authorization !== current.headers.authorization ||
    current.req.headers['x-dorkos-agent'] !== current.headers['x-dorkos-agent']
  )
    throw new DocChannelNotFoundError();
  const user = current.res.locals.user as RequestUser | undefined;
  if (
    (current.login && user !== current.admittedPrincipal) ||
    (current.user ? !sameRoomCredential(httpCustodyOwner, user, current.user) : user !== undefined)
  )
    throw new DocChannelNotFoundError();
  const actor = resolveCaller(current.req, current.res);
  if (actor.id !== current.authorId) throw new DocChannelNotFoundError();
  requireRoomServiceRepoWriteCurrent(
    binding.rooms,
    binding.db,
    current.roomId,
    actor.id,
    current.operation
  );
  requireOriginalRoomFileBinding(httpCustodyOwner, owner, binding);
  requireOriginalRepoService(httpCustodyOwner, binding, owner, current.service, current.operation);
  if (!current.active || facet.originalHttpRoomRepoCallers.get(handle) !== current)
    throw new DocChannelNotFoundError();
  return current;
}

/** Only the captured original HTTP service and real request can open this finite operation. */
export async function captureDocHttpRoomRepoCaller(
  httpCustodyOwner: object,
  owner: InstallationFileWrites,
  service: RoomRepoService | RoomMergeService,
  req: Request,
  res: Response,
  roomId: string,
  operation: RoomRepoOperation
): Promise<object> {
  const facet = readOriginalHttpRequestCustody(httpCustodyOwner);
  const binding = facet.originalHttpFileOwners.get(owner);
  if (
    !binding ||
    binding.closed ||
    typeof roomId !== 'string' ||
    !roomId ||
    !['enable', 'repair', 'merge'].includes(operation)
  )
    throw new DocChannelNotFoundError();
  requireOriginalRoomFileBinding(httpCustodyOwner, owner, binding);
  requireOriginalRepoService(httpCustodyOwner, binding, owner, service, operation);
  const caller = resolveCaller(req, res);
  requireRoomServiceRepoWriteCurrent(binding.rooms, binding.db, roomId, caller.id, operation);
  const login = Boolean(configManager.get('auth')?.enabled);
  const supplied = res.locals.user as RequestUser | undefined;
  const user = supplied ? Object.freeze({ ...supplied }) : undefined;
  const headers = Object.freeze({ ...req.headers });
  if (login || user) {
    if (!login || !user || !(await recheckAdmittedRequestAuth(req, supplied)))
      throw new RoomFileRequestAuthError();
  }
  requireOriginalRoomFileBinding(httpCustodyOwner, owner, binding);
  requireOriginalRepoService(httpCustodyOwner, binding, owner, service, operation);
  if (binding.closed) throw new DocChannelNotFoundError();
  const handle = Object.freeze({});
  const current: OriginalHttpRoomRepoCaller = {
    owner,
    binding,
    service,
    req,
    res,
    headers,
    user,
    admittedPrincipal: supplied,
    login,
    roomId,
    operation,
    authorId: caller.id,
    active: true,
  };
  facet.originalHttpRoomRepoCallers.set(handle, current);
  try {
    repoCallerOf(httpCustodyOwner, handle);
    return handle;
  } catch (error) {
    current.active = false;
    facet.originalHttpRoomRepoCallers.delete(handle);
    throw error;
  }
}

/** Recheck credentials and currentness of the original Room repository caller. */
export async function checkDocHttpRoomRepoCaller(
  httpCustodyOwner: object,
  handle: object
): Promise<void> {
  readOriginalHttpRequestCustody(httpCustodyOwner);
  const current = repoCallerOf(httpCustodyOwner, handle);
  if (current.login && !(await recheckAdmittedRequestAuth(current.req, current.admittedPrincipal)))
    throw new RoomFileRequestAuthError();
  repoCallerOf(httpCustodyOwner, handle);
}

/** Require currentness of the original Room repository caller. */
export function requireDocHttpRoomRepoCaller(httpCustodyOwner: object, handle: object): undefined {
  readOriginalHttpRequestCustody(httpCustodyOwner);
  repoCallerOf(httpCustodyOwner, handle);
  return undefined;
}

/** Finite operation attribution; the public arguments must match the private construction. */
export function readDocHttpRoomRepoCaller(
  httpCustodyOwner: object,
  owner: InstallationFileWrites,
  service: RoomRepoService | RoomMergeService,
  handle: object,
  operation: RoomRepoOperation
): Readonly<{ roomId: string; authorId: string }> {
  readOriginalHttpRequestCustody(httpCustodyOwner);
  const current = repoCallerOf(httpCustodyOwner, handle);
  if (current.owner !== owner || current.service !== service || current.operation !== operation)
    throw new DocChannelNotFoundError();
  return Object.freeze({ roomId: current.roomId, authorId: current.authorId });
}

/** Retire the captured original Room repository caller. */
export async function retireDocHttpRoomRepoCaller(
  httpCustodyOwner: object,
  handle: object
): Promise<void> {
  const facet = readOriginalHttpRequestCustody(httpCustodyOwner);
  const current = facet.originalHttpRoomRepoCallers.get(handle);
  if (!current) throw new DocChannelNotFoundError();
  current.active = false;
  facet.originalHttpRoomRepoCallers.delete(handle);
}
