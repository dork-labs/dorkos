/**
 * Bringing an agent's work back into a room, and saying what a room's files
 * currently hold (spec `project-rooms` §3.6).
 *
 * Every agent in a project room works in its own standing checkout on its own
 * `room/<slug>` branch (`room-worktree-manager.ts`). This module is the only way
 * that work reaches `main`, and the shape of it is the DOR-500 invariant applied
 * to a shared repo: **the agent commits in its own tree, and the SERVER merges
 * in the integration tree, one at a time**. Nothing here ever writes in an
 * agent's worktree, and nothing an agent can call writes in `repo/` except
 * through {@link RoomMergeService.merge}.
 *
 * ## The refusals are the design, not error handling
 *
 * Each one exists because the alternative is worse than being told no, and each
 * says which it was so an agent can act on it without reading prose:
 *
 * | Refusal | What it protects |
 * | --- | --- |
 * | `NOT_A_PROJECT_ROOM` | A room without files has no `main` to merge into. |
 * | `UNCOMMITTED_WORK` | Unsaved edits are work the merge would leave behind. |
 * | `BEHIND_MAIN` | See below — this is the one the whole design leans on. |
 * | `SYMLINK_ESCAPES_REPO` | A link out of the room publishes, or overwrites, whatever the next checkout can reach. |
 * | `FILE_TOO_LARGE` / `REPO_CAP_EXCEEDED` | A shared repo everyone syncs is a shared cost. |
 * | `MERGE_IN_FLIGHT` | Two `git merge`s in one checkout is the contention one-writer forbids. |
 * | `NOTHING_TO_MERGE` | An empty merge commit, and a line in the room announcing that somebody merged nothing. |
 * | `MAIN_CHECKOUT_DIRTY` | Merging on top of an out-of-band edit either mixes it into somebody else's commit or loses it. |
 * | `MERGE_CONFLICT` | The tree is rolled back and the caller told so, rather than left mid-merge. |
 *
 * The last three are not in the spec's list. `NOTHING_TO_MERGE` and
 * `MAIN_CHECKOUT_DIRTY` earn their place above; `MERGE_CONFLICT` is unreachable
 * through the ordinary path and is kept because the guarantee behind
 * `BEHIND_MAIN` needs somewhere to fail safely when a person commits into the
 * integration tree by hand.
 *
 * **`BEHIND_MAIN` is why "main is never left conflicted" is a property of the
 * code.** A branch that already contains `main`'s tip cannot conflict with it —
 * the merge is a fast-forward made non-fast-forward by `--no-ff`, and its result
 * tree IS the branch's tree. That is what lets validation run on the branch's
 * own tree before the merge and still describe exactly what `main` will hold
 * afterwards. It also puts conflict resolution where one-writer requires it: in
 * the agent's own tree, in the agent's own turn, with `git merge main`.
 * {@link mergeNoFf}'s abort is the belt to that braces, for the window where
 * somebody commits into the integration tree by hand.
 *
 * ## Caps come from the sidecar, and the difference matters
 *
 * `maxFileBytes` / `maxRepoBytes` are read from `room-repo.json` — frozen when
 * the operator enabled the repo — and never from live config. A room's contents
 * were legal when they were merged, and lowering a setting today must not make
 * yesterday's files retroactively illegal. (`maxRoomMdBytes` is the opposite
 * question and is read live by `room-conventions.ts`: that one bounds what is
 * SENT on every turn, not what may be stored.)
 *
 * ## Nothing here can rewrite history
 *
 * There is no force, no reset, no push and no branch deletion on this surface or
 * under it — `room-repo-git.ts` does not export them. A room's log is
 * append-only and so is its repo (spec §3.6).
 *
 * @module server/services/rooms/repo/room-merge-service
 */
import { recordAudit } from '../../audit/audit-trail.js';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Room, RoomEntry } from '@dorkos/shared/room-schemas';
import type {
  RoomBranchStatus,
  RoomMainStatus,
  RoomMergeResult,
  RoomRepoCaps,
  RoomRepoStatus,
} from '@dorkos/shared/room-repo';
import { MAX_REPORTED_ROOM_STRAYS, behindMainMessage } from '@dorkos/shared/room-repo';
import { MERGE_SUMMARY_MAX_CHARS } from '@dorkos/shared/room-schemas';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';
import { logger } from '../../../lib/logger.js';
import { RoomError } from '../data/room-errors.js';
import {
  readOwnedRoomRepoSource,
  executeOriginalRoomRepoStoreRead,
  executeOriginalRoomRepoStoreWrite,
  type RoomRepoStore,
} from './room-repo-store.js';
import { RoomWorktreeManager, roomWorktreeBranch } from './room-worktree-manager.js';
import type { RoomRepoMutex } from './room-repo-mutex.js';
import {
  assertMainCheckoutReady,
  readMainCheckoutState,
  type RoomMainCheckoutState,
} from './room-main-checkout.js';
import {
  aheadBehind,
  hasLocalBranch,
  hasUncommittedChanges,
  headCommittedAt,
  listTree,
  MergeConflictError,
  mergeNoFf,
  readBlob,
  revParse,
  shortstat,
  GITLINK_MODE,
  SYMLINK_MODE,
  type StrayChange,
  type TreeEntry,
} from './room-repo-git.js';

/**
 * The domain every merge commit is authored under.
 *
 * The same `.local` reservation `OPERATOR_GIT_EMAIL` uses and for the same
 * reason: git demands an address, DorkOS has none, and RFC 6762 guarantees this
 * one can never resolve or be mailed by accident.
 */
const AGENT_GIT_EMAIL_DOMAIN = 'dorkos.local';

/**
 * How long a computed `room_repo_status` answer may be reused.
 *
 * Five seconds, and the number is about what the answer is FOR. It feeds the
 * explorer's pending-work badges, which poll — and the underlying work is
 * `2 + 3n` git spawns for `n` agent members, so a busy room's badges would
 * otherwise cost more processes than the merges they are watching. Five seconds
 * of staleness is invisible next to "how far behind is Ana", and the cache is
 * keyed on `main`'s sha as well as on time, so the one event that really changes
 * the answer — a merge — invalidates it immediately rather than waiting out the
 * clock.
 */
const STATUS_CACHE_MS = 5_000;

/**
 * How many stray changes one status answer carries.
 *
 * Fifty, and the number is about what the list is FOR: it is the evidence
 * behind "somebody wrote in this room's files", and a person deciding what to
 * do about that needs to recognise the change, not to audit every path. A tree
 * somebody dropped `node_modules` into has tens of thousands, and sending them
 * would turn a warning into a payload nobody can render. `strayCount` still
 * answers how many there really are.
 */
const MAX_REPORTED_STRAYS = MAX_REPORTED_ROOM_STRAYS;

/**
 * What a completed merge answers.
 *
 * Declared on the wire contract (`@dorkos/shared/room-repo`) rather than here,
 * because the DorkOS app reads it back too: the merge action on a room's diff
 * (spec `canvas-agent-seat` §8) calls `RoomTransport.mergeRoomMain` and renders
 * this shape. Re-exported under the name every caller in this domain already
 * uses, so nothing had to move with it.
 */
export type { RoomMergeResult };

/** The seams {@link RoomMergeService} needs from the rest of the server. */
export interface RoomMergeServiceDeps {
  /** Owns every path under a room's home; never construct one by hand. */
  store: RoomRepoStore;
  /** The per-room serialized queue every write to `repo/` goes through. */
  mutex: RoomRepoMutex;
  /** `config.rooms.repo.enabled`, read per call. */
  enabled(): boolean;
  /** `config.rooms.repo.mergeQueueWaitMs`, read per call. */
  mergeQueueWaitMs(): number;
  /**
   * Refuse a caller who is not on this room's roster, and answer with the room.
   *
   * `RoomService.requireMembership` in production. Membership is the gate on
   * both verbs, exactly as it is on the history reads, and "not a member"
   * answers as "no such room" so a room id is never a capability.
   */
  requireMembership(roomId: string, authorId: string): Room;
  /**
   * The agent members of a room, with the workspace path each is keyed by.
   *
   * `RoomService.listAgentMembers` in production. The paths never leave this
   * module — what a caller sees is the slug derived from one.
   */
  listAgentMembers(roomId: string): { authorId: string; agentPath: string; displayName: string }[];
  /** Which working copies hold work `main` has not got. */
  listStrandedWorktrees(roomId: string): Promise<string[]>;
  /**
   * Announce a merge in the room. `RoomService.postMergeEvent` in production —
   * the single write path into a room's log, never a second one.
   */
  announce(
    roomId: string,
    input: {
      text: string;
      merge: {
        branch: string;
        commit: string;
        files: number;
        insertions: number;
        deletions: number;
      };
      subjectAuthorId: string;
    }
  ): RoomEntry;
  /** Whether an author is the person who owns this install. */
  isOwnerAuthor(authorId: string): boolean;
}

import type { Db } from '@dorkos/db';
import type { RoomStore } from '../room-store.js';
import {
  requireRoomServiceFileWriteOwner,
  requireRoomServiceRepoWriteCurrent,
  readRoomServiceRepoAgentRoster,
  type RoomService,
} from '../room-service.js';
import type { DocChannelStore } from '../../canvas/doc-channel/store.js';
import {
  requireInstallationFileWritesOwner,
  type InstallationFileWrites,
} from '../../canvas/doc-channel/writes/installation-file-writes.js';
import {
  requireInstallationRoomWrites,
  readInstallationRoomFileWriteOwner,
  withRecognizedInstallationRoomMerge,
  readInstallationRoomRepoMutationContext,
  readInstallationRoomNativeMergeMutationContext,
  readInstallationRoomMutationRoots,
  checkInstallationRoomMutationTarget,
  requireInstallationRoomMutationTarget,
  type InstallationRoomWrites,
  type InstallationRoomMutationContext,
} from '../../canvas/doc-channel/writes/installation-room-writes.js';
import {
  captureDocHttpRoomRepoCaller,
  readDocHttpRoomRepoCaller,
  checkDocHttpRoomRepoCaller,
} from '../../canvas/doc-channel/http-composition.js';
import {
  readOriginalRoomMergeInvocation,
  requireOriginalRoomMergeInvocation,
  type CapabilityHandlerContext,
} from '../../core/capabilities/registry.js';
import {
  requireNativePrincipalDatabase,
  captureNativePrincipalTime,
  readCurrentNativePrincipalSource,
  type ConnectorRuntimePrincipalService,
} from '../../connectors/principal/runtime-principal-service.js';
import { DocChannelNotFoundError } from '../../canvas/doc-channel/authorization.js';

interface RoomMergeOwningConstruction {
  readonly owner: InstallationFileWrites;
  readonly writer: InstallationRoomWrites;
  readonly db: Db;
  readonly channels: DocChannelStore;
  readonly rooms: RoomService;
  readonly roomStore: RoomStore;
  readonly nativePrincipals?: ConnectorRuntimePrincipalService;
}
interface NativeMergeOperation {
  readonly service: RoomMergeService;
  readonly invocation: object;
  readonly authorId: string;
  readonly roomId: string;
  active: boolean;
}
const nativeMergeOperations = new WeakMap<object, NativeMergeOperation>();
const originalMergeServices = new WeakMap<
  RoomMergeService,
  {
    readonly owning: RoomMergeOwningConstruction;
    preflight(): void;
    http(handle: object, input: { summary: string; worktree?: string }): Promise<RoomMergeResult>;
    native(
      context: CapabilityHandlerContext,
      input: { roomId: string; summary: string }
    ): Promise<RoomMergeResult>;
    current(operation: NativeMergeOperation): undefined;
  }
>();
/** Require the Room merge service's exact original owner dependencies. */
export function requireRoomMergeServiceOwner(
  service: RoomMergeService,
  owner: InstallationFileWrites,
  db: Db,
  rooms: RoomService
): undefined {
  const binding = originalMergeServices.get(service);
  if (
    !binding ||
    binding.owning.owner !== owner ||
    binding.owning.db !== db ||
    binding.owning.rooms !== rooms
  )
    throw new DocChannelNotFoundError();
  requireInstallationFileWritesOwner(owner, db, binding.owning.channels);
  requireRoomServiceFileWriteOwner(rooms, db, binding.owning.roomStore);
  if (binding.owning.nativePrincipals)
    requireNativePrincipalDatabase(binding.owning.nativePrincipals, db);
  if (!db.$client.open || db.$client.inTransaction) throw new DocChannelNotFoundError();
  return undefined;
}
/** Require the original runtime registry used by Room merge construction. */
export function requireRoomMergeRegistryConstruction(
  service: RoomMergeService,
  nativePrincipals: ConnectorRuntimePrincipalService,
  db: Db
): undefined {
  const binding = originalMergeServices.get(service);
  if (
    !binding ||
    !nativePrincipals ||
    binding.owning.nativePrincipals !== nativePrincipals ||
    binding.owning.db !== db
  )
    throw new DocChannelNotFoundError();
  return requireRoomMergeServiceOwner(service, binding.owning.owner, db, binding.owning.rooms);
}
/** Execute a merge through the original Room HTTP caller. */
export function executeRoomHttpMerge(
  service: RoomMergeService,
  handle: object,
  input: { summary: string; worktree?: string }
): Promise<RoomMergeResult> {
  const binding = originalMergeServices.get(service);
  if (!binding) return Promise.reject(new DocChannelNotFoundError());
  requireRoomMergeServiceOwner(
    service,
    binding.owning.owner,
    binding.owning.db,
    binding.owning.rooms
  );
  return binding.http(handle, input);
}
/** Execute a merge through the original native Room operation. */
export function executeRoomNativeMerge(
  service: RoomMergeService,
  context: CapabilityHandlerContext,
  input: { roomId: string; summary: string }
): Promise<RoomMergeResult> {
  const binding = originalMergeServices.get(service);
  if (!binding) return Promise.reject(new DocChannelNotFoundError());
  if (!binding.owning.nativePrincipals) return Promise.reject(new DocChannelNotFoundError());
  requireRoomMergeRegistryConstruction(service, binding.owning.nativePrincipals, binding.owning.db);
  return binding.native(context, input);
}
/** Fixed private operation recognition, never a caller-supplied currentness function. */
export function requireOriginalRoomNativeMergeCurrent(
  service: RoomMergeService,
  token: object,
  roomId: string
): undefined {
  const operation = nativeMergeOperations.get(token),
    binding = originalMergeServices.get(service);
  if (
    !operation?.active ||
    !binding ||
    operation.service !== service ||
    operation.roomId !== roomId
  )
    throw new DocChannelNotFoundError();
  binding.current(operation);
  if (!operation.active || nativeMergeOperations.get(token) !== operation)
    throw new DocChannelNotFoundError();
  return undefined;
}

const originalMergeStoreOperations = new WeakMap<
  InstallationRoomMutationContext,
  {
    service: RoomMergeService;
    owning: RoomMergeOwningConstruction;
    store: RoomRepoStore;
    roomId: string;
  }
>();
/** Same original still-awaited private merge operation; no Store DTO or namespace alone grants this lookup. */
export function readOriginalRoomMergeStoreOperation(
  context: InstallationRoomMutationContext,
  store: RoomRepoStore,
  db: Db
): Readonly<{ roomId: string }> | undefined {
  const operation = originalMergeStoreOperations.get(context);
  if (!operation || operation.store !== store || operation.owning.db !== db) return undefined;
  requireRoomMergeServiceOwner(
    operation.service,
    operation.owning.owner,
    db,
    operation.owning.rooms
  );
  const roots = readInstallationRoomMutationRoots(context);
  requireInstallationRoomMutationTarget(context, roots.homePath);
  if (originalMergeStoreOperations.get(context) !== operation) return undefined;
  return Object.freeze({ roomId: operation.roomId });
}

/** Route captures only through the actual constructor-owned service and verified HTTP composition. */
export function captureRoomMergeHttpOperation(
  service: RoomMergeService,
  req: import('express').Request,
  res: import('express').Response,
  roomId: string
): Promise<object> {
  const binding = originalMergeServices.get(service);
  if (!binding) return Promise.reject(new DocChannelNotFoundError());
  requireRoomMergeServiceOwner(
    service,
    binding.owning.owner,
    binding.owning.db,
    binding.owning.rooms
  );
  binding.preflight();
  return captureDocHttpRoomRepoCaller(binding.owning.owner, service, req, res, roomId, 'merge');
}

/** Merging work into a room's `main`, and reporting what its repo holds. */
export class RoomMergeService {
  /**
   * The last computed status per room, with the commit it was computed at.
   *
   * Bounded by the number of rooms that have repos and have been asked about,
   * and each entry is a handful of small objects — so it is not swept. See
   * {@link STATUS_CACHE_MS} for why it exists at all.
   */
  private readonly statusCache = new Map<
    string,
    { mainCommit: string; at: number; status: RoomRepoStatus }
  >();

  readonly #deps: Readonly<RoomMergeServiceDeps>;
  readonly #owning?: RoomMergeOwningConstruction;
  constructor(deps: RoomMergeServiceDeps, owning?: RoomMergeOwningConstruction) {
    this.#deps = Object.freeze({ ...deps });
    if (owning) {
      requireInstallationFileWritesOwner(owning.owner, owning.db, owning.channels);
      requireInstallationRoomWrites(
        owning.writer,
        owning.owner,
        owning.db,
        owning.channels,
        deps.store
      );
      if (
        readInstallationRoomFileWriteOwner(owning.writer, deps.store, deps.mutex) !== owning.owner
      )
        throw new DocChannelNotFoundError();
      requireRoomServiceFileWriteOwner(owning.rooms, owning.db, owning.roomStore);
      if (owning.nativePrincipals)
        requireNativePrincipalDatabase(owning.nativePrincipals, owning.db);
      this.#owning = Object.freeze({ ...owning });
      originalMergeServices.set(
        this,
        Object.freeze({
          owning: this.#owning,
          preflight: () => this.#requireEnabled(),
          http: (handle: object, input: { summary: string; worktree?: string }) =>
            this.#executeHttp(handle, input),
          native: (context: CapabilityHandlerContext, input: { roomId: string; summary: string }) =>
            this.#executeNative(context, input),
          current: (operation: NativeMergeOperation) => this.#requireNativeOperation(operation),
        })
      );
    }
  }

  /**
   * Merge an agent's branch into the room's `main`, then say so in the room.
   *
   * **Authorization is answered before the queue, and git state inside it.**
   * Who may merge does not change while a caller waits, so asking first means a
   * caller that was never allowed is refused immediately rather than after
   * thirty seconds of somebody else's merge. Everything git can tell us — dirty,
   * behind, what the tree holds — is asked while holding the lane, because all
   * of it can change under a merge running ahead of this one. That ordering is
   * the whole of the concurrency argument: two agents merging together serialize,
   * and the second one is refused `BEHIND_MAIN` if the first moved `main` under
   * it, which is correct rather than unfortunate.
   *
   * **An agent merges its own branch and only its own.** Merging a colleague's
   * work is publishing a decision that was not this agent's to make, and the
   * room has no way to tell the difference afterwards. Naming a `worktree` is
   * therefore the operator's affordance (spec §5 Q2 puts the owner on the merge
   * list, and the owner has no branch of their own).
   *
   * That is a rule about the AUTHOR this call resolves to, and it inherits the
   * install's posture rather than improving on it: with login off, a local
   * caller that presents no agent token resolves to the operator (`callerAuthor`
   * in `room-capabilities.ts`, the documented DOR-505 residual), and the
   * operator may name any worktree. So the honest claim is that no agent ACTING
   * AS ITSELF can merge a colleague's work — the same claim, and the same
   * caveat, that `POST /:id/repo`'s operator-only gate carries.
   *
   * @param roomId - The room whose `main` gains the work.
   * @param callerAuthorId - Who is asking.
   * @param input.summary - What the agent says it did. Sanitized; it becomes the
   *   merge commit's subject and part of the room's own sentence.
   * @param input.worktree - The worktree slug to merge, for an operator merging
   *   somebody's branch. Omitted by an agent, which always merges its own.
   * @returns What landed.
   * @throws {RoomError} Every refusal in the module doc's table.
   */
  async merge(
    roomId: string,
    callerAuthorId: string,
    input: { summary: string; worktree?: string }
  ): Promise<RoomMergeResult> {
    // DTO attribution cannot mint a production mutation operation.
    void roomId;
    void callerAuthorId;
    void input;
    throw new DocChannelNotFoundError();
  }

  #requireEnabled(): void {
    if (!this.#deps.enabled())
      throw new RoomError(
        'ROOM_REPOS_DISABLED',
        'Rooms cannot have files of their own on this install. Turn that back on in Settings first.'
      );
  }
  async #executeHttp(
    handle: object,
    supplied: { summary: string; worktree?: string }
  ): Promise<RoomMergeResult> {
    const owning = this.#owning!;
    const input = Object.freeze({
      summary: supplied.summary,
      ...(supplied.worktree === undefined ? {} : { worktree: supplied.worktree }),
    });
    const caller = readDocHttpRoomRepoCaller(owning.owner, this, handle, 'merge');
    requireRoomServiceRepoWriteCurrent(
      owning.rooms,
      owning.db,
      caller.roomId,
      caller.authorId,
      'merge'
    );
    this.#requireProjectRoom(caller.roomId, caller.authorId);
    const target = this.#resolveTarget(caller.roomId, caller.authorId, input.worktree);
    await checkDocHttpRoomRepoCaller(handle);
    return withRecognizedInstallationRoomMerge(owning.writer, caller.roomId, async (scope) => {
      await checkDocHttpRoomRepoCaller(handle);
      requireRoomServiceRepoWriteCurrent(
        owning.rooms,
        owning.db,
        caller.roomId,
        caller.authorId,
        'merge'
      );
      const room = this.#requireProjectRoom(caller.roomId, caller.authorId);
      const currentTarget = this.#resolveTarget(caller.roomId, caller.authorId, input.worktree);
      if (!sameMergeTarget(target, currentTarget)) throw new DocChannelNotFoundError();
      const context = readInstallationRoomRepoMutationContext(
        owning.writer,
        caller.roomId,
        scope,
        this,
        'merge',
        handle
      );
      originalMergeStoreOperations.set(context, {
        service: this,
        owning,
        store: this.#deps.store,
        roomId: caller.roomId,
      });
      try {
        return await this.#mergeUnderLock(room, currentTarget, input.summary, context);
      } finally {
        originalMergeStoreOperations.delete(context);
      }
    });
  }

  #readNativeAuthor(invocation: object): { roomId: string; summary: string; authorId: string } {
    const owning = this.#owning!;
    const nativePrincipals = owning.nativePrincipals;
    if (!nativePrincipals) throw new DocChannelNotFoundError();
    const captured = requireOriginalRoomMergeInvocation(
      invocation,
      this,
      nativePrincipals,
      owning.db
    );
    const time = captureNativePrincipalTime(nativePrincipals, owning.db, captured.principal);
    const source = readCurrentNativePrincipalSource(
      nativePrincipals,
      owning.db,
      captured.principal,
      owning.db,
      time
    );
    if (!source) throw new DocChannelNotFoundError();
    const roster = readRoomServiceRepoAgentRoster(owning.rooms, owning.db, captured.roomId);
    const member = roster.find(
      (row) =>
        row.agentPath === source.binding.agentPath && row.manifestId === source.binding.agentId
    );
    if (!member) throw new DocChannelNotFoundError();
    requireRoomServiceRepoWriteCurrent(
      owning.rooms,
      owning.db,
      captured.roomId,
      member.authorId,
      'merge'
    );
    // Repeat the genuine invocation/native read after roster/policy observable work.
    requireOriginalRoomMergeInvocation(invocation, this, nativePrincipals, owning.db);
    const finalTime = captureNativePrincipalTime(nativePrincipals, owning.db, captured.principal);
    const current = readCurrentNativePrincipalSource(
      nativePrincipals,
      owning.db,
      captured.principal,
      owning.db,
      finalTime
    );
    if (
      !current ||
      current.binding.agentId !== source.binding.agentId ||
      current.binding.agentPath !== source.binding.agentPath
    )
      throw new DocChannelNotFoundError();
    const finalRoster = readRoomServiceRepoAgentRoster(owning.rooms, owning.db, captured.roomId);
    if (
      !finalRoster.some(
        (row) =>
          row.authorId === member.authorId &&
          row.agentPath === current.binding.agentPath &&
          row.manifestId === current.binding.agentId
      )
    )
      throw new DocChannelNotFoundError();
    return { roomId: captured.roomId, summary: captured.summary, authorId: member.authorId };
  }
  #requireNativeOperation(operation: NativeMergeOperation): undefined {
    this.#requireProjectRoom(operation.roomId, operation.authorId);
    const current = this.#readNativeAuthor(operation.invocation);
    if (
      !operation.active ||
      current.roomId !== operation.roomId ||
      current.authorId !== operation.authorId
    )
      throw new DocChannelNotFoundError();
    return undefined;
  }
  async #executeNative(
    handlerContext: CapabilityHandlerContext,
    input: { roomId: string; summary: string }
  ): Promise<RoomMergeResult> {
    const owning = this.#owning!,
      invocation = readOriginalRoomMergeInvocation(handlerContext, input, this);
    const caller = this.#readNativeAuthor(invocation);
    this.#requireProjectRoom(caller.roomId, caller.authorId);
    const target = this.#resolveTarget(caller.roomId, caller.authorId, undefined);
    const token = Object.freeze({});
    const operation: NativeMergeOperation = {
      service: this,
      invocation,
      authorId: caller.authorId,
      roomId: caller.roomId,
      active: true,
    };
    nativeMergeOperations.set(token, operation);
    try {
      return await withRecognizedInstallationRoomMerge(
        owning.writer,
        caller.roomId,
        async (scope) => {
          requireOriginalRoomNativeMergeCurrent(this, token, caller.roomId);
          const room = this.#requireProjectRoom(caller.roomId, caller.authorId);
          const currentTarget = this.#resolveTarget(caller.roomId, caller.authorId, undefined);
          if (!sameMergeTarget(target, currentTarget)) throw new DocChannelNotFoundError();
          const context = readInstallationRoomNativeMergeMutationContext(
            owning.writer,
            caller.roomId,
            scope,
            this,
            token
          );
          originalMergeStoreOperations.set(context, {
            service: this,
            owning,
            store: this.#deps.store,
            roomId: caller.roomId,
          });
          try {
            return await this.#mergeUnderLock(room, currentTarget, caller.summary, context);
          } finally {
            originalMergeStoreOperations.delete(context);
          }
        }
      );
    } finally {
      operation.active = false;
      nativeMergeOperations.delete(token);
    }
  }

  /**
   * What a room's files hold right now — the read half of §3.6.
   *
   * Deliberately outside the merge queue. Every question it asks is a read, and
   * a status call that queued behind a merge would be slowest exactly when a
   * person most wants to know what is happening. The answer may therefore be one
   * merge out of date, which is what a status always is.
   *
   * @param roomId - The room.
   * @param callerAuthorId - Who is asking; must be on the roster.
   * @returns The main tip, one row per agent branch, the stranded list and the
   *   size against the caps.
   * @throws {RoomError} `ROOM_NOT_FOUND`, `ROOM_REPOS_DISABLED`,
   *   `NOT_A_PROJECT_ROOM`.
   */
  async status(roomId: string, callerAuthorId: string): Promise<RoomRepoStatus> {
    this.#requireProjectRoom(roomId, callerAuthorId);
    const repoDir = this.#deps.store.repoPath(roomId);
    const ceiling = this.#deps.store.homeDir(roomId);

    // One cheap read decides whether the expensive ones have to happen at all.
    const mainCommit = await revParse(repoDir, 'main', ceiling);
    // Never cached — see {@link RoomRepoStatus.main}. Somebody editing the
    // room's own copy in a terminal, and the operator undoing it, both change
    // this without moving a commit, so a cached answer would go on saying the
    // room is stuck after it was fixed.
    const main = await this.#readMain(repoDir, ceiling);

    const cached = this.#cachedStatus(roomId, mainCommit);
    if (cached) return this.#withCaller({ ...cached, main }, callerAuthorId);

    const fresh = await this.#computeStatus(roomId, repoDir, ceiling, mainCommit, main);
    this.statusCache.set(roomId, { mainCommit, at: Date.now(), status: fresh });
    return this.#withCaller(fresh, callerAuthorId);
  }

  /**
   * What the room's own copy holds on disk, in the shape the status reports.
   *
   * @param repoDir - The room's main checkout.
   * @param ceiling - The room home directory git's search may not climb past.
   */
  async #readMain(repoDir: string, ceiling: string): Promise<RoomMainStatus> {
    const state: RoomMainCheckoutState = await readMainCheckoutState(repoDir, ceiling);
    return {
      branch: state.branch,
      dirty: state.branch !== 'main' || state.strays.length > 0,
      strays: state.strays.slice(0, MAX_REPORTED_STRAYS),
      strayCount: state.strays.length,
    };
  }

  /**
   * The cached answer for this room, if it is still about the same `main` and
   * still young enough.
   *
   * @param roomId - The room.
   * @param mainCommit - What `main` points at right now.
   */
  #cachedStatus(roomId: string, mainCommit: string): RoomRepoStatus | null {
    const hit = this.statusCache.get(roomId);
    if (!hit) return null;
    // A merge moves `main`, so a stale entry cannot outlive the thing it is
    // most likely to be wrong about.
    if (hit.mainCommit !== mainCommit) return null;
    if (Date.now() - hit.at > STATUS_CACHE_MS) return null;
    return hit.status;
  }

  /**
   * Re-aim a cached answer at whoever is asking now.
   *
   * `mine` is the one field in the payload that is about the CALLER rather than
   * about the room, so a cache shared between two members would otherwise hand
   * the second one the first one's idea of which branch is theirs.
   *
   * @param status - The cached answer.
   * @param callerAuthorId - Who is asking.
   */
  #withCaller(status: RoomRepoStatus, callerAuthorId: string): RoomRepoStatus {
    return {
      ...status,
      branches: status.branches.map((branch) => ({
        ...branch,
        mine: branch.authorId === callerAuthorId,
      })),
    };
  }

  /**
   * Ask git everything, for one room at one commit.
   *
   * **Split out so it can be cached, and it needed to be.** The work here is
   * `2 + 3n` git spawns for `n` agent members — a branch probe, an ahead/behind
   * and a dirty check each — so a forty-member room is around a hundred and
   * twenty processes, serially, per call. `room_repo_status` is what task 2.4's
   * explorer badges poll, so that would have been paid on a timer, per viewer.
   * The cache is keyed on `main`'s own sha as well as on time, so the answer can
   * never survive the event most likely to change it.
   *
   * @param roomId - The room.
   * @param repoDir - Its main checkout.
   * @param ceiling - The room home directory git's search may not climb past.
   * @param mainCommit - What `main` points at.
   * @param main - What the room's own copy holds on disk, read fresh by the
   *   caller. Stored on the cached answer only so the shape is whole; every
   *   later read replaces it.
   */
  async #computeStatus(
    roomId: string,
    repoDir: string,
    ceiling: string,
    mainCommit: string,
    main: RoomMainStatus
  ): Promise<RoomRepoStatus> {
    const caps = await this.#requireCaps(roomId);
    const committedAt = await headCommittedAt(repoDir, ceiling);

    const tree = await listTree(repoDir, mainCommit, ceiling);
    let usedBytes = 0;
    for (const entry of tree.values()) usedBytes += entry.size;

    const branches: RoomBranchStatus[] = [];
    for (const member of this.#deps.listAgentMembers(roomId)) {
      const slug = RoomWorktreeManager.slugFor(member.displayName, member.agentPath);
      const branch = roomWorktreeBranch(slug);
      if (!(await hasLocalBranch(repoDir, branch, ceiling))) continue;
      const { ahead, behind } = await aheadBehind(repoDir, 'main', branch, ceiling);
      const worktreeDir = path.join(this.#deps.store.worktreesPath(roomId), slug);
      const hasWorktree = await directoryExists(worktreeDir);
      // A working copy git cannot read is unfinished work, never clean — the
      // same conservative direction `listStrandedWorktrees` takes, and for the
      // same reason: nothing here may decide that what it does not understand
      // is disposable.
      let dirty = false;
      if (hasWorktree) {
        try {
          dirty = await hasUncommittedChanges(worktreeDir, ceiling);
        } catch (err) {
          logger.warn('[rooms] could not read a room worktree for status; calling it unfinished', {
            roomId,
            worktree: slug,
            err,
          });
          dirty = true;
        }
      }
      branches.push({
        slug,
        branch,
        // Somebody's display name, rendered next to facts DorkOS states.
        agent: sanitizeIdentity(member.displayName) ?? 'an agent',
        authorId: member.authorId,
        // Re-aimed per caller by `withCaller`, because this is the one field in
        // the payload that is about who asked rather than about the room.
        mine: false,
        hasWorktree,
        ahead,
        behind,
        dirty,
        stranded: dirty || ahead > 0,
      });
    }

    return {
      mainCommit,
      mainCommittedAt: committedAt?.toISOString() ?? null,
      main,
      branches,
      strandedWorktrees: await this.#deps.listStrandedWorktrees(roomId),
      size: {
        usedBytes,
        maxRepoBytes: caps.maxRepoBytes,
        maxFileBytes: caps.maxFileBytes,
      },
    };
  }

  /**
   * The gates both verbs share, in the order they are asked.
   *
   * 1. **The feature is off** — an install-level fact, true regardless of who is
   *    asking, which is why `RoomRepoService.enable` asks it first too.
   * 2. **Not a member** — `ROOM_NOT_FOUND`, the same answer a room that does not
   *    exist gives. A room id is not a capability.
   * 3. **Archived** — an archived room gains no entries, so a merge into one
   *    could land in git and then have nowhere to be announced. Asked here, up
   *    front, rather than discovered after the commit.
   * 4. **No repo** — `NOT_A_PROJECT_ROOM`.
   *
   * @param roomId - The room.
   * @param callerAuthorId - Who is asking.
   * @returns The room.
   */
  #requireProjectRoom(roomId: string, callerAuthorId: string): Room {
    if (!this.#deps.enabled()) {
      throw new RoomError(
        'ROOM_REPOS_DISABLED',
        'Rooms cannot have files of their own on this install. Turn that back on in Settings first.'
      );
    }
    const room = this.#deps.requireMembership(roomId, callerAuthorId);
    if (room.archived) throw new RoomError('ROOM_ARCHIVED', 'This room is archived');
    if (
      (this.#owning
        ? readOwnedRoomRepoSource(this.#deps.store, this.#owning.db, roomId).row
        : this.#deps.store.getRow(roomId)) === null
    ) {
      throw new RoomError('NOT_A_PROJECT_ROOM', 'This room does not have files of its own.');
    }
    return room;
  }

  /**
   * The caps this repo was created under.
   *
   * From the sidecar rather than from config — see the module doc for why a
   * config change must not make an existing room's contents illegal.
   *
   * @param roomId - The room.
   * @throws {RoomError} `NOT_A_PROJECT_ROOM` when the sidecar has gone. The cache
   *   row said the room had files and the file-first truth disagrees, which the
   *   reconciler will resolve; until it does, the honest answer is the one the
   *   truth gives.
   */
  async #requireCaps(
    roomId: string,
    context?: InstallationRoomMutationContext
  ): Promise<RoomRepoCaps> {
    const sidecar = context
      ? await executeOriginalRoomRepoStoreRead(this.#deps.store, this.#owning!.db, context, roomId)
      : await this.#deps.store.readSidecar(roomId);
    if (!sidecar) {
      throw new RoomError('NOT_A_PROJECT_ROOM', 'This room does not have files of its own.');
    }
    return sidecar.caps;
  }

  /**
   * Whose branch this call is about, and whether the caller may say so.
   *
   * @param roomId - The room.
   * @param callerAuthorId - Who is asking.
   * @param worktree - The slug an operator named, if any.
   * @returns The branch, its slug, and the author the merge is credited to.
   */
  #resolveTarget(
    roomId: string,
    callerAuthorId: string,
    worktree: string | undefined
  ): { slug: string; branch: string; authorId: string; agentName: string } {
    const roster = this.#owning
      ? readRoomServiceRepoAgentRoster(this.#owning.rooms, this.#owning.db, roomId)
      : this.#deps.listAgentMembers(roomId);
    const members = roster.map((member) => ({
      ...member,
      slug: RoomWorktreeManager.slugFor(member.displayName, member.agentPath),
    }));

    if (worktree !== undefined) {
      // Naming somebody else's branch is the operator's affordance. An agent
      // that could do it would be publishing a colleague's unfinished work under
      // its own summary, which the room cannot tell apart afterwards.
      if (!this.#deps.isOwnerAuthor(callerAuthorId)) {
        throw new RoomError('OPERATOR_ONLY', 'Only you can merge somebody else’s working copy');
      }
      const named = members.find((member) => member.slug === worktree);
      if (!named) {
        throw new RoomError(
          'NOTHING_TO_MERGE',
          `No agent in this room works in ${worktree}. Check the room’s repo status for the working copies it has.`
        );
      }
      return {
        slug: named.slug,
        branch: roomWorktreeBranch(named.slug),
        authorId: named.authorId,
        agentName: named.displayName,
      };
    }

    const own = members.find((member) => member.authorId === callerAuthorId);
    if (!own) {
      throw new RoomError(
        'NOTHING_TO_MERGE',
        'You have no working copy in this room to merge. Only an agent that has worked in the room has one.'
      );
    }
    return {
      slug: own.slug,
      branch: roomWorktreeBranch(own.slug),
      authorId: own.authorId,
      agentName: own.displayName,
    };
  }

  /**
   * Every check that reads git, the merge itself, and the announcement — all
   * while holding the room's lane.
   *
   * @param room - The room, already authorized.
   * @param target - Whose branch is being merged.
   * @param rawSummary - The caller's own summary, unsanitized.
   */
  async #mergeUnderLock(
    room: Room,
    target: { slug: string; branch: string; authorId: string; agentName: string },
    rawSummary: string,
    context: InstallationRoomMutationContext
  ): Promise<RoomMergeResult> {
    const roomId = room.id;
    const roots = readInstallationRoomMutationRoots(context),
      repoDir = roots.repoPath,
      ceiling = roots.homePath;
    const caps = await this.#requireCaps(roomId, context);
    await checkInstallationRoomMutationTarget(context, repoDir);

    // The one dirty-main gate, shared with the human save path
    // (`room-main-checkout.ts`): two writers into one tree must agree about
    // what "somebody else has been writing here" means, or one of them
    // eventually writes on top of it.
    await assertMainCheckoutReady(repoDir, ceiling);

    if (!(await hasLocalBranch(repoDir, target.branch, ceiling))) {
      throw new RoomError(
        'NOTHING_TO_MERGE',
        'There is no work to merge yet — nothing has been committed in that working copy.'
      );
    }

    const worktreeDir = path.join(roots.homePath, 'worktrees', target.slug);
    // A branch whose working copy the reap removed has nothing to be dirty, and
    // its commits are still mergeable. Only an existing tree is asked.
    if (await directoryExists(worktreeDir)) {
      if (await hasUncommittedChanges(worktreeDir, ceiling)) {
        throw new RoomError(
          'UNCOMMITTED_WORK',
          'Your working copy has changes you have not committed. Commit them (or undo them), then merge.'
        );
      }
    }

    const { ahead, behind } = await aheadBehind(repoDir, 'main', target.branch, ceiling);
    if (behind > 0) {
      throw new RoomError('BEHIND_MAIN', behindMainMessage(behind, ahead));
    }
    if (ahead === 0) {
      throw new RoomError(
        'NOTHING_TO_MERGE',
        'Your branch holds nothing the room does not already have.'
      );
    }

    const mainCommit = await revParse(repoDir, 'main', ceiling);
    await this.#assertDeltaAllowed(repoDir, ceiling, mainCommit, target.branch, caps);

    const stat = await shortstat(repoDir, mainCommit, target.branch, ceiling);
    const summary = sanitizeIdentity(rawSummary, MERGE_SUMMARY_MAX_CHARS);
    const subject = summary ?? `Merge ${target.branch}`;

    await checkInstallationRoomMutationTarget(context, repoDir);
    requireInstallationRoomMutationTarget(context, repoDir);
    let commit: string;
    try {
      commit = await mergeNoFf(
        repoDir,
        target.branch,
        subject,
        {
          // Sanitized for the same reason the room's own labels are: this string
          // ends up inside a `-c user.name=` argument and then inside `git log`,
          // and a name carrying a newline is a name that can forge a header.
          name: sanitizeIdentity(target.agentName) ?? 'an agent',
          email: `${target.slug}@${AGENT_GIT_EMAIL_DOMAIN}`,
        },
        ceiling,
        context
      );
    } catch (err) {
      if (err instanceof MergeConflictError) {
        logger.warn('[rooms] a room merge was rolled back; main is unchanged', {
          roomId,
          branch: target.branch,
          err,
        });
        throw new RoomError(
          'MERGE_CONFLICT',
          'That merge would not go in cleanly, so nothing was changed. Run `git merge main` in your own working copy, sort it out there, and try again.'
        );
      }
      throw err;
    }

    // Past this line the work IS on main. If the announcement throws — the room
    // was archived in the window between the gate and here, which takes a
    // deliberate human act — it propagates, because a merge nobody was told
    // about is worse news than an error. The commit is not rolled back: a room's
    // repo is append-only, and undoing it is the one thing this domain cannot do.
    await checkInstallationRoomMutationTarget(context, repoDir);
    requireInstallationRoomMutationTarget(context, repoDir);
    const entry = this.#deps.announce(roomId, {
      text: mergeSentence(target.agentName, subject, stat),
      merge: {
        branch: target.branch,
        commit,
        files: stat.files,
        insertions: stat.insertions,
        deletions: stat.deletions,
      },
      subjectAuthorId: target.authorId,
    });

    await checkInstallationRoomMutationTarget(context, repoDir);
    await this.#recordLastMergeSeq(roomId, entry.seq, context);
    await checkInstallationRoomMutationTarget(context, repoDir);
    requireInstallationRoomMutationTarget(context, repoDir);
    // The commit is authored as the agent whose work it is; the audit log names
    // who MERGED it, from the caller's own scope (spec `audit-trail` PR2), so
    // an owner merging an agent's copy is not recorded as the agent.
    recordAudit({
      action: 'room.merged',
      operation: 'modify',
      target: {
        type: 'room-branch',
        id: target.branch,
        name: `${target.agentName}'s work`,
        containerId: roomId,
      },
      outcome: 'ok',
      // The short form: a full commit id is long hex, which the audit log's
      // redaction treats as a possible secret. Twelve characters is what git
      // itself shows, and is enough to find the commit.
      change: [{ field: 'main', after: commit.slice(0, 12) }],
      summary: `Merged ${target.agentName}'s work into the room (${stat.files} file${
        stat.files === 1 ? '' : 's'
      })`,
    });
    logger.info('[rooms] work merged into a room’s main', {
      roomId,
      branch: target.branch,
      commit,
      files: stat.files,
    });

    requireInstallationRoomMutationTarget(context, repoDir);
    return {
      branch: target.branch,
      commit,
      files: stat.files,
      insertions: stat.insertions,
      deletions: stat.deletions,
      seq: entry.seq,
    };
  }

  /**
   * Refuse work that must not enter the room's tree, before any of it does.
   *
   * Run against the BRANCH's whole tree compared with `main`'s, which is exactly
   * the delta the merge will apply — the branch already contains `main`
   * (`BEHIND_MAIN` saw to that), so its tree is what `main` will hold. Two of the
   * three checks are per-changed-file and the third is a total:
   *
   * - **Symlinks** are checked only where they are NEW or CHANGED (spec §3.6
   *   validates the incoming delta). A link that is already in `main` blocks
   *   nothing; refusing on it would wedge every future merge over something
   *   nobody in this call did.
   * - **File size** likewise: an over-cap file already in the tree is history,
   *   and a cap that was raised and lowered again must not make the room
   *   unmergeable.
   * - **Repo size** is the total, because that is what the cap means.
   *
   * @param repoDir - The room's main checkout.
   * @param ceiling - The room home directory git's search may not climb past.
   * @param mainCommit - The commit `main` points at.
   * @param branch - The branch being merged.
   * @param caps - The room's frozen ceilings.
   */
  async #assertDeltaAllowed(
    repoDir: string,
    ceiling: string,
    mainCommit: string,
    branch: string,
    caps: RoomRepoCaps
  ): Promise<void> {
    const before = await listTree(repoDir, mainCommit, ceiling);
    const after = await listTree(repoDir, branch, ceiling);

    let totalBytes = 0;
    const changed: TreeEntry[] = [];
    for (const entry of after.values()) {
      totalBytes += entry.size;
      const previous = before.get(entry.path);
      if (!previous || previous.sha !== entry.sha || previous.mode !== entry.mode) {
        changed.push(entry);
      }
    }

    for (const entry of changed) {
      // **A gitlink is refused before anything else looks at it**, because
      // nothing else CAN: it names a commit in a repository that is not this
      // one, so there is no blob to size, no target to resolve and no content to
      // inspect. It reached `main` unchecked while `listTree` was dropping
      // non-blobs — it appeared in neither tree, so it was never in the delta.
      // A room's files are the room's; a pointer at somebody else's repository
      // is a dependency every member would have to fetch from a place this
      // room knows nothing about.
      if (entry.mode === GITLINK_MODE) {
        throw new RoomError(
          'SUBMODULE_NOT_ALLOWED',
          `\`${entry.path}\` is a link to another git repository (a submodule). A room's files have to be the room's own — copy in what you need, or share the other repository another way.`
        );
      }
      if (entry.mode === SYMLINK_MODE) {
        const target = await readBlob(repoDir, entry.sha, ceiling);
        if (symlinkLeavesRepo(entry.path, target)) {
          throw new RoomError(
            'SYMLINK_ESCAPES_REPO',
            `\`${entry.path}\` is a shortcut pointing outside the room’s files (at \`${target}\`). Copy what you need into the room instead — a shortcut only works on the computer that made it.`
          );
        }
      }
      if (entry.size > caps.maxFileBytes) {
        throw new RoomError(
          'FILE_TOO_LARGE',
          `\`${entry.path}\` is ${describeBytes(entry.size)}, and this room’s limit for one file is ${describeBytes(caps.maxFileBytes)}. Attach big files to a message instead — that is what attachments are for.`
        );
      }
    }

    if (totalBytes > caps.maxRepoBytes) {
      throw new RoomError(
        'REPO_CAP_EXCEEDED',
        `This would take the room’s files to ${describeBytes(totalBytes)}, past its ${describeBytes(caps.maxRepoBytes)} limit. Remove what is no longer needed, or attach large files to a message instead.`
      );
    }
  }

  /**
   * Point the sidecar at the entry that announced this merge.
   *
   * Best-effort by design. The merge has landed and the room has been told; a
   * sidecar write that fails costs the explorer a refresh hint, and throwing
   * here would report a merge that did happen as one that did not. The
   * reconciler rebuilds the row from the file either way.
   *
   * @param roomId - The room.
   * @param seq - The announcing entry's seq.
   */
  async #recordLastMergeSeq(
    roomId: string,
    seq: number,
    context: InstallationRoomMutationContext
  ): Promise<void> {
    try {
      const sidecar = await executeOriginalRoomRepoStoreRead(
        this.#deps.store,
        this.#owning!.db,
        context,
        roomId
      );
      if (!sidecar) return;
      await executeOriginalRoomRepoStoreWrite(this.#deps.store, this.#owning!.db, context, {
        ...sidecar,
        lastMergeSeq: seq,
      });
    } catch (err) {
      logger.warn('[rooms] could not record a room’s last merge; the merge itself is fine', {
        roomId,
        seq,
        err,
      });
    }
  }
}

/**
 * The sentence the room posts about a merge.
 *
 * Its own function so the copy is one string that tests can pin, and so the
 * summary is interpolated in exactly one place.
 *
 * @param agentName - Whose work landed.
 * @param summary - Their own sanitized summary.
 * @param stat - What the merge touched.
 */
function mergeSentence(
  agentName: string,
  summary: string,
  stat: { files: number; insertions: number; deletions: number }
): string {
  const who = sanitizeIdentity(agentName) ?? 'An agent';
  return `${who} merged: ${summary} — ${plural(stat.files, 'file')}, +${stat.insertions}/−${stat.deletions}`;
}

/**
 * `1 commit` / `3 commits` — the small grammar the refusals need.
 *
 * @param count - How many.
 * @param noun - The singular noun.
 */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * A byte count as a person reads it.
 *
 * Deliberately coarse: the refusal is about "too big", and `5 MB` says that
 * where `5,242,880 bytes` makes a reader do arithmetic.
 *
 * @param bytes - The count.
 */
function describeBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/**
 * Spellings of `.git` that a case-insensitive or 8.3-aware filesystem opens as
 * the real thing.
 *
 * `.git` is compared **lower-cased**, which is the whole of the first two
 * entries: APFS and NTFS are case-insensitive by default, so `.GIT/config` and
 * `.Git/hooks/pre-commit` open exactly the file `.git/config` opens. A
 * case-blind comparison here let both through end to end — into `repo/`, the
 * server-owned checkout where `.git` is a real directory and `.git/config` is
 * the COMMON directory shared by every worktree of the room.
 *
 * The last two are NTFS's other doors to the same place: a trailing dot is
 * stripped by the Win32 path layer, and `git~1` is the short (8.3) alias
 * Windows generates for `.git`. Both are refused for the same reason git itself
 * refuses them in `.gitmodules` paths — the name that reaches the filesystem is
 * not the name in the tree.
 */
const GIT_DIR_SPELLINGS: readonly string[] = ['.git', '.git.', 'git~1'];

/**
 * Whether a symlink stored at `entryPath` points anywhere but inside the room's
 * own files.
 *
 * **Purely lexical, and it has to be.** Resolving against the real filesystem
 * would ask where the link points on THIS machine right now — but the tree is
 * about to be shared with every other checkout of this repo, and a link that
 * lands inside the repo here can land outside it there. The question is about
 * the path, so the path is what is answered.
 *
 * Five ways out, and all five are refused: an absolute POSIX path, a
 * Windows-style drive path, a UNC share, a relative path that climbs past the
 * root, and a path into the repository's own git directory — which is not one
 * of the room's files and is the one place a link could reach git's own
 * configuration and its hooks.
 *
 * **Separators are normalized BEFORE any of the five run, and the order is a
 * fix rather than a tidy-up.** The absolute test used to read the RAW target,
 * so a Windows-absolute `\etc\passwd` and a UNC `\\server\share\x` both failed
 * `startsWith('/')`, and only THEN were their backslashes turned into slashes —
 * by which point nothing was left to catch them. One normalization, then five
 * questions, all asked of the same string.
 *
 * @param entryPath - Where the link lives, relative to the repo root.
 * @param target - What it points at, as stored in the blob.
 * @returns `true` when the link leaves the room's files.
 */
export function symlinkLeavesRepo(entryPath: string, target: string): boolean {
  // FIRST, so every test below sees one separator. A UNC path (`\\server\x`)
  // becomes `//server/x` and is caught by the absolute test, which is exactly
  // what it is.
  const normalized = target.replaceAll('\\', '/');
  if (normalized.startsWith('/')) return true;
  if (/^[A-Za-z]:\//.test(normalized)) return true;

  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entryPath), normalized));
  if (resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/')) return true;

  // Lower-cased: on APFS and NTFS, `.GIT/config` opens `.git/config`.
  const lowered = resolved.toLowerCase();
  return GIT_DIR_SPELLINGS.some(
    (spelling) => lowered === spelling || lowered.startsWith(`${spelling}/`)
  );
}

/**
 * Whether a path is a directory that exists.
 *
 * @param dir - The path to check.
 */
async function directoryExists(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

function sameMergeTarget(
  left: { slug: string; branch: string; authorId: string; agentName: string },
  right: { slug: string; branch: string; authorId: string; agentName: string }
): boolean {
  return (
    left.slug === right.slug &&
    left.branch === right.branch &&
    left.authorId === right.authorId &&
    left.agentName === right.agentName
  );
}
