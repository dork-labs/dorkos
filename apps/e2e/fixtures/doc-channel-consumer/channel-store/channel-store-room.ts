/** Real protected-source fixture composition. No browser/page can select an actor or issuer. */

import { join } from 'node:path';

import { requireOriginalConsumerIdentity } from '../channel-store.js';
import { extendOriginalConsumerPhase } from './channel-store-phase-data.js';
/** Exact sequential original constructor phase; requires its inaccessible original key. */
export async function constructOriginalConsumerRoom(ownerKey: object) {
  const context = requireOriginalConsumerIdentity(ownerKey);
  const {
    vault,
    hostBootstrap,
    readOwnerAccount,
    createRoomSubsystem,
    setRoomService,
    RoomTurnBudget,
    createTurnBudgetLimits,
    RoomRepoStore,
    RoomRepoMutex,
    RoomRepoService,
    RoomFilesService,
    RoomFileEditor,
    RoomWorktreeManager,
    readRoomRepoConfig,
    ROOM_MD_FILENAME,
    DocChannelStore,
    InstallationFileWrites,
    readInstallationFileRoomWrites,
    stopInstallationFileWrites,
    readOperatorDisplayName,
    sanitizeIdentity,
    ApprovalService,
    createDocChannelHttpComposition,
    currentRoomDueServicePort,
    file,
    opened,
    db,
    installationId,
    principals,
  } = context;
  const budget = new RoomTurnBudget({
    db,
    limits: createTurnBudgetLimits(() => {
      throw new Error('Native fixture requires the original stored Room budget policy');
    }, db),
  });
  const rooms = createRoomSubsystem({ db, budget });
  context.ownedRooms = rooms; // Capture publication before any following constructor/callback.
  context.disposeRoomCanvas = rooms.service.canvas.dispose.bind(rooms.service.canvas);
  setRoomService(rooms.service); // SAME original subsystem before actor resolution or any Room route.
  const roomRepos = new RoomRepoStore(db, vault.root),
    approvals = new ApprovalService(db);
  // The protected interactive Room placement takes its editor and worktree
  // authority from the same installation owner, just as server/index.ts does.
  const roomMutex = new RoomRepoMutex();
  const channels = new DocChannelStore(db);
  context.httpConstructionStarted = true; // Unknown partial owner construction retains the native Db.
  const fileWrites = new InstallationFileWrites({ db, store: channels, roomRepos, roomMutex });
  context.stopHttpFileWrites = () => stopInstallationFileWrites(fileWrites, db, channels);
  const roomWriter = readInstallationFileRoomWrites(fileWrites, db, channels, roomRepos);
  const roomRepoService = new RoomRepoService(
    {
      store: roomRepos,
      mutex: roomMutex,
      queueWaitMs: () => readRoomRepoConfig().mergeQueueWaitMs,
      enabled: () => readRoomRepoConfig().enabled,
      getRoom: (id, viewer) => rooms.service.getRoom(id, viewer),
      isOwnerAuthor: (id) => rooms.authors.isOwner(id, readOwnerAccount()?.id ?? null),
      operatorGitName: readOperatorDisplayName,
      caps: () => {
        const repo = readRoomRepoConfig();
        return {
          maxFileBytes: repo.maxFileBytes,
          maxRepoBytes: repo.maxRepoBytes,
          maxRoomMdBytes: repo.maxRoomMdBytes,
        };
      },
      maxRoomMdBytes: () => readRoomRepoConfig().maxRoomMdBytes,
      pinRoomMd: (id, author) => {
        rooms.service.canvas.open(
          id,
          author,
          { type: 'file', sourcePath: ROOM_MD_FILENAME },
          { pinned: true }
        );
      },
    },
    {
      owner: fileWrites,
      writer: roomWriter,
      db,
      channels,
      rooms: rooms.service,
      roomStore: rooms.store,
    }
  );
  const roomFiles = new RoomFilesService({
    store: roomRepos,
    hasRepo: (id) => roomRepoService.hasRepo(id),
    maxFileBytes: () => readRoomRepoConfig().maxFileBytes,
  });
  const roomFileEditor = new RoomFileEditor({
    store: roomRepos,
    mutex: roomMutex,
    installationRoomWrites: roomWriter,
    enabled: () => readRoomRepoConfig().enabled,
    queueWaitMs: () => readRoomRepoConfig().mergeQueueWaitMs,
    assertCanWriteFiles: (id, author) => rooms.service.assertCanWriteFiles(id, author),
    operatorGitName: readOperatorDisplayName,
    personName: (id) =>
      rooms.authors.isOwner(id, readOwnerAccount()?.id ?? null)
        ? readOperatorDisplayName()
        : (sanitizeIdentity(rooms.authors.getById(id)?.displayName ?? '') ?? null),
    announce: (id, input) => rooms.service.postFileChangeEvent(id, input),
    uploadStagingRoot: () => join(vault.root, '.temp', 'room-uploads'),
    files: roomFiles,
  });
  const roomWorktreeManager = new RoomWorktreeManager(
    {
      store: roomRepos,
      hasRepo: (id) => roomRepoService.hasRepo(id),
      listStrandedWorktrees: (id) => roomRepoService.listStrandedWorktrees(id),
      reapAfterDays: () => readRoomRepoConfig().worktreeReapDays,
      busyAgentPaths: () => rooms.service.listBusyAgentPaths(),
    },
    {
      owner: fileWrites,
      writer: roomWriter,
      mutex: roomMutex,
      db,
      channels,
      rooms: rooms.service,
      roomStore: rooms.store,
    }
  );
  const http = createDocChannelHttpComposition({
    db,
    documents: rooms.canvasDocuments,
    rooms: rooms.service,
    roomStore: rooms.store,
    roomRepos,
    roomRepoService,
    roomFileEditor,
    roomWorktreeManager,
    owningFileWrites: { channels, fileWrites },
    approvals,
    installationId,
    nativeRuntimePrincipals: principals,
    roomConstruction: opened.serverNativeRoomConstruction,
    runtimePrincipalCurrent: (proof) => principals.isPrincipalCurrent(proof),
    revalidateRuntime: (proof) => principals.revalidatePrincipal(proof),
  });
  context.stopHttpFileWrites = http.stopFileWrites.bind(http); // Exact original installation drain before actor/configuration awaits.
  // Session scopes also own presence/token/current-operation resources, even without a Room scheduler.
  context.docOperationsClosed = false;
  context.stopDocOperations = currentRoomDueServicePort(http.service).stopPump;
  if (hostBootstrap) {
    // The hosted API uses the same original scope stream assembly as server/index.ts.
    const { DocChannelLiveBuffer } =
      await import('../../../../server/src/services/canvas/doc-channel/streams/live-buffer.js');
    const { DocScopeStream } =
      await import('../../../../server/src/services/canvas/doc-channel/streams/scope-stream.js');
    const { setDocScopeNotificationsFactory } =
      await import('../../../../server/src/services/canvas/doc-channel/streams/registry.js');
    const { subscribeCommittedDocEvents } =
      await import('../../../../server/src/services/canvas/doc-channel/committed-events.js');
    const streamAuthority = {
      resolveScope: (current: string) => rooms.canvasDocuments.lifecycle.resolveScope(current),
      requireScopeCurrent: (
        current: string,
        currentActor: import('../../../../server/src/services/canvas/doc-channel/authorization.js').DocChannelActor
      ): undefined => {
        http.authorization.requireScopeCurrent(current, currentActor);
        return undefined;
      },
      requireDocumentCurrent: (
        currentDocumentId: string,
        current: string,
        currentActor: import('../../../../server/src/services/canvas/doc-channel/authorization.js').DocChannelActor
      ): undefined => {
        if (http.authorization.requireCurrent(currentDocumentId, currentActor).scope !== current)
          throw new Error('Original hosted document stream scope changed');
        return undefined;
      },
    };
    const live = new DocChannelLiveBuffer(http.channels, streamAuthority);
    const scopes = new DocScopeStream(rooms.canvasDocuments, http.service, live, streamAuthority);
    const unsubscribe = subscribeCommittedDocEvents(db, (currentDocumentId) => {
      live.notifyCommitted(currentDocumentId);
      return undefined;
    });
    context.docNotificationsClosed = false;
    let notificationStop: Promise<void> | undefined;
    context.stopDocNotifications = () => {
      if (notificationStop) return notificationStop;
      notificationStop = Promise.resolve().then(() => {
        let failed = false,
          first: unknown;
        try {
          unsubscribe();
        } catch (cause) {
          failed = true;
          first = cause;
        }
        try {
          setDocScopeNotificationsFactory(undefined);
        } catch (cause) {
          if (!failed) {
            failed = true;
            first = cause;
          }
        }
        if (failed) throw first;
        context.docNotificationsClosed = true;
      });
      return notificationStop;
    };
    setDocScopeNotificationsFactory(
      (current, caller) => (signal) => scopes.subscribe(current, http.actor(caller), signal)
    );
  }

  // Original lexical HTTP actor policy for a local-install operator, no public registrar.
  return extendOriginalConsumerPhase(context, {
    budget,
    rooms,
    roomRepos,
    approvals,
    roomMutex,
    channels,
    fileWrites,
    roomWriter,
    roomRepoService,
    roomFiles,
    roomFileEditor,
    roomWorktreeManager,
    http,
  });
}
