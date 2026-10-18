/**
 * Rooms: read state, the rooms graph, remote community mirrors and
 * subscriptions, room files and worktrees, session binding repair, and the
 * local community.
 *
 * Moved out of `index.ts` unchanged; it runs at the same point in `start()`.
 *
 * @module startup/steps/rooms
 */
import { wireDirectChats } from '../../services/rooms/direct-chat/index.js';
import {
  ReadCursorService,
  setReadCursorService,
} from '../../services/core/read-cursor-service.js';
import { ReadCursorStore } from '../../services/core/read-cursor-store.js';
import type { ConnectorRuntimePrincipalService } from '../../services/connectors/principal/runtime-principal-service.js';
import { LocalRoomAttachmentStore } from '../../services/rooms/attachments/local-room-attachment-store.js';
import { RemoteRoomSubscriptionBridge } from '../../services/communities/remote/remote-room-subscription-bridge.js';
import {
  createRoomSubsystem,
  setRoomService,
  resolveOperatorAuthor,
  setWelcomeBackGreeter,
  setRoomInternals,
  setRoomAttachmentStores,
  setRoomRepoService,
  setRoomFilesService,
  setRoomFileEditor,
  setRoomWorktreeManager,
  setRoomMergeService,
} from '../../services/rooms/index.js';
import { CommunityOutboxRuntime } from '../../services/communities/remote/community-outbox-runtime.js';
import {
  getRemoteCommunityAdapter,
  publishRemoteCommunityDeliveryChanges,
  setRemoteCommunityEnrollmentStore,
  setRemoteCommunityDeliveryProjection,
  setRemoteCommunityDeliveryRetry,
  setRemoteCommunityLocalAgentResolver,
  getRemoteWakePolicy,
  getRemotePairingService,
  getRemoteConnectionStore,
  setRemoteCommunityLifecycle,
} from '../../services/communities/remote/state.js';
import { isCurrentLocalMeshAgent } from '../../services/communities/remote/local-agent-authority.js';
import { spaceReachable } from '../../middleware/spaces-enabled.js';
import { RemoteRedactionSync } from '../../services/communities/remote/remote-redaction-sync.js';
import { RemoteRoomSubscriptionRuntime } from '../../services/communities/remote/remote-room-subscription-runtime.js';
import { AgentAvailabilityRuntime } from '../../services/communities/remote/availability/agent-availability-runtime.js';
import { env } from '../../env.js';
import { setRemoteCommunitySubscriptionProbe } from '../../routes/test-control.js';
import { logger } from '../../lib/logger.js';
import { readOperatorDisplayName } from '../../services/core/config/operator-display-name.js';
import {
  RoomRepoStore,
  RoomRepoMutex,
  RoomRepoService,
  readRoomRepoConfig,
  ROOM_MD_FILENAME,
  RoomFilesService,
  RoomFileEditor,
  RoomWorktreeManager,
  RoomMergeService,
  RoomRepoReconciler,
} from '../../services/rooms/repo/index.js';
import { readOwnerAccount } from '../../services/core/auth/index.js';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';
import path from 'path';
import { setAgentHomeRegistry, canonicalDir } from '../../services/core/agent-identity/index.js';
import {
  setAgentSessionSources,
  getMessageQueueStore,
  getStagedContextStore,
  reconcileSessionRows,
} from '../../services/session/index.js';
import { roomWorktreesOfAgent } from '../../services/runtimes/claude-code/migrate-room-transcripts.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import { runsTeammateTurns } from '../../services/rooms/limits/teammate-turn.js';
import { agentRuntimeTypeFrom } from '../../services/runtimes/shared/resolve-agent-runtime-type.js';
import {
  followSessionRekeys,
  repairRoomSessionBindings,
} from '../../services/rooms/session-bindings/room-session-convergence.js';
import { inventorySessionIds } from '../../services/runtimes/claude-code/sessions/session-inventory.js';
import { registerLocalCommunity } from '../../services/communities/index.js';
import type { OpenConfigAndDatabaseResult } from './config-and-database.js';
import type { ClaimDataDirectoryResult } from './data-directory.js';
import type { ServerRefs } from '../server-refs.js';

/** What {@link wireRooms} reads from the startup steps before it. */
export interface WireRoomsInput {
  db: OpenConfigAndDatabaseResult['db'];
  dorkHome: ClaimDataDirectoryResult['dorkHome'];
}

/**
 * Wire the rooms subsystem and register the local community.
 *
 * @param refs - The server's live references, which shutdown reads.
 * @param built - What the steps before this one built.
 */
export async function wireRooms(refs: ServerRefs, built: WireRoomsInput) {
  const { db, dorkHome } = built;
  // Rooms subsystem (spec `rooms`, ADR 260726-170125) — channels, DMs and
  // threads. Unconditional: a room is a durable store plus an in-process
  // broadcaster, so an install with no rooms in it costs one object graph and
  // no background work. A post now triggers whoever it addresses, bounded by
  // the cascade guard (`rooms.maxAgentDepth`, ADR 260726-170127).
  // Read state (team-room-home §D4). Unconditional and outside the rooms
  // subsystem on purpose: the same table answers for rooms, agent sessions and
  // the inbox, so wiring it from the rooms graph would have made two of the
  // three depend on a domain they have nothing to do with. Built BEFORE the
  // rooms graph because rooms read and write it — the room list's unread badge
  // and every person's place in a room come from here.
  const readCursorService = new ReadCursorService(new ReadCursorStore(db));
  setReadCursorService(readCursorService);

  const docChannelRuntimePrincipals: { current?: ConnectorRuntimePrincipalService } = {};
  const roomAttachmentBytes = new LocalRoomAttachmentStore(dorkHome);
  // Both the worker and native stream lifecycle must remain inert until Mesh
  // has reconciled the on-disk manifest registry for this process boot.
  refs.meshStartupReconciled = false;
  const remoteCommunityBridge: { current?: RemoteRoomSubscriptionBridge } = {};
  const {
    service: roomService,
    store: roomStore,
    attachments: roomAttachmentRows,
    authors: roomAuthors,
    bridges: roomBridges,
    welcomeBack: welcomeBackGreeter,
    canvasDocuments,
  } = createRoomSubsystem({
    db,
    runtimePrincipalCurrent: (proof) =>
      docChannelRuntimePrincipals.current?.isPrincipalCurrent(proof) ?? false,
    readCursors: readCursorService,
    createMirrorRuntime: ({ store, authors, attachments }) => {
      refs.remoteCommunityRuntime = new CommunityOutboxRuntime({
        db,
        roomStore: store,
        authors,
        attachmentRows: attachments,
        attachmentBytes: roomAttachmentBytes,
        adapters: getRemoteCommunityAdapter,
        isLocalAgentCurrent: (localAgentId) =>
          refs.meshStartupReconciled && refs.meshCore
            ? isCurrentLocalMeshAgent(refs.meshCore, localAgentId)
            : false,
        changes: { changed: publishRemoteCommunityDeliveryChanges },
        // Bound below, once the sync exists: it rebuilds search and deletes files for a
        // revoked mirror whose content the store just deleted.
        mirrorPurged: (purge) => refs.remoteRedactionSync?.afterPurge(purge),
        reachable: spaceReachable,
      });
      return {
        mirrorAccess: refs.remoteCommunityRuntime.mirrorAccess,
        mirrorWrites: refs.remoteCommunityRuntime.mirrorWrites,
      };
    },
  });
  setRoomService(roomService);
  if (!refs.remoteCommunityRuntime) throw new Error('Remote community runtime was not composed');
  setRemoteCommunityEnrollmentStore(refs.remoteCommunityRuntime.enrollments);
  setRemoteCommunityDeliveryProjection(refs.remoteCommunityRuntime.projection);
  setRemoteCommunityDeliveryRetry((input) => refs.remoteCommunityRuntime!.retryNow(input));
  // The public native-community API names an agent by its Mesh manifest id.
  // Resolve that id through Mesh to its server-only project path before the
  // author registry mints or reads the local room principal; neither the
  // browser nor a remote community supplies a path or opaque author id.
  const resolveRemoteLocalAgent = (localAgentId: string) => {
    const agent = refs.meshCore?.get(localAgentId);
    const projectPath = refs.meshCore?.getProjectPath(localAgentId);
    if (!agent || !projectPath) return null;
    const author = roomAuthors.resolveAgent(projectPath, agent.displayName ?? agent.name);
    return { authorId: author.id, displayName: author.displayName };
  };
  setRemoteCommunityLocalAgentResolver(resolveRemoteLocalAgent);
  remoteCommunityBridge.current = new RemoteRoomSubscriptionBridge(
    refs.remoteCommunityRuntime.mirrors,
    roomService,
    refs.remoteCommunityRuntime.enrollments,
    (localAgentId) => resolveRemoteLocalAgent(localAgentId)?.authorId ?? null,
    undefined,
    refs.remoteCommunityRuntime.outbox,
    refs.remoteCommunityRuntime,
    spaceReachable
  );
  // Who in each space may wake an agent here (spec `official-community-space` D9). It starts
  // loading now, long before the streams start below, and wakes nobody until it has.
  remoteCommunityBridge.current.useWakeGate(getRemoteWakePolicy());
  // Which enrolled agents may take a teammate's turn (DOR-2955): those whose next turn starts on a
  // runtime that holds it to every limit. An agent Mesh cannot name takes none.
  remoteCommunityBridge.current.useTeammateRuntimes((localAgentId) => {
    const agent = refs.meshCore?.get(localAgentId);
    const projectPath = refs.meshCore?.getProjectPath(localAgentId);
    if (!agent || !projectPath) return false;
    return runsTeammateTurns(agentRuntimeTypeFrom(projectPath, agent.runtime));
  });
  refs.remoteRedactionSync = new RemoteRedactionSync({
    db,
    mirrors: refs.remoteCommunityRuntime.mirrors,
    readers: getRemoteCommunityAdapter,
    attachmentBytes: roomAttachmentBytes,
    publishRevisions: (localRoomId, seqs) => roomService.publishEntryRevisions(localRoomId, seqs),
  });
  refs.remoteCommunitySubscriptions = new RemoteRoomSubscriptionRuntime({
    bridge: remoteCommunityBridge.current,
    enrollments: refs.remoteCommunityRuntime.enrollments,
    adapters: getRemoteCommunityAdapter,
    resolveConnectionAccess: async (communityRef, ownerAuthorId) =>
      (await getRemotePairingService().status(communityRef, ownerAuthorId)).access,
    readOnlyConnections: () => getRemoteConnectionStore().readOnlyConnections(),
    resolveLocalAgentAuthor: (localAgentId) =>
      resolveRemoteLocalAgent(localAgentId)?.authorId ?? null,
    isReady: () => refs.meshStartupReconciled && refs.meshCore !== undefined,
    // Messages deleted, removed, or erased on a Community server leave this machine's mirror
    // and its search index too (member erasure task 2.1).
    redactions: refs.remoteRedactionSync,
  });
  setRemoteCommunityLifecycle(refs.remoteCommunitySubscriptions);
  // Each space an enrolled agent belongs to hears that it is there, while this computer is on
  // (specs/server-merge step 3, DOR-2878). Started beside the streams, once Mesh has reconciled.
  refs.remoteAgentAvailability = new AgentAvailabilityRuntime({
    enrollments: refs.remoteCommunityRuntime.enrollments,
    spaces: getRemoteCommunityAdapter,
    // Every agent this app runs is on this person's computer. An app running as an agent
    // computer (specs/everything-is-a-space A8, DOR-2748) answers 'agent-computer' here.
    runsOn: () => 'computer',
    reachable: spaceReachable,
    resolveConnectionAccess: async (communityRef, ownerAuthorId) =>
      (await getRemotePairingService().status(communityRef, ownerAuthorId)).access,
    onConnectionChange: (listener) => getRemoteConnectionStore().onChange(listener),
    onFailing: (communityRef, error) =>
      logger.debug('[Communities] Agent availability reports are failing', {
        communityRef,
        error: String(error),
      }),
  });
  // Native room streams need Mesh's trusted manifest-to-path registry. Start
  // them only after startup reconciliation below, so a cold boot never treats
  // an as-yet-unavailable registry as an authoritative empty agent directory.
  if (env.DORKOS_TEST_RUNTIME) {
    setRemoteCommunitySubscriptionProbe(
      (ref, roomId) =>
        refs.remoteCommunitySubscriptions?.observation(
          ref as import('@dorkos/shared/community-adapter').CommunityRef,
          roomId,
          resolveOperatorAuthor(roomAuthors).id
        ) ?? null
    );
  }
  // What your agents may say when you come back (team-room-home §D5.2). The
  // read-state route is what tells it somebody is here, so it is registered
  // beside the service that route already reaches for.
  setWelcomeBackGreeter(welcomeBackGreeter);
  setRoomInternals(roomBridges, roomAuthors);
  // Where a room's files live is chosen HERE and nowhere else: the routes depend
  // on the `RoomAttachmentStore` interface and never build a path, so the day
  // those bytes live somewhere other than this machine, this line is what
  // changes. Same doctrine as the avatar store below.
  setRoomAttachmentStores({
    attachments: roomAttachmentBytes,
    rows: roomAttachmentRows,
  });
  logger.info('[Rooms] RoomService registered');

  // The install owner's author id, resolved per call (an install becomes owned
  // partway through its life, so a value captured at boot would go stale). The
  // inbound chat bridge acts as this author for its lifecycle writes
  // (chats-as-channels §3.5, §10.9).
  const resolveOperatorAuthorId = (): string => resolveOperatorAuthor(roomAuthors).id;
  // Each agent's standing Direct chat with the person (rule S12, DOR-2997).
  const directChats = wireDirectChats({
    store: roomStore,
    authors: roomAuthors,
    rooms: roomService,
  });

  // The REAL name a bridged group sees prefixed on an operator's post (chats-
  // as-channels §6.7, DOR-899) — never the room registry's 'You'. One reader,
  // shared with the rooms domain's agent context (DOR-2458).
  const resolveOperatorDisplayName = readOperatorDisplayName;

  // A room's own files (spec `project-rooms` §3). Same doctrine as the
  // attachment store above: WHERE they live is decided here and nowhere else,
  // and `dorkHome` is handed in rather than resolved downstream —
  // `os.homedir()` is banned in this tree (Hard Rule 3).
  //
  // Unconditional, like the rooms graph itself: the store is an object and the
  // reconciler is one unref'd timer, and a room only gains files when the
  // person gives it some. Every config value below is read PER CALL, so
  // turning the feature on or changing a cap binds the next request rather
  // than the next server start.
  const roomRepoStore = new RoomRepoStore(db, dorkHome);
  // ONE queue for the whole install, shared by every server-side write to a
  // room's repo. Enabling a repo and merging into it take the same lane, keyed
  // by room: enable is a check-then-act that two callers could otherwise both
  // win (destroying the first repo's seed commit), and two merges in one
  // checkout is the contention one-writer forbids. Two rooms never wait on each
  // other.
  const roomRepoMutex = new RoomRepoMutex();
  const roomRepoService = new RoomRepoService({
    store: roomRepoStore,
    mutex: roomRepoMutex,
    queueWaitMs: () => readRoomRepoConfig().mergeQueueWaitMs,
    enabled: () => readRoomRepoConfig().enabled,
    getRoom: (roomId, viewerAuthorId) => roomService.getRoom(roomId, viewerAuthorId),
    isOwnerAuthor: (authorId) => roomAuthors.isOwner(authorId, readOwnerAccount()?.id ?? null),
    // The person's own name from their profile, which is the only place a
    // real human name is stored on this machine — never the room registry's
    // label for them, which `bindOwner` fixes at 'You' forever (right in
    // their own window, bizarre in `git log`).
    operatorGitName: resolveOperatorDisplayName,
    caps: () => {
      const repo = readRoomRepoConfig();
      return {
        maxFileBytes: repo.maxFileBytes,
        maxRepoBytes: repo.maxRepoBytes,
        maxRoomMdBytes: repo.maxRoomMdBytes,
      };
    },
    // What may be SENT, as against what `caps` froze onto a room's sidecar
    // for what may be merged IN. Read per turn, like every other value here.
    maxRoomMdBytes: () => readRoomRepoConfig().maxRoomMdBytes,
    // The room's shared notes land on its canvas the moment it has any, pinned
    // so the twelve-document ceiling can never push them off. The path is
    // RELATIVE, exactly as the Room tab's Files section opens one: a document
    // with no working directory recorded is read back through the room's own
    // files route, which is the one route every member already has.
    pinRoomMd: (roomId, authorId) => {
      roomService.canvas.open(
        roomId,
        authorId,
        { type: 'file', sourcePath: ROOM_MD_FILENAME },
        { pinned: true }
      );
    },
  });
  setRoomRepoService(roomRepoService);
  // Reading those files back (spec §3.9). It shares the store and nothing
  // else: `hasRepo` already folds the feature flag in, so a room whose files
  // are switched off reads exactly as a room that never had any, and the size
  // ceiling is read per call so lowering it binds the next request.
  const roomFiles = new RoomFilesService({
    store: roomRepoStore,
    hasRepo: (roomId) => roomRepoService.hasRepo(roomId),
    maxFileBytes: () => readRoomRepoConfig().maxFileBytes,
  });
  setRoomFilesService(roomFiles);
  // And a person editing them (spec §3.10). It takes the SAME queue every other
  // server-side write to `repo/` takes, so a save and a merge can never be in
  // that tree at once, and the same `operatorGitName` seam, so a room's `git
  // log` reads with one voice whoever made the commit.
  setRoomFileEditor(
    new RoomFileEditor({
      store: roomRepoStore,
      mutex: roomRepoMutex,
      enabled: () => readRoomRepoConfig().enabled,
      queueWaitMs: () => readRoomRepoConfig().mergeQueueWaitMs,
      assertCanWriteFiles: (roomId, authorId) => roomService.assertCanWriteFiles(roomId, authorId),
      operatorGitName: resolveOperatorDisplayName,
      // A signed-in person's own name (spec `agent-home-desk` §7.1). The owner's
      // is their profile name, never the registry's 'You'; anybody else's is the
      // name the registry holds for their account.
      personName: (authorId) =>
        roomAuthors.isOwner(authorId, readOwnerAccount()?.id ?? null)
          ? resolveOperatorDisplayName()
          : (sanitizeIdentity(roomAuthors.getById(authorId)?.displayName ?? '') ?? null),
      // One quiet entry per person's change, in the room's own voice (§7.2).
      announce: (roomId, input) => roomService.postFileChangeEvent(roomId, input),
      uploadStagingRoot: () => path.join(dorkHome, '.temp', 'room-uploads'),
      files: roomFiles,
    })
  );
  // One standing working copy per (room, agent), and the reap that tidies away
  // the empty ones (spec `project-rooms` §3.4). It gets no timer of its own:
  // the reconciler below owns the single sweep, and therefore the single
  // overlap guard.
  const roomWorktrees = new RoomWorktreeManager({
    store: roomRepoStore,
    hasRepo: (roomId) => roomRepoService.hasRepo(roomId),
    listStrandedWorktrees: (roomId) => roomRepoService.listStrandedWorktrees(roomId),
    reapAfterDays: () => readRoomRepoConfig().worktreeReapDays,
    // The claim map is the only live record that an agent is mid-turn, and a
    // live room turn is granted its worktree and works on it by path. Without
    // this the sweep can delete the copy a turn is working on — a turn that
    // only reads leaves no mark on any timestamp.
    busyAgentPaths: () => roomService.listBusyAgentPaths(),
  });
  // Every room turn in a room with files is granted its agent's copy through
  // this manager before its context is built (`room-turn-place.ts`, spec
  // `agent-home-desk` §5.1).
  setRoomWorktreeManager(roomWorktrees);
  // Which folders are agent homes, for every identity read (spec
  // `agent-home-desk` §3.1). Each lookup is read per call off the live
  // registry (assigned later in boot), so an agent unregistered a moment ago is
  // nobody's home at once and nothing is cached across a registration.
  setAgentHomeRegistry({
    isRegisteredHome: (dir) => refs.meshCore?.getByPath(dir) !== undefined,
    listRegisteredHomes: () =>
      refs.meshCore?.listWithPaths().map((agent) => agent.projectPath) ?? [],
    // Canonically: a checkout path may be stored realpath'd while the turn
    // names it through a symlink, or the other way round.
    managedWorkspaceOwner: (dir) => {
      const target = canonicalDir(dir);
      const owned = refs.managedWorkspaces
        ?.list()
        .find(
          (ws) =>
            ws.owner?.kind === 'agent' &&
            (path.resolve(ws.path) === dir || canonicalDir(ws.path) === target)
        );
      return owned?.owner?.ref ?? null;
    },
    roomsDir: path.join(dorkHome, 'rooms'),
  });
  // Where else an agent's conversations are: session storage is derived per
  // working directory (ADR-0310), and room turns stood in their agent's copy of
  // the room's files until spec `agent-home-desk` moved them home. Claude Code's
  // transcripts are moved home at startup (below); Codex lists by the folder a
  // thread was first seen in and OpenCode cannot move a session, so the folders
  // those turns stood in stay scanned — a FROZEN list, read once at startup and
  // never grown, because no turn stands in a room's copy any more (§8.1).
  refs.frozenWorktrees = [];
  setAgentSessionSources({
    extraDirs: (agentPath) =>
      Promise.resolve(roomWorktreesOfAgent(refs.frozenWorktrees, agentPath)),
    boundSessionIds: (agentPath) =>
      Promise.resolve(runtimeRegistry.listSessionIdsForAgentPath(agentPath)),
  });
  // The only path work takes back into a room's `main` (spec §3.6). It writes
  // in `repo/` and nowhere else — an agent's own working copy has exactly one
  // writer and it is that agent — and it announces every merge through
  // `RoomService`, so a room's log keeps its single write path.
  const roomMerges = new RoomMergeService({
    store: roomRepoStore,
    mutex: roomRepoMutex,
    enabled: () => readRoomRepoConfig().enabled,
    mergeQueueWaitMs: () => readRoomRepoConfig().mergeQueueWaitMs,
    requireMembership: (roomId, authorId) => roomService.requireMembership(roomId, authorId),
    listAgentMembers: (roomId) => roomService.listAgentMembers(roomId),
    listStrandedWorktrees: (roomId) => roomRepoService.listStrandedWorktrees(roomId),
    announce: (roomId, input) => roomService.postMergeEvent(roomId, input),
    isOwnerAuthor: (authorId) => roomAuthors.isOwner(authorId, readOwnerAccount()?.id ?? null),
  });
  setRoomMergeService(roomMerges);
  // Rebuilds `room_repos` from the sidecars on disk, on the same five-minute
  // cadence the mesh and workspace reconcilers use (ADR-0043). It never deletes
  // a room's files — see its module doc for why an orphaned home directory is
  // reported and left standing, and the worktree manager's for the four gates
  // an agent's working copy has to fail before the reap may remove it.
  new RoomRepoReconciler(roomRepoStore, undefined, roomWorktrees).start();

  // A room's memory is its `room_sessions` binding, and the id in it moves: the
  // room mints a placeholder before the first turn and Claude Code renames the
  // session mid-turn. Follow the RENAME rather than the turn's return value —
  // the rename is announced the instant it happens, while the return value is
  // read once at the end of a turn that routinely lost the race (DOR-784).
  followSessionRekeys(roomStore);
  // Then fix, or report, what was stranded before this process started. Bounded
  // to rooms that have a binding and agents that run on claude-code, and
  // detached: a disk probe must not sit in front of the port opening. Renames
  // are recorded durably (DOR-1205), so a binding whose successor any earlier
  // process wrote down is rebound here; one with no recorded successor is
  // reported and left exactly as it is. Nothing is deleted, and nothing is
  // guessed.
  //
  // Gated on the claude-code runtime being in this process at all: the probe IS
  // its transcript reader, so without one there is no claude-code binding
  // anybody could judge, and a sweep that ran anyway would have to invent an
  // answer for every row.
  //
  // The same object is handed to the deep health check further down, so
  // `dorkos doctor --deep` and this sweep ask one probe and cannot answer
  // differently about one binding (DOR-805).

  if (refs.claudeRuntime) {
    const transcripts = refs.claudeRuntime.getTranscriptReader();
    refs.roomBindingTranscripts = {
      agentPathFor: (authorId) => {
        const record = roomAuthors.getById(authorId);
        return record?.kind === 'agent' ? record.naturalKey : null;
      },
      hasTranscript: async (agentPath, sessionId) =>
        (await transcripts.hasTranscript(agentPath, sessionId)).exists,
      neverRan: async (sessionId) =>
        !(await runtimeRegistry.resolveSessionRuntime(sessionId)).bound,
    };
    void repairRoomSessionBindings({ store: roomStore, ...refs.roomBindingTranscripts }).then(
      (report) => {
        // Every non-clean outcome, including the two that mean a repair did not
        // land (`refused`, `failed`) — a boot that quietly dropped those would
        // read exactly like a boot with nothing to fix.
        if (
          report.repaired > 0 ||
          report.stranded > 0 ||
          report.refused > 0 ||
          report.failed > 0 ||
          report.unreadable > 0
        ) {
          logger.info('[Rooms] checked room session bindings', { ...report });
        }
      },
      (err: unknown) => {
        logger.warn('[Rooms] could not check room session bindings', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    );

    // Same beat, same gate, same reason: reclaim the queued messages and held
    // words of sessions that vanished while this server was DOWN (DOR-1436).
    // The live sweep only ever sees the sessions a running process watched
    // disappear, so nothing else asks this question. Detached — it reads
    // directories, and startup is not the place to wait on a disk.
    const queueStore = getMessageQueueStore();
    const stagedStore = getStagedContextStore();
    if (!queueStore || !stagedStore) {
      // Unreachable in this host — both stores are injected above, right after
      // `createDb()` — and said out loud anyway, because a reconcile that
      // silently did not run is the one outcome nobody could tell from a
      // database with nothing to reclaim.
      logger.warn('[SessionRows] skipped the boot reconcile: the durable stores are not wired');
    } else {
      void reconcileSessionRows({
        queue: queueStore,
        staged: stagedStore,
        bindingsFor: (ids) => runtimeRegistry.getSessionBindings(ids),
        claudeCodeInventory: () => inventorySessionIds(transcripts.getProjectsRootSet()),
      }).then(
        (report) => {
          // Every outcome except the clean, complete, nothing-to-do one. A
          // partial delete and an unreadable inventory both mean rows are still
          // there, and a boot that logged nothing for them would read exactly
          // like a boot with nothing to reclaim.
          if (report.reaped > 0 || report.failedDeletes > 0 || !report.inventoryComplete) {
            logger.info('[SessionRows] checked what vanished sessions left behind', { ...report });
          }
        },
        (err: unknown) => {
          logger.warn('[SessionRows] could not check what vanished sessions left behind', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      );
    }
  }

  // The local community (spec `community-adapter` §8) — this machine's own rooms
  // behind the `CommunityAdapter` port. Registered unconditionally and first,
  // because the registry's guarantee is that `LOCAL_COMMUNITY` is always there:
  // every other community is additive and may fail to construct without taking
  // the server down, but the one backed by the store this process already holds
  // cannot be the missing one.
  await registerLocalCommunity({
    service: roomService,
    store: roomStore,
    authors: roomAuthors,
  });
  logger.info('[Communities] local community registered');
  return {
    docChannelRuntimePrincipals,
    roomService,
    roomStore,
    roomAuthors,
    roomBridges,
    canvasDocuments,
    resolveOperatorAuthorId,
    resolveOperatorDisplayName,
    directChats,
    roomRepoStore,
    roomWorktrees,
    roomMerges,
  };
}

/** What {@link wireRooms} hands the steps after it. */
export type WireRoomsResult = Awaited<ReturnType<typeof wireRooms>>;
