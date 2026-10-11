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
import { sameMergeTarget, type RoomMergeServiceDeps } from './merge/room-merge-data.js';
export type { RoomMergeServiceDeps } from './merge/room-merge-data.js';
export { symlinkLeavesRepo } from './merge/room-merge-data.js';
import { promises as fs } from 'node:fs';
import type { Room } from '@dorkos/shared/room-schemas';
import type { RoomMergeResult, RoomRepoCaps, RoomRepoStatus } from '@dorkos/shared/room-repo';
import { MAX_REPORTED_ROOM_STRAYS } from '@dorkos/shared/room-repo';
import { RoomError } from '../data/room-errors.js';
import { readOwnedRoomRepoSource, executeOriginalRoomRepoStoreRead } from './room-repo-store.js';
import { RoomWorktreeManager, roomWorktreeBranch } from './room-worktree-manager.js';
import type { RoomRepoMutex } from './room-repo-mutex.js';

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

import {
  requireRoomServiceFileWriteOwner,
  requireRoomServiceRepoWriteCurrent,
  readRoomServiceRepoAgentRoster,
} from '../room-service.js';
import { requireInstallationFileWritesOwner } from '../../canvas/doc-channel/writes/installation-file-writes.js';
import {
  requireInstallationRoomWrites,
  readInstallationRoomFileWriteOwner,
  withRecognizedInstallationRoomMerge,
  readInstallationRoomRepoMutationContext,
  readInstallationRoomNativeMergeMutationContext,
  type InstallationRoomMutationContext,
} from '../../canvas/doc-channel/writes/installation-room-writes.js';
import {
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
} from '../../connectors/principal/runtime-principal-service.js';
import { DocChannelNotFoundError } from '../../canvas/doc-channel/authorization.js';

import {
  createIsolatedRoomMergeMutation,
  mergeUnderLock as originalMutationMergeUnderLock,
} from './merge/room-merge-mutation.js';
const originalRoomMergeMutation = createIsolatedRoomMergeMutation();
/** Read only the actual constructor-private mutation view before an operation. */
export const readOriginalRoomMergeMutationView: typeof originalRoomMergeMutation.read =
  originalRoomMergeMutation.read;
const originalRoomMergeMutationApply = Reflect.apply;
const originalRoomMergeViewFreeze = Object.freeze;
import {
  createIsolatedRoomMergeStatus,
  status as originalStatusStatus,
} from './merge/room-merge-status.js';
const originalRoomMergeStatus = createIsolatedRoomMergeStatus();
/** Read only the actual constructor-private status view before an operation. */
export const readOriginalRoomMergeStatusView: typeof originalRoomMergeStatus.read =
  originalRoomMergeStatus.read;
const originalRoomMergeStatusApply = Reflect.apply;
import { createIsolatedRoomMergeOwnerCustody } from './merge/room-merge-owner-custody.js';
import type {
  RoomMergeOwningConstruction,
  NativeMergeOperation,
} from './merge/room-merge-owner-custody.js';
const originalRoomMergeCustody = createIsolatedRoomMergeOwnerCustody();
const { nativeMergeOperations, originalMergeServices, originalMergeStoreOperations } =
  originalRoomMergeCustody;
/** Require the Room merge service's exact original owner dependencies. */
export const requireRoomMergeServiceOwner: typeof originalRoomMergeCustody.requireRoomMergeServiceOwner =
  originalRoomMergeCustody.requireRoomMergeServiceOwner;
/** Require the original runtime registry used by Room merge construction. */
export const requireRoomMergeRegistryConstruction: typeof originalRoomMergeCustody.requireRoomMergeRegistryConstruction =
  originalRoomMergeCustody.requireRoomMergeRegistryConstruction;
/** Execute a merge through the original Room HTTP caller. */
export const executeRoomHttpMerge: typeof originalRoomMergeCustody.executeRoomHttpMerge =
  originalRoomMergeCustody.executeRoomHttpMerge;
/** Execute a merge through the original native Room operation. */
export const executeRoomNativeMerge: typeof originalRoomMergeCustody.executeRoomNativeMerge =
  originalRoomMergeCustody.executeRoomNativeMerge;
/** Fixed private operation recognition, never a caller-supplied currentness function. */
export const requireOriginalRoomNativeMergeCurrent: typeof originalRoomMergeCustody.requireOriginalRoomNativeMergeCurrent =
  originalRoomMergeCustody.requireOriginalRoomNativeMergeCurrent;
/** Same original still-awaited private merge operation; no Store DTO or namespace alone grants this lookup. */
export const readOriginalRoomMergeStoreOperation: typeof originalRoomMergeCustody.readOriginalRoomMergeStoreOperation =
  originalRoomMergeCustody.readOriginalRoomMergeStoreOperation;
/** Route captures only through the actual constructor-owned service and verified HTTP composition. */
export const captureRoomMergeHttpOperation: typeof originalRoomMergeCustody.captureRoomMergeHttpOperation =
  originalRoomMergeCustody.captureRoomMergeHttpOperation;

/** Merging work into a room's `main`, and reporting what its repo holds. */
export class RoomMergeService {
  readonly #statusKey = originalRoomMergeViewFreeze({});
  readonly #mutationKey = originalRoomMergeViewFreeze({});
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
    /** Construct the fixed private mutation view with original live dependency reads. */
    function createMutationView(mutationRuntime: RoomMergeService) {
      return originalRoomMergeViewFreeze({
        AGENT_GIT_EMAIL_DOMAIN,
        directoryExists,
        get deps() {
          return mutationRuntime.#deps;
        },
        get owning() {
          return mutationRuntime.#owning;
        },
        get requireCaps() {
          const fn = mutationRuntime.#requireCaps;
          return (roomId: string, ...args: [context?: InstallationRoomMutationContext]) =>
            originalRoomMergeMutationApply(fn, mutationRuntime, [roomId, ...args]);
        },
      });
    }
    originalRoomMergeMutation.register(this.#mutationKey, createMutationView(this));
    /** Construct the fixed private status view with original live cache and dependency reads. */
    function createStatusView(statusRuntime: RoomMergeService) {
      return originalRoomMergeViewFreeze({
        STATUS_CACHE_MS,
        MAX_REPORTED_STRAYS,
        get deps() {
          return statusRuntime.#deps;
        },
        get statusCache() {
          return statusRuntime.statusCache;
        },
        directoryExists,
        get requireProjectRoom() {
          const fn = statusRuntime.#requireProjectRoom;
          return (roomId: string, callerAuthorId: string) =>
            originalRoomMergeStatusApply(fn, statusRuntime, [roomId, callerAuthorId]);
        },
        get requireCaps() {
          const fn = statusRuntime.#requireCaps;
          return (roomId: string, ...args: [context?: InstallationRoomMutationContext]) =>
            originalRoomMergeStatusApply(fn, statusRuntime, [roomId, ...args]);
        },
      });
    }
    originalRoomMergeStatus.register(this.#statusKey, createStatusView(this));
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
    return originalStatusStatus(this.#statusKey, roomId, callerAuthorId);
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
    return originalMutationMergeUnderLock(this.#mutationKey, room, target, rawSummary, context);
  }
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
