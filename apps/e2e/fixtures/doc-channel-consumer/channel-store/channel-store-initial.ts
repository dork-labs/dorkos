/** Real protected-source fixture composition. No browser/page can select an actor or issuer. */
import { createNativeEmissionIntegrityControl } from '../native-emission-integrity-control.js';

import { join } from 'node:path';

import { requireOriginalConsumerInput } from '../channel-store.js';
import { extendOriginalConsumerPhase } from './channel-store-phase-data.js';
/** Exact sequential original constructor phase; requires its inaccessible original key. */
export async function constructOriginalConsumerInitial(ownerKey: object) {
  const context = requireOriginalConsumerInput(ownerKey);
  const { vault } = context;
  // Direct fixture callers own the same real root as the worker bootstrap.
  const { initBoundary } = await import('../../../../server/src/lib/boundary.js');
  await initBoundary(vault.root);
  const { openServerDatabase } = await import('@dorkos/db/internal-server');
  const { agents, authors, sessionMetadata, runMigrations, eq } = await import('@dorkos/db');
  const { initAuth, readOwnerAccount } =
    await import('../../../../server/src/services/core/auth/index.js');
  const { initConfigManager } =
    await import('../../../../server/src/services/core/config-manager.js');
  const { ConnectorRuntimePrincipalService } =
    await import('../../../../server/src/services/connectors/principal/runtime-principal-service.js');
  const { createRoomSubsystem, resolveOperatorAuthor, setRoomService, clearRoomService } =
    await import('../../../../server/src/services/rooms/index.js');
  const { clearCanvasService } = await import('../../../../server/src/services/canvas/index.js');
  const { setAgentHomeRegistry } =
    await import('../../../../server/src/services/core/agent-identity/index.js');
  const { RoomTurnBudget } =
    await import('../../../../server/src/services/rooms/limits/turn-budget.js');
  const { createTurnBudgetLimits } =
    await import('../../../../server/src/services/rooms/limits/room-limits.js');
  const {
    RoomRepoStore,
    RoomRepoMutex,
    RoomRepoService,
    RoomFilesService,
    RoomFileEditor,
    RoomWorktreeManager,
    readRoomRepoConfig,
    ROOM_MD_FILENAME,
  } = await import('../../../../server/src/services/rooms/repo/index.js');
  const { DocChannelStore } =
    await import('../../../../server/src/services/canvas/doc-channel/store.js');
  const { InstallationFileWrites, readInstallationFileRoomWrites, stopInstallationFileWrites } =
    await import('../../../../server/src/services/canvas/doc-channel/writes/installation-file-writes.js');
  const { readOperatorDisplayName } =
    await import('../../../../server/src/services/core/config/operator-display-name.js');
  const { sanitizeIdentity } = await import('@dorkos/shared/untrusted-text');
  const { ApprovalService } =
    await import('../../../../server/src/services/core/approvals/approval-service.js');
  const { createDocChannelHttpComposition, docInstallationOwner } =
    await import('../../../../server/src/services/canvas/doc-channel/http-composition.js');
  const {
    replayServiceCurrentDoc,
    submitCurrentDocEvent,
    inspectServiceCurrentDocReceipt,
    readServiceOriginalRoomScenarioEvidence,
    currentRoomDueServicePort,
  } = await import('../../../../server/src/services/canvas/doc-channel/service.js');
  const file = join(vault.root, 'native-channel.sqlite');
  const opened = openServerDatabase(file),
    db = opened.db;
  let roomScheduler: { stop(): Promise<void> } | undefined;
  let ownedRooms: ReturnType<typeof createRoomSubsystem> | undefined;
  let disposeRoomCanvas: (() => void) | undefined;
  let stopHttpFileWrites: (() => Promise<void>) | undefined;
  let stopDocOperations: (() => Promise<void>) | undefined;
  let docOperationsClosed = true;
  let stopDocNotifications: (() => Promise<void>) | undefined;
  let docNotificationsClosed = true;
  let httpConstructionStarted = false,
    httpFileWritesClosed = false;
  let roomSchedulerClosed = false;
  let agentHomeRegistryInstalled = false;
  let stopFollowingSessionRekeys: (() => void) | undefined;
  let stopMcpAppFixture: (() => Promise<void>) | undefined;
  let mcpFixtureClosed = true;
  let stopWidgetProducer: (() => Promise<void>) | undefined;
  let widgetProducerClosed = true;
  let integrityControl: ReturnType<typeof createNativeEmissionIntegrityControl> | undefined;
  let integrityConstructionStarted = false,
    integrityClosed = false;
  return extendOriginalConsumerPhase(context, {
    initBoundary,
    openServerDatabase,
    agents,
    authors,
    sessionMetadata,
    runMigrations,
    eq,
    initAuth,
    readOwnerAccount,
    initConfigManager,
    ConnectorRuntimePrincipalService,
    createRoomSubsystem,
    resolveOperatorAuthor,
    setRoomService,
    clearRoomService,
    clearCanvasService,
    setAgentHomeRegistry,
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
    docInstallationOwner,
    replayServiceCurrentDoc,
    submitCurrentDocEvent,
    inspectServiceCurrentDocReceipt,
    readServiceOriginalRoomScenarioEvidence,
    currentRoomDueServicePort,
    file,
    opened,
    db,
    get roomScheduler() {
      return roomScheduler;
    },
    set roomScheduler(value: typeof roomScheduler) {
      roomScheduler = value;
    },
    get ownedRooms() {
      return ownedRooms;
    },
    set ownedRooms(value: typeof ownedRooms) {
      ownedRooms = value;
    },
    get disposeRoomCanvas() {
      return disposeRoomCanvas;
    },
    set disposeRoomCanvas(value: typeof disposeRoomCanvas) {
      disposeRoomCanvas = value;
    },
    get stopHttpFileWrites() {
      return stopHttpFileWrites;
    },
    set stopHttpFileWrites(value: typeof stopHttpFileWrites) {
      stopHttpFileWrites = value;
    },
    get stopDocOperations() {
      return stopDocOperations;
    },
    set stopDocOperations(value: typeof stopDocOperations) {
      stopDocOperations = value;
    },
    get docOperationsClosed() {
      return docOperationsClosed;
    },
    set docOperationsClosed(value: typeof docOperationsClosed) {
      docOperationsClosed = value;
    },
    get stopDocNotifications() {
      return stopDocNotifications;
    },
    set stopDocNotifications(value: typeof stopDocNotifications) {
      stopDocNotifications = value;
    },
    get docNotificationsClosed() {
      return docNotificationsClosed;
    },
    set docNotificationsClosed(value: typeof docNotificationsClosed) {
      docNotificationsClosed = value;
    },
    get httpConstructionStarted() {
      return httpConstructionStarted;
    },
    set httpConstructionStarted(value: typeof httpConstructionStarted) {
      httpConstructionStarted = value;
    },
    get httpFileWritesClosed() {
      return httpFileWritesClosed;
    },
    set httpFileWritesClosed(value: typeof httpFileWritesClosed) {
      httpFileWritesClosed = value;
    },
    get roomSchedulerClosed() {
      return roomSchedulerClosed;
    },
    set roomSchedulerClosed(value: typeof roomSchedulerClosed) {
      roomSchedulerClosed = value;
    },
    get agentHomeRegistryInstalled() {
      return agentHomeRegistryInstalled;
    },
    set agentHomeRegistryInstalled(value: typeof agentHomeRegistryInstalled) {
      agentHomeRegistryInstalled = value;
    },
    get stopFollowingSessionRekeys() {
      return stopFollowingSessionRekeys;
    },
    set stopFollowingSessionRekeys(value: typeof stopFollowingSessionRekeys) {
      stopFollowingSessionRekeys = value;
    },
    get stopMcpAppFixture() {
      return stopMcpAppFixture;
    },
    set stopMcpAppFixture(value: typeof stopMcpAppFixture) {
      stopMcpAppFixture = value;
    },
    get mcpFixtureClosed() {
      return mcpFixtureClosed;
    },
    set mcpFixtureClosed(value: typeof mcpFixtureClosed) {
      mcpFixtureClosed = value;
    },
    get stopWidgetProducer() {
      return stopWidgetProducer;
    },
    set stopWidgetProducer(value: typeof stopWidgetProducer) {
      stopWidgetProducer = value;
    },
    get widgetProducerClosed() {
      return widgetProducerClosed;
    },
    set widgetProducerClosed(value: typeof widgetProducerClosed) {
      widgetProducerClosed = value;
    },
    get integrityControl() {
      return integrityControl;
    },
    set integrityControl(value: typeof integrityControl) {
      integrityControl = value;
    },
    get integrityConstructionStarted() {
      return integrityConstructionStarted;
    },
    set integrityConstructionStarted(value: typeof integrityConstructionStarted) {
      integrityConstructionStarted = value;
    },
    get integrityClosed() {
      return integrityClosed;
    },
    set integrityClosed(value: typeof integrityClosed) {
      integrityClosed = value;
    },
  });
}
