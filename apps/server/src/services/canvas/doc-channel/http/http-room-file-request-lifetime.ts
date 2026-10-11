import { RoomError } from '../../../rooms/data/room-errors.js';
import type { Request, Response } from 'express';
import {
  InstallationFileWrites,
  requireInstallationFileWritesOwner,
} from '../writes/installation-file-writes.js';
import { resolveCaller } from '../../../../routes/room-caller.js';
import { getRoomService } from '../../../rooms/index.js';
import { recheckAdmittedRequestAuth } from '../../../core/auth/index.js';
import { configManager } from '../../../core/config-manager.js';
import type { RequestUser } from '../../../core/auth/index.js';
import {
  requireRoomServiceFileWriteOwner,
  requireRoomServiceFileWriteCurrent,
} from '../../../rooms/room-service.js';
import {
  requireRoomFileEditorOwner,
  type RoomFileEditor,
} from '../../../rooms/repo/room-file-editor.js';
import { DocChannelNotFoundError } from '../authorization.js';
import { readOriginalHttpRequestCustody } from '../http-composition.js';
import {
  type OriginalHttpFileOwner,
  type OriginalHttpRoomFileCaller,
  RoomFileRequestAuthError,
} from './http-composition-contracts.js';

/** Original request-lifetime helper; private custody recognition precedes its original work. */
export function requireOriginalRoomFileBinding(
  httpCustodyOwner: object,
  owner: InstallationFileWrites,
  binding: OriginalHttpFileOwner
): void {
  const facet = readOriginalHttpRequestCustody(httpCustodyOwner);
  requireInstallationFileWritesOwner(owner, binding.db, binding.store);
  if (
    facet.originalHttpFileOwners.get(owner) !== binding ||
    binding.db.$client !== binding.native ||
    !binding.native.open ||
    binding.native.inTransaction ||
    getRoomService() !== binding.rooms
  )
    throw new DocChannelNotFoundError();
  requireRoomServiceFileWriteOwner(binding.rooms, binding.db, binding.roomStore);
}

/** Original request-lifetime helper; private custody recognition precedes its original work. */
export function sameRoomCredential(
  httpCustodyOwner: object,
  left: RequestUser | undefined | null,
  right: RequestUser | undefined
): boolean {
  readOriginalHttpRequestCustody(httpCustodyOwner);
  return (
    !!left &&
    !!right &&
    left.userId === right.userId &&
    left.credential === right.credential &&
    left.credentialId === right.credentialId
  );
}

/** Original request-lifetime helper; private custody recognition precedes its original work. */
export function roomCallerOf(
  httpCustodyOwner: object,
  owner: InstallationFileWrites,
  roomId: string,
  handle: object
): OriginalHttpRoomFileCaller {
  const facet = readOriginalHttpRequestCustody(httpCustodyOwner);
  const current = facet.originalHttpRoomFileCallers.get(handle),
    binding = facet.originalHttpFileOwners.get(owner);
  if (
    !current?.active ||
    current.owner !== owner ||
    current.roomId !== roomId ||
    current.binding !== binding ||
    !binding ||
    current.editor !== binding.editor
  )
    throw new DocChannelNotFoundError();
  requireRoomFileEditorOwner(current.editor, owner);
  requireOriginalRoomFileBinding(httpCustodyOwner, owner, binding);
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
  // The fixed Room resolver retains non-owner signed-in humans as genuine members.
  const caller = resolveCaller(current.req, current.res);
  if (caller.id !== current.attribution.authorId || caller.kind !== 'human')
    throw new DocChannelNotFoundError();
  requireRoomServiceFileWriteCurrent(binding.rooms, binding.db, roomId, caller.id);
  requireOriginalRoomFileBinding(httpCustodyOwner, owner, binding);
  if (!current.active || facet.originalHttpRoomFileCallers.get(handle) !== current)
    throw new DocChannelNotFoundError();
  return current;
}

/** Existing Room caller resolution and real credential verification; no Doc-owner admission substitution. */
export async function captureDocHttpRoomFileWriteCaller(
  httpCustodyOwner: object,
  owner: InstallationFileWrites,
  req: Request,
  res: Response,
  roomId: string,
  editor: RoomFileEditor
): Promise<object> {
  const facet = readOriginalHttpRequestCustody(httpCustodyOwner);
  const binding = facet.originalHttpFileOwners.get(owner);
  if (
    !binding ||
    binding.closed ||
    !binding.editor ||
    binding.editor !== editor ||
    typeof roomId !== 'string' ||
    roomId.length === 0
  )
    throw new DocChannelNotFoundError();
  requireOriginalRoomFileBinding(httpCustodyOwner, owner, binding);
  const caller = resolveCaller(req, res);
  requireRoomServiceFileWriteCurrent(binding.rooms, binding.db, roomId, caller.id);
  const login = Boolean(configManager.get('auth')?.enabled);
  const suppliedUser = res.locals.user as RequestUser | undefined;
  const user = suppliedUser ? Object.freeze({ ...suppliedUser }) : undefined;
  const headers = Object.freeze({ ...req.headers });
  if (login || user) {
    if (!login || !user || !(await recheckAdmittedRequestAuth(req, suppliedUser)))
      throw new RoomFileRequestAuthError();
  }
  requireOriginalRoomFileBinding(httpCustodyOwner, owner, binding);
  if (binding.closed) throw new DocChannelNotFoundError();
  const handle = Object.freeze({});
  const current: OriginalHttpRoomFileCaller = {
    owner,
    binding,
    roomId,
    editor,
    req,
    res,
    headers,
    login,
    user: user ? Object.freeze({ ...user }) : undefined,
    admittedPrincipal: suppliedUser,
    attribution: Object.freeze({ authorId: caller.id, signedIn: user !== undefined }),
    active: true,
  };
  facet.originalHttpRoomFileCallers.set(handle, current);
  try {
    roomCallerOf(httpCustodyOwner, owner, roomId, handle);
    return handle;
  } catch (error) {
    current.active = false;
    facet.originalHttpRoomFileCallers.delete(handle);
    throw error;
  }
}

/** Fresh refusal-only original credential checks after waits; no request re-admission or quota charge. */
export async function checkDocHttpRoomFileWriteCurrent(
  httpCustodyOwner: object,
  owner: InstallationFileWrites,
  roomId: string,
  handle: object
): Promise<void> {
  readOriginalHttpRequestCustody(httpCustodyOwner);
  const current = roomCallerOf(httpCustodyOwner, owner, roomId, handle);
  if (current.login && !(await recheckAdmittedRequestAuth(current.req, current.admittedPrincipal)))
    throw new RoomFileRequestAuthError();
  roomCallerOf(httpCustodyOwner, owner, roomId, handle);
}

/** Last synchronous actual request-lifetime and native member/person/archive policy guard. */
export function requireDocHttpRoomFileWriteCurrent(
  httpCustodyOwner: object,
  owner: InstallationFileWrites,
  roomId: string,
  handle: object
): undefined {
  readOriginalHttpRequestCustody(httpCustodyOwner);
  roomCallerOf(httpCustodyOwner, owner, roomId, handle);
  return undefined; // Fresh admission closure alone does not revoke an already admitted unchanged caller.
}

/** Read attribution from the installation-owned Room file caller. */
export function readDocHttpRoomFileWriteAttribution(
  httpCustodyOwner: object,
  owner: InstallationFileWrites,
  roomId: string,
  handle: object
): Readonly<{ authorId: string; signedIn: boolean }> {
  readOriginalHttpRequestCustody(httpCustodyOwner);
  return roomCallerOf(httpCustodyOwner, owner, roomId, handle).attribution;
}

/** Finite disclosure-safe response mapping; unknown/raw failures still propagate unchanged. */
export function originalHttpRoomSessionPlacementRefusal(httpCustodyOwner: object, cause: unknown) {
  readOriginalHttpRequestCustody(httpCustodyOwner);
  if (cause instanceof RoomFileRequestAuthError)
    return { status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' };
  if (
    cause instanceof DocChannelNotFoundError ||
    (cause instanceof RoomError && cause.code === 'ROOM_NOT_FOUND')
  )
    return { status: 404, code: 'ROOM_NOT_FOUND', message: 'No such room' };
  if (cause instanceof RoomError && cause.code === 'ROOM_ARCHIVED')
    return { status: 409, code: 'ROOM_ARCHIVED', message: 'This room is archived' };
  return undefined;
}
