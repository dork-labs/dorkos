/** Real protected-source fixture composition. No browser/page can select an actor or issuer. */
import { createNativeEmissionIntegrityControl } from '../native-emission-integrity-control.js';

import { requireOriginalConsumerDocument } from '../channel-store.js';
import { extendOriginalConsumerPhase } from './channel-store-phase-data.js';
/** Exact sequential original constructor phase; requires its inaccessible original key. */
export async function constructOriginalConsumerRuntime(ownerKey: object) {
  const context = requireOriginalConsumerDocument(ownerKey);
  const {
    vault,
    hostBootstrap,
    target,
    integrityCase,
    resume,
    db,
    sessionId,
    principals,
    boot,
    budget,
    rooms,
    http,
    documentId,
    initial,
  } = context;
  const condition = Object.freeze({
    expectedGeneration: initial.incarnation.generation,
    originalReceiptRetentionFloor: initial.receiptRetentionFloor,
  });
  const { DocBatchAdmission } =
    await import('../../../../server/src/services/canvas/doc-channel/delivery/batch-admission.js');
  const { privateDocTurnBudget } =
    await import('../../../../server/src/services/canvas/doc-channel/delivery/final-budget.js');
  const { MessageQueueStore, setMessageQueueStore } =
    await import('../../../../server/src/services/session/message-queue-store.js');
  const { setPrivateSessionMessageAcceptanceService } =
    await import('../../../../server/src/services/session/private-messages/acceptance.js');
  const { adoptAcceptedPrivateMessages, resetMessageDispatcher, suspendPrivateDispatches } =
    await import('../../../../server/src/services/session/message-dispatcher.js');
  const { getOrCreateProjector, disposeProjector } =
    await import('../../../../server/src/services/session/session-state-projector.js');
  const { TestModeRuntime, captureTestModeOriginalRoomEmitter } =
    await import('../../../../server/src/services/runtimes/test-mode/test-mode-runtime.js');
  const { scenarioStore } =
    await import('../../../../server/src/services/runtimes/test-mode/scenario-store.js');
  const queue = new MessageQueueStore(db);
  const admission =
    target === 'session'
      ? new DocBatchAdmission({
          db,
          store: http.channels,
          grants: http.grants,
          lifecycle: rooms.canvasDocuments.lifecycle,
          queue,
          bootEpoch: boot.bootEpoch,
          beforeClaim: privateDocTurnBudget,
        })
      : undefined;
  admission?.initializeBoot(); // The private-session receipt coordinator never owns Room lifecycle.
  // The real paid-safe producer, not Vitest's fake or a production SDK mock.
  // Consumes Contracts' constructor-owned native capture. The old alias alone
  // is not authority; this SAME genuine service owns all native turn checks.
  const { env: serverEnv } = await import('../../../../server/src/env.js');
  const runtime = (() => {
    const previousTestBoot = serverEnv.DORKOS_TEST_RUNTIME;
    try {
      // Direct test fixtures own this synchronous constructor boot; child hosts retain their actual boot flag.
      if (!hostBootstrap) serverEnv.DORKOS_TEST_RUNTIME = true;
      return new TestModeRuntime('claude-code', principals);
    } finally {
      serverEnv.DORKOS_TEST_RUNTIME = previousTestBoot;
    }
  })();
  const originalTargetLocked = runtime.isLocked.bind(runtime);
  const { captureTestModeOriginalCanonicalRestart, readTestModeOriginalCanonicalRestart } =
    await import('../../../../server/src/services/runtimes/test-mode/test-mode-runtime.js');
  let canonicalCapture:
    | import('../../../../server/src/services/runtimes/test-mode/test-mode-runtime.js').OriginalTestModeCanonicalRestart
    | undefined;
  let canonicalAnchorId: string | undefined;
  let canonicalAnchorStarted = false,
    canonicalPauseStarted = false,
    canonicalCaptureStarted = false;
  let canonicalSetup: Promise<unknown> | undefined;
  const { readRoomStoreGrantedDocTargetBinding } =
    await import('../../../../server/src/services/rooms/room-store.js');
  const { followSessionRekeys } =
    await import('../../../../server/src/services/rooms/session-bindings/room-session-convergence.js');
  if (hostBootstrap && target === 'room')
    context.stopFollowingSessionRekeys = followSessionRekeys(rooms.store);

  // Direct and hosted controls retain this same constructor-owned native principal service.
  runtime.ensureSession(sessionId, { cwd: vault.root, permissionMode: 'default' });
  scenarioStore.setForSession(sessionId, resume ? 'native-room-partial-ack-reply' : 'simple-text');
  const { RuntimeRegistry, runtimeRegistry: hostedRuntimeRegistry } =
    await import('../../../../server/src/services/core/runtime-registry.js');
  // Direct fixtures own a separate real registry; hosted fixtures use their process boot registry.
  const runtimeRegistry = hostBootstrap ? hostedRuntimeRegistry : new RuntimeRegistry();
  runtimeRegistry.setDb(db);
  runtimeRegistry.register(runtime);
  runtimeRegistry.setDefault(runtime.type);
  const { SessionEventStore } =
    await import('../../../../server/src/services/session/session-event-store.js');
  const { setSessionEventStore } =
    await import('../../../../server/src/services/session/session-state-projector.js');
  // One isolated process owns these bootstrap globals. Registration is the
  // ordinary tracing/sign-in seam, not an alternate runtime authority issuer.
  if (hostBootstrap) {
    setSessionEventStore(new SessionEventStore(db));
    if (target === 'room') {
      captureTestModeOriginalRoomEmitter(runtime, http.fileWrites, db, http.channels);
      const { startCurrentRoomDueScheduler } =
        await import('../../../../server/src/services/canvas/doc-channel/operations/room-due-scheduler.js');
      // Original scheduler/pump creates its own DetachedTurnLifecycle, lock,
      // prepared native tuple, COMMIT/FIRST and same-entry observed stream.
      // No holder, source token or turn callback is supplied by this fixture.
      context.integrityConstructionStarted = true;
      context.integrityControl = createNativeEmissionIntegrityControl(
        db,
        documentId,
        http.service,
        integrityCase
      );
      context.roomScheduler = startCurrentRoomDueScheduler(http.service, runtimeRegistry);
    }
  }
  return extendOriginalConsumerPhase(context, {
    condition,
    DocBatchAdmission,
    privateDocTurnBudget,
    MessageQueueStore,
    setMessageQueueStore,
    setPrivateSessionMessageAcceptanceService,
    adoptAcceptedPrivateMessages,
    resetMessageDispatcher,
    suspendPrivateDispatches,
    getOrCreateProjector,
    disposeProjector,
    TestModeRuntime,
    captureTestModeOriginalRoomEmitter,
    scenarioStore,
    queue,
    admission,
    serverEnv,
    runtime,
    originalTargetLocked,
    captureTestModeOriginalCanonicalRestart,
    readTestModeOriginalCanonicalRestart,
    get canonicalCapture() {
      return canonicalCapture;
    },
    set canonicalCapture(value: typeof canonicalCapture) {
      canonicalCapture = value;
    },
    get canonicalAnchorId() {
      return canonicalAnchorId;
    },
    set canonicalAnchorId(value: typeof canonicalAnchorId) {
      canonicalAnchorId = value;
    },
    get canonicalAnchorStarted() {
      return canonicalAnchorStarted;
    },
    set canonicalAnchorStarted(value: typeof canonicalAnchorStarted) {
      canonicalAnchorStarted = value;
    },
    get canonicalPauseStarted() {
      return canonicalPauseStarted;
    },
    set canonicalPauseStarted(value: typeof canonicalPauseStarted) {
      canonicalPauseStarted = value;
    },
    get canonicalCaptureStarted() {
      return canonicalCaptureStarted;
    },
    set canonicalCaptureStarted(value: typeof canonicalCaptureStarted) {
      canonicalCaptureStarted = value;
    },
    get canonicalSetup() {
      return canonicalSetup;
    },
    set canonicalSetup(value: typeof canonicalSetup) {
      canonicalSetup = value;
    },
    readRoomStoreGrantedDocTargetBinding,
    followSessionRekeys,
    RuntimeRegistry,
    hostedRuntimeRegistry,
    runtimeRegistry,
    SessionEventStore,
    setSessionEventStore,
  });
}
