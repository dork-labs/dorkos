import { RoomError } from '../../rooms/data/room-errors.js';
import {
  prepareServiceOriginalDocumentSave,
  completeServiceOriginalDocumentSave,
} from './service.js';
import type { ConnectorRuntimePrincipalService } from '../../connectors/principal/runtime-principal-service.js';
/** Production HTTP composition over the existing canvas, room, owner and approval services. */
import fs from 'node:fs';
import type { Request, Response } from 'express';
import {
  InstallationFileWrites,
  requireInstallationFileWritesOwner,
  requireInstallationFileWritesAdmission,
  stopInstallationFileWrites,
  readInstallationHttpFileWrites,
} from './writes/installation-file-writes.js';
import { NormalFileSaveService } from './writes/normal-file-save.js';
import type { InstallationHttpFileWrites } from './writes/installation-http-file-writes.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  agents,
  agentIdentityTokens,
  authors,
  sessionMetadata,
  roomSessions,
  roomSessionRetirements,
  roomMembers,
  and,
  eq,
  isNull,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import type { DocChannelHttp } from '../../../routes/canvas-doc-events.js';
import { resolveCaller } from '../../../routes/room-caller.js';
import { getRoomService } from '../../rooms/index.js';
import { verifyRequestAuth } from '../../core/auth/index.js';
import { configManager } from '../../core/config-manager.js';
import { getRequestAgentIdentity } from '../../../middleware/agent-identity.js';
import { isContained } from '../../../lib/boundary.js';
import type { RequestUser } from '../../core/auth/index.js';
import {
  TOKEN_ABSOLUTE_TTL_MS,
  TOKEN_IDLE_TTL_MS,
} from '../../core/agent-identity/agent-identity-service.js';
import type { ApprovalService } from '../../core/approvals/approval-service.js';
import {
  createServerPrincipal,
  isServerPrincipal,
  type ServerPrincipalProof,
  type ServerPrincipalClaims,
} from '../../connectors/principal/server-principal.js';
import { queueKeyOf } from '../../session/session-key-registry.js';
import {
  requireRoomServiceRepoWriteCurrent,
  requireRoomServiceFileWriteOwner,
  requireRoomServiceFileWriteCurrent,
  type RoomService,
} from '../../rooms/room-service.js';
import {
  requireRoomFileEditorOwner,
  type RoomFileEditor,
} from '../../rooms/repo/room-file-editor.js';
import {
  requireRoomRepoServiceOwner,
  type RoomRepoService,
} from '../../rooms/repo/room-repo-service.js';
import {
  requireRoomMergeServiceOwner,
  type RoomMergeService,
} from '../../rooms/repo/room-merge-service.js';
import {
  requireRoomWorktreeManagerOwner,
  type RoomWorktreeManager,
} from '../../rooms/repo/room-worktree-manager.js';
import type { RoomStore } from '../../rooms/room-store.js';
import type { RoomSessionPlacePort } from '../../workspace/room-session-place.js';
import { resolveRoomTurnPlace, sessionStandsInRoomCopy } from '../../rooms/repo/room-turn-place.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import type { RoomRepoStore } from '../../rooms/repo/room-repo-store.js';
import type { CanvasDocumentStore } from '../canvas-document-store.js';
import { parseScope } from '../scopes.js';
import { DocChannelDownstream } from './downstream/service.js';
import { createDocDownstreamAuthority } from './downstream/authority.js';
import {
  DocChannelAuthorization,
  DocChannelNotFoundError,
  requireOriginalCurrentDocAccess,
  type DocChannelActor,
} from './authorization.js';
import { DocChannelStore, requireDocChannelStoreDatabase } from './store.js';
import { DocChannelService } from './service.js';
import { DocCheckboxAuthority } from './writes/authority.js';
import type { DocCheckboxWriteService } from './writes/checkbox-service.js';
import {
  createInstallationOriginalCheckboxWriter,
  stopInstallationOriginalCheckboxWriter,
  createInstallationOriginalCheckboxGrantPreparation,
  createInstallationOriginalRoomDownstream,
} from './writes/installation-file-writes.js';
import { DocChannelGrants, type DocGrantResult } from './grants.js';
import {
  grantOriginalCheckboxRoute,
  resolveOriginalCheckboxGrantBinding,
  type OriginalCheckboxGrantPreparation,
} from './writes/checkbox-grant-preparation.js';
import { DocChannelIngest } from './ingest.js';
import { DocRouteGrantError, type DocGrantAuthority } from './grant-policy.js';

import {
  docInstallationOwner,
  sameDocOwnerAuthority,
  readDocSourceDescriptor,
} from './current/doc-source-policy.js';
export {
  docInstallationOwner,
  sameDocOwnerAuthority,
  readDocSourceDescriptor,
} from './current/doc-source-policy.js';
export type { DocSourceDescriptor, DocSourceDependencies } from './current/doc-source-policy.js';

import { requireRoomRepoReconcilerOwner } from '../../rooms/repo/room-repo-reconciler.js';

interface OriginalHttpFileOwner {
  service?: DocChannelService;
  reconciler?: import('../../rooms/repo/room-repo-reconciler.js').RoomRepoReconciler;
  editor?: RoomFileEditor;
  repoService?: RoomRepoService;
  mergeService?: RoomMergeService;
  worktrees?: RoomWorktreeManager;
  rooms: RoomService;
  roomStore: RoomStore;
  native: Db['$client'];
  db: Db;
  store: DocChannelStore;
  actor: DocChannelHttp['actor'];
  principalCurrent: (proof: ServerPrincipalProof) => boolean;
  closed: boolean;
}
const originalHttpFileOwners = new WeakMap<object, OriginalHttpFileOwner>();
/** Exact constructor-captured maintenance owner; this grants no user file permission. */
export function requireOriginalHttpRoomReconcilerOwner(
  owner: InstallationFileWrites,
  reconciler: import('../../rooms/repo/room-repo-reconciler.js').RoomRepoReconciler,
  db: Db,
  rooms: RoomService
): undefined {
  const binding = originalHttpFileOwners.get(owner);
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
    originalHttpFileOwners.get(owner) !== binding ||
    !binding.native.open ||
    binding.native.inTransaction
  )
    throw new DocChannelNotFoundError();
  return undefined;
}
/** Require current admission for the installation-owned Room reconciler. */
export function requireOriginalHttpRoomReconcilerAdmission(
  owner: InstallationFileWrites,
  reconciler: import('../../rooms/repo/room-repo-reconciler.js').RoomRepoReconciler,
  db: Db,
  rooms: RoomService
): undefined {
  requireOriginalHttpRoomReconcilerOwner(owner, reconciler, db, rooms);
  if (originalHttpFileOwners.get(owner)!.closed) throw new DocChannelNotFoundError();
  return undefined;
}
/** Exact owning assembly identity only; admitted original continuations survive admission closure. */
export function requireOriginalHttpRoomWorktreeOwner(
  owner: InstallationFileWrites,
  worktrees: RoomWorktreeManager,
  db: Db,
  rooms: RoomService
): undefined {
  const binding = originalHttpFileOwners.get(owner);
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
    originalHttpFileOwners.get(owner) !== binding ||
    !binding.native.open ||
    binding.native.inTransaction
  )
    throw new DocChannelNotFoundError();
  return undefined;
}
/** Require current admission for the installation-owned Room worktree manager. */
export function requireOriginalHttpRoomWorktreeAdmission(
  owner: InstallationFileWrites,
  worktrees: RoomWorktreeManager,
  db: Db,
  rooms: RoomService
): undefined {
  requireOriginalHttpRoomWorktreeOwner(owner, worktrees, db, rooms);
  if (originalHttpFileOwners.get(owner)!.closed) throw new DocChannelNotFoundError();
  return undefined;
}
const originalHttpFileCallers = new WeakMap<
  object,
  {
    owner: InstallationFileWrites;
    binding: OriginalHttpFileOwner;
    actor: ReturnType<DocChannelHttp['actor']>;
    active: boolean;
  }
>();
/** Resolve the real HTTP caller only through its owning construction; no actor or checker escapes. */
export function captureDocHttpFileWriteCaller(
  owner: InstallationFileWrites,
  req: Request,
  res: Response
): object {
  const binding = originalHttpFileOwners.get(owner);
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
    originalHttpFileOwners.get(owner) !== binding
  )
    throw new DocChannelNotFoundError();
  const handle = Object.freeze({});
  originalHttpFileCallers.set(handle, { owner, binding, actor, active: true });
  return handle;
}
/** Repeat the SAME private original token/owner policy after waits, never a supplied currentness port. */
export function requireDocHttpFileWriteCurrent(
  owner: InstallationFileWrites,
  handle: object
): undefined {
  const caller = originalHttpFileCallers.get(handle),
    binding = originalHttpFileOwners.get(owner);
  if (!caller || !caller.active || caller.owner !== owner || caller.binding !== binding || !binding)
    throw new DocChannelNotFoundError();
  requireInstallationFileWritesOwner(owner, binding.db, binding.store);
  if (binding.db.$client.inTransaction || !binding.principalCurrent(caller.actor.principal))
    throw new DocChannelNotFoundError();
  // The policy may run observable clocks/owner reads. Retired handles cannot recover through it.
  if (
    !caller.active ||
    originalHttpFileCallers.get(handle) !== caller ||
    originalHttpFileOwners.get(owner) !== binding
  )
    throw new DocChannelNotFoundError();
  requireInstallationFileWritesOwner(owner, binding.db, binding.store);
  if (binding.db.$client.inTransaction) throw new DocChannelNotFoundError();
  return undefined;
}
/** Close only this request's authentic lifetime; no release can alter another owner's caller. */
export function retireDocHttpFileWriteCaller(
  owner: InstallationFileWrites,
  handle: object
): undefined {
  const caller = originalHttpFileCallers.get(handle);
  if (!caller || caller.owner !== owner) throw new DocChannelNotFoundError();
  caller.active = false;
  originalHttpFileCallers.delete(handle);
  return undefined;
}

/** Report refusal of the original Room file request credentials. */
export class RoomFileRequestAuthError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'RoomFileRequestAuthError';
  }
}
interface OriginalHttpRoomFileCaller {
  owner: InstallationFileWrites;
  binding: OriginalHttpFileOwner;
  roomId: string;
  editor: RoomFileEditor;
  req: Request;
  res: Response;
  headers: Readonly<Request['headers']>;
  login: boolean;
  user?: Readonly<RequestUser>;
  attribution: Readonly<{ authorId: string; signedIn: boolean }>;
  active: boolean;
}
const originalHttpRoomFileCallers = new WeakMap<object, OriginalHttpRoomFileCaller>();
function requireOriginalRoomFileBinding(
  owner: InstallationFileWrites,
  binding: OriginalHttpFileOwner
): void {
  requireInstallationFileWritesOwner(owner, binding.db, binding.store);
  if (
    originalHttpFileOwners.get(owner) !== binding ||
    binding.db.$client !== binding.native ||
    !binding.native.open ||
    binding.native.inTransaction ||
    getRoomService() !== binding.rooms
  )
    throw new DocChannelNotFoundError();
  requireRoomServiceFileWriteOwner(binding.rooms, binding.db, binding.roomStore);
}
function sameRoomCredential(
  left: RequestUser | undefined | null,
  right: RequestUser | undefined
): boolean {
  return (
    !!left &&
    !!right &&
    left.userId === right.userId &&
    left.credential === right.credential &&
    left.credentialId === right.credentialId
  );
}
function roomCallerOf(
  owner: InstallationFileWrites,
  roomId: string,
  handle: object
): OriginalHttpRoomFileCaller {
  const current = originalHttpRoomFileCallers.get(handle),
    binding = originalHttpFileOwners.get(owner);
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
  requireOriginalRoomFileBinding(owner, binding);
  if (
    current.req.aborted ||
    Boolean(configManager.get('auth')?.enabled) !== current.login ||
    current.req.headers.cookie !== current.headers.cookie ||
    current.req.headers.authorization !== current.headers.authorization ||
    current.req.headers['x-dorkos-agent'] !== current.headers['x-dorkos-agent']
  )
    throw new DocChannelNotFoundError();
  const user = current.res.locals.user as RequestUser | undefined;
  if (current.user ? !sameRoomCredential(user, current.user) : user !== undefined)
    throw new DocChannelNotFoundError();
  // The fixed Room resolver retains non-owner signed-in humans as genuine members.
  const caller = resolveCaller(current.req, current.res);
  if (caller.id !== current.attribution.authorId || caller.kind !== 'human')
    throw new DocChannelNotFoundError();
  requireRoomServiceFileWriteCurrent(binding.rooms, binding.db, roomId, caller.id);
  requireOriginalRoomFileBinding(owner, binding);
  if (!current.active || originalHttpRoomFileCallers.get(handle) !== current)
    throw new DocChannelNotFoundError();
  return current;
}
/** Existing Room caller resolution and real credential verification; no Doc-owner admission substitution. */
export async function captureDocHttpRoomFileWriteCaller(
  owner: InstallationFileWrites,
  req: Request,
  res: Response,
  roomId: string,
  editor: RoomFileEditor
): Promise<object> {
  const binding = originalHttpFileOwners.get(owner);
  if (
    !binding ||
    binding.closed ||
    !binding.editor ||
    binding.editor !== editor ||
    typeof roomId !== 'string' ||
    roomId.length === 0
  )
    throw new DocChannelNotFoundError();
  requireOriginalRoomFileBinding(owner, binding);
  const caller = resolveCaller(req, res);
  requireRoomServiceFileWriteCurrent(binding.rooms, binding.db, roomId, caller.id);
  const login = Boolean(configManager.get('auth')?.enabled);
  const suppliedUser = res.locals.user as RequestUser | undefined;
  const user = suppliedUser ? Object.freeze({ ...suppliedUser }) : undefined;
  const headers = Object.freeze({ ...req.headers });
  if (login || user) {
    if (!login || !user || !sameRoomCredential(await verifyRequestAuth({ headers }), user))
      throw new RoomFileRequestAuthError();
  }
  requireOriginalRoomFileBinding(owner, binding);
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
    attribution: Object.freeze({ authorId: caller.id, signedIn: user !== undefined }),
    active: true,
  };
  originalHttpRoomFileCallers.set(handle, current);
  try {
    roomCallerOf(owner, roomId, handle);
    return handle;
  } catch (error) {
    current.active = false;
    originalHttpRoomFileCallers.delete(handle);
    throw error;
  }
}
/** Actual asynchronous cookie/API-key verification repeated after waits; its unavoidable check/effect race remains. */
export async function checkDocHttpRoomFileWriteCurrent(
  owner: InstallationFileWrites,
  roomId: string,
  handle: object
): Promise<void> {
  const current = roomCallerOf(owner, roomId, handle);
  if (
    current.login &&
    !sameRoomCredential(await verifyRequestAuth({ headers: current.headers }), current.user)
  )
    throw new RoomFileRequestAuthError();
  roomCallerOf(owner, roomId, handle);
}
/** Last synchronous actual request-lifetime and native member/person/archive policy guard. */
export function requireDocHttpRoomFileWriteCurrent(
  owner: InstallationFileWrites,
  roomId: string,
  handle: object
): undefined {
  roomCallerOf(owner, roomId, handle);
  return undefined; // Fresh admission closure alone does not revoke an already admitted unchanged caller.
}
/** Read attribution from the installation-owned Room file caller. */
export function readDocHttpRoomFileWriteAttribution(
  owner: InstallationFileWrites,
  roomId: string,
  handle: object
): Readonly<{ authorId: string; signedIn: boolean }> {
  return roomCallerOf(owner, roomId, handle).attribution;
}
/** Finite disclosure-safe response mapping; unknown/raw failures still propagate unchanged. */
export function originalHttpRoomSessionPlacementRefusal(cause: unknown) {
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

/** App-resumed filesystem placement is a separate original HTTP lifetime, never a producer turn. */
interface OriginalHttpRoomSessionPlacement {
  owner: InstallationFileWrites;
  binding: OriginalHttpFileOwner;
  caller: object;
  sessionId: string;
  facts: Readonly<{
    roomId: string;
    targetAuthorId: string;
    targetAgentId: string;
    targetAgentPath: string;
    targetRuntime: string;
    targetSessionId: string;
    displayName: string;
  }>;
  active: boolean;
}
const originalHttpRoomSessionPlacements = new WeakMap<object, OriginalHttpRoomSessionPlacement>();
/** Native binding DATA from the captured owning Db; never a public ledger callback. */
function originalHttpSessionFacts(binding: OriginalHttpFileOwner, sessionId: string) {
  let canonical = sessionId;
  const seen = new Set<string>();
  let rows: (typeof roomSessions.$inferSelect)[] = [];
  for (let hop = 0; hop < 16; hop++) {
    if (seen.has(canonical)) throw new DocChannelNotFoundError();
    seen.add(canonical);
    rows = binding.db
      .select()
      .from(roomSessions)
      .where(eq(roomSessions.sessionId, canonical))
      .limit(2)
      .all();
    if (rows.length !== 0) break;
    const next = binding.db
      .select()
      .from(roomSessionRetirements)
      .where(eq(roomSessionRetirements.retiredSessionId, canonical))
      .get();
    if (!next) return undefined;
    canonical = next.canonicalSessionId;
  }
  if (rows.length !== 1) throw new DocChannelNotFoundError();
  const row = rows[0]!;
  const author = binding.db
    .select()
    .from(authors)
    .where(and(eq(authors.id, row.authorId), eq(authors.kind, 'agent'), isNull(authors.retiredAt)))
    .get();
  const agent =
    author &&
    binding.db
      .select()
      .from(agents)
      .where(and(eq(agents.projectPath, author.naturalKey), eq(agents.status, 'active')))
      .get();
  const metadata = binding.db
    .select()
    .from(sessionMetadata)
    .where(eq(sessionMetadata.sessionId, canonical))
    .get();
  const member = binding.db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, row.roomId), eq(roomMembers.authorId, row.authorId)))
    .get();
  if (
    !author ||
    !agent ||
    !metadata ||
    !member ||
    author.mintedForManifestId !== agent.id ||
    metadata.agentPath !== agent.projectPath ||
    metadata.runtime !== agent.runtime
  )
    throw new DocChannelNotFoundError();
  return Object.freeze({
    roomId: row.roomId,
    targetAuthorId: author.id,
    targetAgentId: agent.id,
    targetAgentPath: agent.projectPath,
    targetRuntime: agent.runtime,
    targetSessionId: canonical,
    displayName: author.displayName,
  });
}
/** Only the exact request and owning construction can keep this fresh placement current. */
export function readOriginalHttpRoomSessionPlacement(token: object, db: Db, store: RoomStore) {
  const current = originalHttpRoomSessionPlacements.get(token);
  if (!current) return undefined;
  if (!current.active || current.binding.db !== db || current.binding.roomStore !== store)
    throw new DocChannelNotFoundError();
  const caller = roomCallerOf(current.owner, current.facts.roomId, current.caller);
  if (caller.req.aborted || caller.res.writableEnded || caller.res.destroyed)
    throw new DocChannelNotFoundError();
  const facts = originalHttpSessionFacts(current.binding, current.sessionId);
  if (!facts || JSON.stringify(facts) !== JSON.stringify(current.facts))
    throw new DocChannelNotFoundError();
  const manager = current.binding.worktrees;
  if (!manager) throw new DocChannelNotFoundError();
  requireOriginalHttpRoomWorktreeOwner(current.owner, manager, db, current.binding.rooms);
  return facts;
}
/** Original trigger placements have no HTTP credentials; HTTP placements repeat actual verification. */
export async function checkOriginalHttpRoomSessionPlacement(token: object): Promise<void> {
  const current = originalHttpRoomSessionPlacements.get(token);
  if (!current) return;
  readOriginalHttpRoomSessionPlacement(token, current.binding.db, current.binding.roomStore);
  await checkDocHttpRoomFileWriteCurrent(current.owner, current.facts.roomId, current.caller);
  readOriginalHttpRoomSessionPlacement(token, current.binding.db, current.binding.roomStore);
}
/** Capture a fresh interactive request; a session id alone never issues placement permission. */
export async function captureOriginalHttpRoomSessionPlacement(
  owner: InstallationFileWrites,
  req: Request,
  res: Response,
  sessionId: string
): Promise<Readonly<{ place: RoomSessionPlacePort; retire(): void }>> {
  const binding = originalHttpFileOwners.get(owner);
  if (!binding) throw new DocChannelNotFoundError();
  requireOriginalRoomFileBinding(owner, binding);
  const facts = originalHttpSessionFacts(binding, sessionId);
  if (!facts) {
    return Object.freeze({
      place: {
        roomFor: () => null,
        placeTurn: async () => {
          throw new DocChannelNotFoundError();
        },
      },
      retire() {},
    });
  }
  if (binding.closed || !binding.worktrees || !binding.editor) throw new DocChannelNotFoundError();
  const manager = binding.worktrees;
  const caller = await captureDocHttpRoomFileWriteCaller(
    owner,
    req,
    res,
    facts.roomId,
    binding.editor
  );
  const token = Object.freeze({});
  const current: OriginalHttpRoomSessionPlacement = {
    owner,
    binding,
    caller,
    sessionId,
    facts,
    active: true,
  };
  originalHttpRoomSessionPlacements.set(token, current);
  const retire = () => {
    current.active = false;
    originalHttpRoomSessionPlacements.delete(token);
    retireDocHttpRoomFileWriteCaller(owner, caller);
  };
  try {
    await checkOriginalHttpRoomSessionPlacement(token);
    return Object.freeze({
      place: {
        roomFor(id: string) {
          // DATA lookup only. The awaited placement below must surface admission loss,
          // rather than let the generic optional Room lookup hide it as an ordinary chat.
          if (id !== sessionId) return null;
          return {
            roomId: facts.roomId,
            agentPath: facts.targetAgentPath,
            agentName: facts.displayName,
          };
        },
        async placeTurn(roomId: string, agentPath: string, agentName: string, id?: string) {
          await checkOriginalHttpRoomSessionPlacement(token);
          const live = readOriginalHttpRoomSessionPlacement(token, binding.db, binding.roomStore);
          if (!live) throw new DocChannelNotFoundError();
          if (
            id !== sessionId ||
            roomId !== live.roomId ||
            agentPath !== live.targetAgentPath ||
            agentName !== live.displayName
          )
            throw new DocChannelNotFoundError();
          // Preserve the original narrow no-project fallback. Authentication or
          // native-currentness failures remain refusals, never ordinary chat.
          const placed = await resolveRoomTurnPlace(manager, roomId, agentPath, agentName, token);
          await checkOriginalHttpRoomSessionPlacement(token);
          if (placed.worktree !== null) {
            const runtime = await runtimeRegistry.resolveForSession(sessionId).catch(() => null);
            await checkOriginalHttpRoomSessionPlacement(token);
            if (runtime?.type === 'opencode') {
              const inCopy = await sessionStandsInRoomCopy(runtime, sessionId, {
                agentPath,
                worktree: placed.worktree,
              });
              await checkOriginalHttpRoomSessionPlacement(token);
              if (inCopy) {
                return {
                  cwd: placed.worktree,
                  additionalDirectories: [],
                  worktree: placed.worktree,
                  standsInCopy: true,
                };
              }
            }
          }
          return placed;
        },
      },
      retire,
    });
  } catch (cause) {
    retire();
    throw cause;
  }
}

/** Retire the exact captured Room file write caller. */
export function retireDocHttpRoomFileWriteCaller(
  owner: InstallationFileWrites,
  handle: object
): undefined {
  const current = originalHttpRoomFileCallers.get(handle);
  if (!current || current.owner !== owner) throw new DocChannelNotFoundError();
  current.active = false;
  originalHttpRoomFileCallers.delete(handle);
  return undefined;
}

type RoomRepoOperation = 'enable' | 'repair' | 'merge';
interface OriginalHttpRoomRepoCaller {
  owner: InstallationFileWrites;
  binding: OriginalHttpFileOwner;
  service: RoomRepoService | RoomMergeService;
  roomId: string;
  operation: RoomRepoOperation;
  req: Request;
  res: Response;
  headers: Readonly<Request['headers']>;
  login: boolean;
  user?: Readonly<RequestUser>;
  authorId: string;
  active: boolean;
}
const originalHttpRoomRepoCallers = new WeakMap<object, OriginalHttpRoomRepoCaller>();
function requireOriginalRepoService(
  binding: OriginalHttpFileOwner,
  owner: InstallationFileWrites,
  service: RoomRepoService | RoomMergeService,
  operation: RoomRepoOperation
): void {
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
function repoCallerOf(handle: object): OriginalHttpRoomRepoCaller {
  const current = originalHttpRoomRepoCallers.get(handle);
  if (!current?.active || originalHttpFileOwners.get(current.owner) !== current.binding)
    throw new DocChannelNotFoundError();
  const { binding, owner } = current;
  requireOriginalRoomFileBinding(owner, binding);
  requireOriginalRepoService(binding, owner, current.service, current.operation);
  if (
    current.req.aborted ||
    Boolean(configManager.get('auth')?.enabled) !== current.login ||
    current.req.headers.cookie !== current.headers.cookie ||
    current.req.headers.authorization !== current.headers.authorization ||
    current.req.headers['x-dorkos-agent'] !== current.headers['x-dorkos-agent']
  )
    throw new DocChannelNotFoundError();
  const user = current.res.locals.user as RequestUser | undefined;
  if (current.user ? !sameRoomCredential(user, current.user) : user !== undefined)
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
  requireOriginalRoomFileBinding(owner, binding);
  requireOriginalRepoService(binding, owner, current.service, current.operation);
  if (!current.active || originalHttpRoomRepoCallers.get(handle) !== current)
    throw new DocChannelNotFoundError();
  return current;
}
/** Only the captured original HTTP service and real request can open this finite operation. */
export async function captureDocHttpRoomRepoCaller(
  owner: InstallationFileWrites,
  service: RoomRepoService | RoomMergeService,
  req: Request,
  res: Response,
  roomId: string,
  operation: RoomRepoOperation
): Promise<object> {
  const binding = originalHttpFileOwners.get(owner);
  if (
    !binding ||
    binding.closed ||
    typeof roomId !== 'string' ||
    !roomId ||
    !['enable', 'repair', 'merge'].includes(operation)
  )
    throw new DocChannelNotFoundError();
  requireOriginalRoomFileBinding(owner, binding);
  requireOriginalRepoService(binding, owner, service, operation);
  const caller = resolveCaller(req, res);
  requireRoomServiceRepoWriteCurrent(binding.rooms, binding.db, roomId, caller.id, operation);
  const login = Boolean(configManager.get('auth')?.enabled);
  const supplied = res.locals.user as RequestUser | undefined;
  const user = supplied ? Object.freeze({ ...supplied }) : undefined;
  const headers = Object.freeze({ ...req.headers });
  if (login || user) {
    if (!login || !user || !sameRoomCredential(await verifyRequestAuth({ headers }), user))
      throw new RoomFileRequestAuthError();
  }
  requireOriginalRoomFileBinding(owner, binding);
  requireOriginalRepoService(binding, owner, service, operation);
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
    login,
    roomId,
    operation,
    authorId: caller.id,
    active: true,
  };
  originalHttpRoomRepoCallers.set(handle, current);
  try {
    repoCallerOf(handle);
    return handle;
  } catch (error) {
    current.active = false;
    originalHttpRoomRepoCallers.delete(handle);
    throw error;
  }
}
/** Recheck credentials and currentness of the original Room repository caller. */
export async function checkDocHttpRoomRepoCaller(handle: object): Promise<void> {
  const current = repoCallerOf(handle);
  if (
    current.login &&
    !sameRoomCredential(await verifyRequestAuth({ headers: current.headers }), current.user)
  )
    throw new RoomFileRequestAuthError();
  repoCallerOf(handle);
}
/** Require currentness of the original Room repository caller. */
export function requireDocHttpRoomRepoCaller(handle: object): undefined {
  repoCallerOf(handle);
  return undefined;
}
/** Finite operation attribution; the public arguments must match the private construction. */
export function readDocHttpRoomRepoCaller(
  owner: InstallationFileWrites,
  service: RoomRepoService | RoomMergeService,
  handle: object,
  operation: RoomRepoOperation
): Readonly<{ roomId: string; authorId: string }> {
  const current = repoCallerOf(handle);
  if (current.owner !== owner || current.service !== service || current.operation !== operation)
    throw new DocChannelNotFoundError();
  return Object.freeze({ roomId: current.roomId, authorId: current.authorId });
}
/** Retire the captured original Room repository caller. */
export async function retireDocHttpRoomRepoCaller(handle: object): Promise<void> {
  const current = originalHttpRoomRepoCallers.get(handle);
  if (!current) throw new DocChannelNotFoundError();
  current.active = false;
  originalHttpRoomRepoCallers.delete(handle);
}

/** Use real server-owned instances; no independent physical document writer or transcript store. */
export function createDocChannelHttpComposition(deps: {
  db: Db;
  documents: CanvasDocumentStore;
  rooms: RoomService;
  roomStore: RoomStore;
  roomFileEditor?: RoomFileEditor;
  roomRepoService?: RoomRepoService;
  roomMergeService?: RoomMergeService;
  roomWorktreeManager?: RoomWorktreeManager;
  roomRepoReconciler?: import('../../rooms/repo/room-repo-reconciler.js').RoomRepoReconciler;
  roomRepos: RoomRepoStore;
  approvals: ApprovalService;
  installationId: string;
  owningFileWrites?: Readonly<{ channels: DocChannelStore; fileWrites: InstallationFileWrites }>;
  nativeRuntimePrincipals?: ConnectorRuntimePrincipalService;
  roomConstruction?: import('@dorkos/db/internal-server').ServerNativeRoomConstruction;
  runtimePrincipalCurrent?: (proof: ServerPrincipalProof) => boolean;
  revalidateRuntime?: (proof: ServerPrincipalProof) => Promise<boolean>;
}): DocChannelHttp & {
  grants: DocChannelGrants;
  downstream: DocChannelDownstream;
  channels: DocChannelStore;
  authorization: DocChannelAuthorization;
  grantAuthority: DocGrantAuthority;
  fileWrites: InstallationFileWrites;
  normalFileSave: NormalFileSaveService;
  namespaceFileWrites: InstallationHttpFileWrites;
  checkboxWriter: DocCheckboxWriteService;
  grantCheckboxRoute(
    raw: unknown,
    actor: DocChannelActor,
    approvalToken?: string
  ): Promise<DocGrantResult>;
  stopCheckboxWrites(): Promise<void>;
  stopFileWrites(): Promise<void>;
} {
  const suppliedFileWrites = deps.owningFileWrites;
  const channels = suppliedFileWrites ? suppliedFileWrites.channels : new DocChannelStore(deps.db);
  requireDocChannelStoreDatabase(channels, deps.db);
  if (suppliedFileWrites)
    requireInstallationFileWritesAdmission(suppliedFileWrites.fileWrites, deps.db, channels);
  const tokens = new WeakMap<ServerPrincipalProof, string>();
  const currentOwner = () => docInstallationOwner(deps.installationId);
  const sameOwnerAuthority = (recorded: unknown) => sameDocOwnerAuthority(recorded, currentOwner());
  const sameOwner = (claims: ServerPrincipalClaims) => sameOwnerAuthority(claims.owner);
  const principalCurrent = (proof: ServerPrincipalProof): boolean => {
    if (!isServerPrincipal(proof) || !sameOwner(proof.claims)) return false;
    const claims = proof.claims;
    if (claims.kind === 'operator') return true;
    if (claims.kind === 'runtime') return deps.runtimePrincipalCurrent?.(proof) === true;
    if (claims.kind !== 'agent') return false; // Runtime turn proofs use their own composition in the dispatch layer.
    const digest = tokens.get(proof);
    const token = digest
      ? deps.db
          .select()
          .from(agentIdentityTokens)
          .where(eq(agentIdentityTokens.tokenHash, digest))
          .get()
      : undefined;
    const agent = deps.db.select().from(agents).where(eq(agents.id, claims.agentId)).get();
    const now = Date.now();
    const created = Date.parse(token?.createdAt ?? '');
    const used = Date.parse(token?.lastUsedAt ?? token?.createdAt ?? '');
    return (
      !!token &&
      !token.revokedAt &&
      token.agentPath === claims.agentPath &&
      Number.isFinite(created) &&
      now - created <= TOKEN_ABSOLUTE_TTL_MS &&
      now - (Number.isFinite(used) ? used : created) <= TOKEN_IDLE_TTL_MS &&
      agent?.status === 'active' &&
      agent.projectPath === claims.agentPath
    );
  };
  const membership = (roomId: string, claims: ServerPrincipalClaims) => {
    const key =
      claims.kind === 'agent' || claims.kind === 'runtime'
        ? claims.agentPath
        : claims.kind === 'operator'
          ? claims.owner.kind === 'user'
            ? `user:${claims.owner.userId}`
            : 'local'
          : null;
    if (!key) return undefined;
    const kind = claims.kind === 'operator' ? 'human' : 'agent';
    const author = deps.db
      .select()
      .from(authors)
      .where(and(eq(authors.kind, kind), eq(authors.naturalKey, key), isNull(authors.retiredAt)))
      .get();
    if (!author) return undefined;
    if (
      (claims.kind === 'agent' || claims.kind === 'runtime') &&
      author.mintedForManifestId !== claims.agentId
    )
      return undefined;
    try {
      return deps.rooms.requireMembership(roomId, author.id);
    } catch {
      return undefined;
    }
  };
  const authorization = new DocChannelAuthorization(deps.db, deps.documents, {
    originalInstallationId: deps.installationId,
    ownsInstallation: sameOwner,
    principalCurrent,
    nativeRuntimePrincipals: deps.nativeRuntimePrincipals,
    roomConstruction: deps.roomConstruction,
    originalRoomStore: deps.roomStore,
    originalRoomRepoStore: deps.roomRepos,
    roomMembership: membership,
    revalidateRuntime: (proof) => deps.revalidateRuntime?.(proof) ?? Promise.resolve(false),
  });
  const resolveTarget: DocGrantAuthority['resolveTarget'] = (input, tx) => {
    const scope = deps.documents.lifecycle.resolveScope(input.scope);
    const parsed = parseScope(scope);
    if (input.route.to === 'log')
      return { agentId: null, agentPath: null, sessionId: null, runtime: null, scope };
    const agentId =
      input.route.to === 'agent:owner' || input.route.to === 'room:self'
        ? input.openerAgentId
        : input.route.to.slice(6);
    const executor = tx ?? deps.db;
    const agent = agentId
      ? executor.select().from(agents).where(eq(agents.id, agentId)).get()
      : undefined;
    if (!agent || agent.status !== 'active') throw new DocRouteGrantError('TARGET_UNAVAILABLE');
    let sessionId: string | null = parsed.kind === 'session' ? parsed.id : null;
    if (parsed.kind === 'session' && input.route.to !== 'agent:owner') {
      const candidates = executor
        .select()
        .from(sessionMetadata)
        .where(
          and(
            eq(sessionMetadata.agentPath, agent.projectPath),
            eq(sessionMetadata.runtime, agent.runtime)
          )
        )
        .all();
      const canonical = new Set(
        candidates.map((candidate) =>
          deps.documents.lifecycle
            .resolveScope(`session:${queueKeyOf(candidate.sessionId)}`)
            .slice(8)
        )
      );
      if (canonical.size !== 1) throw new DocRouteGrantError('TARGET_UNAVAILABLE');
      sessionId = [...canonical][0]!;
    }
    if (parsed.kind === 'room') {
      const author = executor
        .select()
        .from(authors)
        .where(
          and(
            eq(authors.kind, 'agent'),
            eq(authors.naturalKey, agent.projectPath),
            isNull(authors.retiredAt)
          )
        )
        .get();
      if (
        !author ||
        !membership(parsed.id, {
          kind: 'agent',
          owner: currentOwner(),
          agentId: agent.id,
          agentPath: agent.projectPath,
        })
      )
        throw new DocRouteGrantError('TARGET_UNAVAILABLE');
      sessionId = deps.roomStore.getRoomSession(parsed.id, author.id);
    }
    if (!sessionId) throw new DocRouteGrantError('TARGET_UNAVAILABLE');
    sessionId = deps.documents.lifecycle.resolveScope(`session:${queueKeyOf(sessionId)}`).slice(8);
    const session = executor
      .select()
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, sessionId))
      .get();
    if (
      !session?.runtime ||
      session.agentPath !== agent.projectPath ||
      session.runtime !== agent.runtime
    )
      throw new DocRouteGrantError('TARGET_UNAVAILABLE');
    return {
      agentId: agent.id,
      agentPath: agent.projectPath,
      sessionId,
      runtime: session.runtime,
      scope,
    };
  };
  const resolveSourceRoot = (documentId: string, tx?: DbTransaction): string | null => {
    const source = readDocSourceDescriptor(deps, documentId, tx);
    if (!source.sourcePath) return null;
    const canonicalRoot = fs.realpathSync(source.rootCandidate!);
    if (source.matchRoot && fs.realpathSync(source.matchRoot) !== canonicalRoot)
      throw new DocRouteGrantError('LOCAL_SOURCE_UNAVAILABLE');
    if (source.allowedRoot && !isContained(canonicalRoot, fs.realpathSync(source.allowedRoot)))
      throw new DocRouteGrantError('LOCAL_SOURCE_UNAVAILABLE');
    const file = fs.realpathSync(path.resolve(canonicalRoot, source.sourcePath));
    if (!isContained(file, canonicalRoot)) throw new DocRouteGrantError('LOCAL_SOURCE_UNAVAILABLE');
    return canonicalRoot;
  };
  const sourceRoot = (documentId: string, tx?: DbTransaction): string | null => {
    try {
      return resolveSourceRoot(documentId, tx);
    } catch (error) {
      if (error instanceof DocRouteGrantError || error instanceof DocChannelNotFoundError)
        throw error;
      throw new DocRouteGrantError('LOCAL_SOURCE_UNAVAILABLE');
    }
  };
  const originalCheckboxGrantCapture: { preparation?: OriginalCheckboxGrantPreparation } = {};
  const grantAuthority: DocGrantAuthority = {
    resolveScope: (scope) => deps.documents.lifecycle.resolveScope(scope),
    requireCurrent: (documentId, actor, write, tx) =>
      requireOriginalCurrentDocAccess(authorization, documentId, actor, write, tx),
    resolveTarget,
    sourceRoot,
    resolveWriteBinding: (documentId, tx) =>
      originalCheckboxGrantCapture.preparation
        ? (resolveOriginalCheckboxGrantBinding(
            originalCheckboxGrantCapture.preparation,
            documentId,
            tx
          ) ?? null)
        : null,
    originCurrent: (documentId, opener, tx) => {
      const channel = channels.getChannel(documentId, tx);
      const agent = (tx ?? deps.db).select().from(agents).where(eq(agents.id, opener)).get();
      return channel?.openerAgentId === opener && agent?.status === 'active';
    },
    requireGrantedCurrent: (grant, tx) => {
      // Persisted grant evidence is verified by DocChannelGrants. Recheck the owning physical scope here,
      // without minting an operator principal or borrowing an expired opener-turn proof.
      const origin = (grant.approvalEvidence as { binding?: { origin?: { owner?: unknown } } })
        .binding?.origin;
      if (!sameOwnerAuthority(origin?.owner)) throw new DocChannelNotFoundError();
      const identity = deps.documents.lookupIdentity(grant.documentId);
      const channel = channels.getChannel(grant.documentId, tx);
      if (!identity || !channel || channel.closedAt !== null || grant.revokedAt)
        throw new DocChannelNotFoundError();
      deps.documents.lifecycle.assertReady(grant.documentId);
      const scope = deps.documents.lifecycle.resolveScope(identity.scope);
      if (
        channel.scope !== scope ||
        deps.documents.lifecycle.resolveScope(
          String((grant.approvalEvidence as { binding?: { scope?: string } }).binding?.scope ?? '')
        ) !== scope
      )
        throw new DocChannelNotFoundError();
      const parsed = parseScope(scope);
      if (parsed.kind === 'unknown') throw new DocChannelNotFoundError();
      if (parsed.kind === 'room') {
        const owner = membership(parsed.id, { kind: 'operator', owner: currentOwner() });
        if (!owner || owner.archived) throw new DocChannelNotFoundError();
      }
      return { id: identity.id, scope };
    },
  };
  const grants = new DocChannelGrants({
    db: deps.db,
    store: channels,
    approvals: deps.approvals,
    authority: grantAuthority,
  });
  const downstreamAuthority = createDocDownstreamAuthority(channels, authorization, grants, {
    principalCurrent,
    ownsInstallation: sameOwner,
    resolveScope: (scope) => deps.documents.lifecycle.resolveScope(scope),
    revalidateRuntime: (proof) => deps.revalidateRuntime?.(proof) ?? Promise.resolve(false),
  });
  const resolveOriginalHttpActor: DocChannelHttp['actor'] = (req, res) => {
    resolveCaller(req, res); // Refuse unknown/revoked agent headers before minting a principal.
    const identity = getRequestAgentIdentity(res);
    const owner = currentOwner();
    if (identity) {
      const agent = deps.db
        .select()
        .from(agents)
        .where(eq(agents.projectPath, identity.agentPath))
        .get();
      if (!agent || agent.status !== 'active') throw new DocChannelNotFoundError();
      const principal = createServerPrincipal({
        kind: 'agent',
        owner,
        agentId: agent.id,
        agentPath: agent.projectPath,
      });
      const raw = req.headers['x-dorkos-agent'];
      if (typeof raw !== 'string') throw new DocChannelNotFoundError();
      tokens.set(principal, createHash('sha256').update(raw).digest('hex'));
      return { surface: 'http', principal };
    }
    const user = res.locals.user as RequestUser | undefined;
    if (user && (owner.kind !== 'user' || owner.userId !== user.userId))
      throw new DocChannelNotFoundError();
    return { surface: 'http', principal: createServerPrincipal({ kind: 'operator', owner }) };
  };
  const fileWrites =
    suppliedFileWrites?.fileWrites ?? new InstallationFileWrites({ db: deps.db, store: channels });
  requireInstallationFileWritesAdmission(fileWrites, deps.db, channels);
  const downstream = deps.nativeRuntimePrincipals
    ? createInstallationOriginalRoomDownstream(
        fileWrites,
        deps.db,
        channels,
        downstreamAuthority,
        deps.nativeRuntimePrincipals
      )
    : new DocChannelDownstream(channels, downstreamAuthority); // Ordinary lane retains Room refusal; it owns no emitter.

  requireRoomServiceFileWriteOwner(deps.rooms, deps.db, deps.roomStore);
  if (deps.roomFileEditor) requireRoomFileEditorOwner(deps.roomFileEditor, fileWrites);
  if (deps.roomRepoService)
    requireRoomRepoServiceOwner(deps.roomRepoService, fileWrites, deps.db, deps.rooms);
  if (deps.roomMergeService)
    requireRoomMergeServiceOwner(deps.roomMergeService, fileWrites, deps.db, deps.rooms);
  if (deps.roomWorktreeManager)
    requireRoomWorktreeManagerOwner(deps.roomWorktreeManager, fileWrites, deps.db, deps.rooms);
  if (deps.roomRepoReconciler)
    requireRoomRepoReconcilerOwner(
      deps.roomRepoReconciler,
      fileWrites,
      deps.db,
      deps.rooms,
      deps.roomRepos
    );
  const fileOwner: OriginalHttpFileOwner = {
    reconciler: deps.roomRepoReconciler,
    worktrees: deps.roomWorktreeManager,
    repoService: deps.roomRepoService,
    mergeService: deps.roomMergeService,
    editor: deps.roomFileEditor,
    rooms: deps.rooms,
    roomStore: deps.roomStore,
    native: deps.db.$client,
    db: deps.db,
    store: channels,
    actor: resolveOriginalHttpActor,
    principalCurrent,
    closed: false,
  };
  if (originalHttpFileOwners.has(fileWrites))
    throw new Error('Owning file writer already has its original HTTP binding.');
  originalHttpFileOwners.set(fileWrites, fileOwner);
  const stopOriginalFileWrites = () => stopInstallationFileWrites(fileWrites, deps.db, channels);
  const normalFileSave = new NormalFileSaveService(fileWrites, deps.db, channels);
  const service = new DocChannelService(deps.documents, channels, authorization, {
    ingest: new DocChannelIngest(channels),
    grants,
  });
  fileOwner.service = service;
  const checkboxAuthority = new DocCheckboxAuthority({
    db: deps.db,
    documents: deps.documents,
    roomRepos: deps.roomRepos,
    rooms: deps.rooms,
    authorization,
    grants,
    store: channels,
    installationId: deps.installationId,
    now: () => new Date(),
  });
  const checkboxWriter = createInstallationOriginalCheckboxWriter(
    fileWrites,
    deps.db,
    channels,
    checkboxAuthority,
    service
  );
  const checkboxGrantPreparation = createInstallationOriginalCheckboxGrantPreparation(
    fileWrites,
    deps.db,
    channels,
    checkboxAuthority,
    service,
    grants
  );
  originalCheckboxGrantCapture.preparation = checkboxGrantPreparation;
  return {
    checkboxWriter,
    grantCheckboxRoute: (raw, actor, approvalToken) =>
      grantOriginalCheckboxRoute(checkboxGrantPreparation, raw, actor, approvalToken),
    stopCheckboxWrites: () => stopInstallationOriginalCheckboxWriter(fileWrites, deps.db, channels),
    fileWrites,
    normalFileSave,
    namespaceFileWrites: readInstallationHttpFileWrites(fileWrites, deps.db, channels),
    async stopFileWrites() {
      fileOwner.closed = true;
      await stopOriginalFileWrites();
    },
    actor: resolveOriginalHttpActor,
    grants,
    downstream,
    channels,
    authorization,
    grantAuthority,
    service,
  };
}

/** Original HTTP actor stays inside its captured owner-to-service completion lane. */
export function prepareDocHttpDocumentSave(
  owner: InstallationFileWrites,
  callerHandle: object,
  saveScope: object
) {
  requireDocHttpFileWriteCurrent(owner, callerHandle);
  const caller = originalHttpFileCallers.get(callerHandle)!;
  if (!caller.binding.service || caller.actor.principal.claims.kind !== 'operator')
    throw new DocChannelNotFoundError();
  return prepareServiceOriginalDocumentSave(caller.binding.service, saveScope, caller.actor);
}
/** Complete only the same actual caller and private writer scope after original persistence. */
export function completeDocHttpDocumentSave(
  owner: InstallationFileWrites,
  callerHandle: object,
  saveScope: object
) {
  requireDocHttpFileWriteCurrent(owner, callerHandle);
  const caller = originalHttpFileCallers.get(callerHandle)!;
  if (!caller.binding.service || caller.actor.principal.claims.kind !== 'operator')
    throw new DocChannelNotFoundError();
  return completeServiceOriginalDocumentSave(caller.binding.service, saveScope, caller.actor);
}
