import type { Request, Response } from 'express';
import {
  InstallationFileWrites,
  requireInstallationFileWritesOwner,
} from '../writes/installation-file-writes.js';
import { type Db } from '@dorkos/db';
import { type RoomService } from '../../../rooms/room-service.js';
import {
  requireRoomWorktreeManagerOwner,
  type RoomWorktreeManager,
} from '../../../rooms/repo/room-worktree-manager.js';
import { DocChannelNotFoundError } from '../authorization.js';
import { readOriginalHttpRequestCustody } from '../http-composition.js';

/** Exact constructor-captured maintenance owner; this grants no user file permission. */
export function requireOriginalHttpRoomReconcilerOwner(
  httpCustodyOwner: object,
  owner: InstallationFileWrites,
  reconciler: import('../../../rooms/repo/room-repo-reconciler.js').RoomRepoReconciler,
  db: Db,
  rooms: RoomService
): undefined {
  const facet = readOriginalHttpRequestCustody(httpCustodyOwner);
  const binding = facet.originalHttpFileOwners.get(owner);
  if (
    !binding ||
    binding.reconciler !== reconciler ||
    binding.db !== db ||
    binding.rooms !== rooms ||
    binding.native !== db.$client
  )
    throw new DocChannelNotFoundError();
  requireInstallationFileWritesOwner(owner, db, binding.store);
  if (
    facet.originalHttpFileOwners.get(owner) !== binding ||
    !binding.native.open ||
    binding.native.inTransaction
  )
    throw new DocChannelNotFoundError();
  return undefined;
}

/** Require current admission for the installation-owned Room reconciler. */
export function requireOriginalHttpRoomReconcilerAdmission(
  httpCustodyOwner: object,
  owner: InstallationFileWrites,
  reconciler: import('../../../rooms/repo/room-repo-reconciler.js').RoomRepoReconciler,
  db: Db,
  rooms: RoomService
): undefined {
  const facet = readOriginalHttpRequestCustody(httpCustodyOwner);
  requireOriginalHttpRoomReconcilerOwner(httpCustodyOwner, owner, reconciler, db, rooms);
  if (facet.originalHttpFileOwners.get(owner)!.closed) throw new DocChannelNotFoundError();
  return undefined;
}

/** Exact owning assembly identity only; admitted original continuations survive admission closure. */
export function requireOriginalHttpRoomWorktreeOwner(
  httpCustodyOwner: object,
  owner: InstallationFileWrites,
  worktrees: RoomWorktreeManager,
  db: Db,
  rooms: RoomService
): undefined {
  const facet = readOriginalHttpRequestCustody(httpCustodyOwner);
  const binding = facet.originalHttpFileOwners.get(owner);
  if (
    !binding ||
    binding.worktrees !== worktrees ||
    binding.db !== db ||
    binding.rooms !== rooms ||
    binding.native !== db.$client
  )
    throw new DocChannelNotFoundError();
  requireInstallationFileWritesOwner(owner, db, binding.store);
  requireRoomWorktreeManagerOwner(worktrees, owner, db, rooms);
  if (
    facet.originalHttpFileOwners.get(owner) !== binding ||
    !binding.native.open ||
    binding.native.inTransaction
  )
    throw new DocChannelNotFoundError();
  return undefined;
}

/** Require current admission for the installation-owned Room worktree manager. */
export function requireOriginalHttpRoomWorktreeAdmission(
  httpCustodyOwner: object,
  owner: InstallationFileWrites,
  worktrees: RoomWorktreeManager,
  db: Db,
  rooms: RoomService
): undefined {
  const facet = readOriginalHttpRequestCustody(httpCustodyOwner);
  requireOriginalHttpRoomWorktreeOwner(httpCustodyOwner, owner, worktrees, db, rooms);
  if (facet.originalHttpFileOwners.get(owner)!.closed) throw new DocChannelNotFoundError();
  return undefined;
}

/** Resolve the real HTTP caller only through its owning construction; no actor or checker escapes. */
export function captureDocHttpFileWriteCaller(
  httpCustodyOwner: object,
  owner: InstallationFileWrites,
  req: Request,
  res: Response
): object {
  const facet = readOriginalHttpRequestCustody(httpCustodyOwner);
  const binding = facet.originalHttpFileOwners.get(owner);
  if (!binding || binding.closed) throw new DocChannelNotFoundError();
  requireInstallationFileWritesOwner(owner, binding.db, binding.store);
  if (binding.db.$client.inTransaction) throw new DocChannelNotFoundError();
  const actor = binding.actor(req, res);
  if (!binding.principalCurrent(actor.principal) || binding.closed)
    throw new DocChannelNotFoundError();
  requireInstallationFileWritesOwner(owner, binding.db, binding.store);
  if (
    binding.db.$client.inTransaction ||
    binding.closed ||
    facet.originalHttpFileOwners.get(owner) !== binding
  )
    throw new DocChannelNotFoundError();
  const handle = Object.freeze({});
  facet.originalHttpFileCallers.set(handle, { owner, binding, actor, active: true });
  return handle;
}

/** Repeat the SAME private original token/owner policy after waits, never a supplied currentness port. */
export function requireDocHttpFileWriteCurrent(
  httpCustodyOwner: object,
  owner: InstallationFileWrites,
  handle: object
): undefined {
  const facet = readOriginalHttpRequestCustody(httpCustodyOwner);
  const caller = facet.originalHttpFileCallers.get(handle),
    binding = facet.originalHttpFileOwners.get(owner);
  if (!caller || !caller.active || caller.owner !== owner || caller.binding !== binding || !binding)
    throw new DocChannelNotFoundError();
  requireInstallationFileWritesOwner(owner, binding.db, binding.store);
  if (binding.db.$client.inTransaction || !binding.principalCurrent(caller.actor.principal))
    throw new DocChannelNotFoundError();
  // The policy may run observable clocks/owner reads. Retired handles cannot recover through it.
  if (
    !caller.active ||
    facet.originalHttpFileCallers.get(handle) !== caller ||
    facet.originalHttpFileOwners.get(owner) !== binding
  )
    throw new DocChannelNotFoundError();
  requireInstallationFileWritesOwner(owner, binding.db, binding.store);
  if (binding.db.$client.inTransaction) throw new DocChannelNotFoundError();
  return undefined;
}

/** Close only this request's authentic lifetime; no release can alter another owner's caller. */
export function retireDocHttpFileWriteCaller(
  httpCustodyOwner: object,
  owner: InstallationFileWrites,
  handle: object
): undefined {
  const facet = readOriginalHttpRequestCustody(httpCustodyOwner);
  const caller = facet.originalHttpFileCallers.get(handle);
  if (!caller || caller.owner !== owner) throw new DocChannelNotFoundError();
  caller.active = false;
  facet.originalHttpFileCallers.delete(handle);
  return undefined;
}
