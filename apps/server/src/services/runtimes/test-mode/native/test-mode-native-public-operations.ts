import * as testModeNativeOperationsLeaf from './test-mode-native-operations.js';
const originalPublicFacadeFreeze = Object.freeze;
type TestModeWithoutOwner<F> = F extends (owner: object, ...args: infer A) => infer R
  ? (...args: A) => R
  : never;

/** Exact original public native callable signatures, omitting only the inaccessible custody key. */
export interface OriginalTestModeNativePublicOperations {
  isTestModeOriginalRoomLaunchAlias: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.isTestModeOriginalRoomLaunchAlias
  >;
  captureTestModeOriginalRoomEmitter: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.captureTestModeOriginalRoomEmitter
  >;
  readTestModeOriginalPreparedRoomContext: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.readTestModeOriginalPreparedRoomContext
  >;
  readTestModeOriginalPlacementOptions: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.readTestModeOriginalPlacementOptions
  >;
  readTestModeOriginalActiveStream: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.readTestModeOriginalActiveStream
  >;
  readTestModeOriginalNativeStream: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.readTestModeOriginalNativeStream
  >;
  readTestModeOriginalNativeTurnOptions: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.readTestModeOriginalNativeTurnOptions
  >;
  readTestModeOriginalStopTerminalData: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.readTestModeOriginalStopTerminalData
  >;
  resolveTestModeOriginalNativeStreamPrincipal: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.resolveTestModeOriginalNativeStreamPrincipal
  >;
  readTestModeOriginalScenarioEvidence: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.readTestModeOriginalScenarioEvidence
  >;
  requireTestModeOriginalRoomEmissionClosed: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.requireTestModeOriginalRoomEmissionClosed
  >;
  readTestModeOriginalScenarioCounts: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.readTestModeOriginalScenarioCounts
  >;
  isOriginalNativeTestModeRuntime: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.isOriginalNativeTestModeRuntime
  >;
  readTestModeNativeOperation: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.readTestModeNativeOperation
  >;
  readTestModeOriginalCanonicalSessionId: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.readTestModeOriginalCanonicalSessionId
  >;
  captureTestModeOriginalCanonicalRestart: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.captureTestModeOriginalCanonicalRestart
  >;
  readTestModeOriginalCanonicalRestart: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.readTestModeOriginalCanonicalRestart
  >;
  moveTestModeOriginalLockedAcquisition: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.moveTestModeOriginalLockedAcquisition
  >;
  sendTestModeOriginalLockedMessage: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.sendTestModeOriginalLockedMessage
  >;
  prepareTestModeOriginalLockedRoomResponder: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.prepareTestModeOriginalLockedRoomResponder
  >;
  readTestModePreparedRoomResponder: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.readTestModePreparedRoomResponder
  >;
  retireTestModePreparedRoomResponder: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.retireTestModePreparedRoomResponder
  >;
  startTestModeCommittedRoomResponder: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.startTestModeCommittedRoomResponder
  >;
  readTestModeOriginalRoomResponderStream: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.readTestModeOriginalRoomResponderStream
  >;
}

/** Capture only a supplied opaque key; every effect independently requires actual root membership. */
export function createOriginalTestModeNativePublicOperations(
  originalTestModeCustodyKey: object
): Readonly<OriginalTestModeNativePublicOperations> {
  /** Constructor-native launch alias recognition; unknown/foreign producers stay on the ordinary busy path. */
  const isTestModeOriginalRoomLaunchAlias: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.isTestModeOriginalRoomLaunchAlias
  > = (...args) =>
    testModeNativeOperationsLeaf.isTestModeOriginalRoomLaunchAlias(
      originalTestModeCustodyKey,
      ...args
    );
  /** Installation-only capture into the original constructor; no emitter argument or public setter. */
  const captureTestModeOriginalRoomEmitter: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.captureTestModeOriginalRoomEmitter
  > = (...args) =>
    testModeNativeOperationsLeaf.captureTestModeOriginalRoomEmitter(
      originalTestModeCustodyKey,
      ...args
    );
  /** Historical DATA from actual original native entry; this never authorizes a Room launch. */
  const readTestModeOriginalPreparedRoomContext: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.readTestModeOriginalPreparedRoomContext
  > = (...args) =>
    testModeNativeOperationsLeaf.readTestModeOriginalPreparedRoomContext(
      originalTestModeCustodyKey,
      ...args
    );
  /** Lookup only: the actual held native stream remains recognized by its original private operation. */
  /** DATA-only observation of options consumed by an actually started original native entry. */
  const readTestModeOriginalPlacementOptions: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.readTestModeOriginalPlacementOptions
  > = (...args) =>
    testModeNativeOperationsLeaf.readTestModeOriginalPlacementOptions(
      originalTestModeCustodyKey,
      ...args
    );
  /** Read the original held native stream without granting Room launch authority. */
  const readTestModeOriginalActiveStream: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.readTestModeOriginalActiveStream
  > = (...args) =>
    testModeNativeOperationsLeaf.readTestModeOriginalActiveStream(
      originalTestModeCustodyKey,
      ...args
    );
  /** Fixed actual producer stream identity; possession of copied stream fields never issues. */
  const readTestModeOriginalNativeStream: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.readTestModeOriginalNativeStream
  > = (...args) =>
    testModeNativeOperationsLeaf.readTestModeOriginalNativeStream(
      originalTestModeCustodyKey,
      ...args
    );
  /** Lookup original construction-captured turn DATA without reopening retired native authority. */
  const readTestModeOriginalNativeTurnOptions: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.readTestModeOriginalNativeTurnOptions
  > = (...args) =>
    testModeNativeOperationsLeaf.readTestModeOriginalNativeTurnOptions(
      originalTestModeCustodyKey,
      ...args
    );
  /** Read only the exact original Stop terminal DATA; retired native authority remains unavailable. */
  const readTestModeOriginalStopTerminalData: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.readTestModeOriginalStopTerminalData
  > = (...args) =>
    testModeNativeOperationsLeaf.readTestModeOriginalStopTerminalData(
      originalTestModeCustodyKey,
      ...args
    );
  /** Uses the real original service's captured policy and native SQL gate after its awaits. */
  const resolveTestModeOriginalNativeStreamPrincipal: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.resolveTestModeOriginalNativeStreamPrincipal
  > = (...args) =>
    testModeNativeOperationsLeaf.resolveTestModeOriginalNativeStreamPrincipal(
      originalTestModeCustodyKey,
      ...args
    );
  /** Historical effect evidence only, keyed by an actual constructor-created raw stream. No permission is returned. */
  const readTestModeOriginalScenarioEvidence: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.readTestModeOriginalScenarioEvidence
  > = (...args) =>
    testModeNativeOperationsLeaf.readTestModeOriginalScenarioEvidence(
      originalTestModeCustodyKey,
      ...args
    );
  /** Pump closure gate on the genuine constructor-created stream, after actual owned drains. */
  const requireTestModeOriginalRoomEmissionClosed: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.requireTestModeOriginalRoomEmissionClosed
  > = (...args) =>
    testModeNativeOperationsLeaf.requireTestModeOriginalRoomEmissionClosed(
      originalTestModeCustodyKey,
      ...args
    );
  /** Cumulative DATA from the actual native constructor; an unrecognized runtime is UNKNOWN, never zero. */
  const readTestModeOriginalScenarioCounts: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.readTestModeOriginalScenarioCounts
  > = (...args) =>
    testModeNativeOperationsLeaf.readTestModeOriginalScenarioCounts(
      originalTestModeCustodyKey,
      ...args
    );
  /** Constructor recognition selects only this internal runtime lane; it is not document permission. */
  const isOriginalNativeTestModeRuntime: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.isOriginalNativeTestModeRuntime
  > = (...args) =>
    testModeNativeOperationsLeaf.isOriginalNativeTestModeRuntime(
      originalTestModeCustodyKey,
      ...args
    );
  /** Actual TestMode constructor/entry only; a logical runtime alias cannot confer authority. */
  const readTestModeNativeOperation: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.readTestModeNativeOperation
  > = (...args) =>
    testModeNativeOperationsLeaf.readTestModeNativeOperation(originalTestModeCustodyKey, ...args);
  /** Actual native stream's internally assigned canonical identity; public declarations are DATA only. */
  const readTestModeOriginalCanonicalSessionId: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.readTestModeOriginalCanonicalSessionId
  > = (...args) =>
    testModeNativeOperationsLeaf.readTestModeOriginalCanonicalSessionId(
      originalTestModeCustodyKey,
      ...args
    );
  /** Capture canonical restart evidence from the original TestMode constructor. */
  const captureTestModeOriginalCanonicalRestart: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.captureTestModeOriginalCanonicalRestart
  > = (...args) =>
    testModeNativeOperationsLeaf.captureTestModeOriginalCanonicalRestart(
      originalTestModeCustodyKey,
      ...args
    );
  /** Read-only DATA. Positive closure is checked against the original entry and lock retirement witness. */
  const readTestModeOriginalCanonicalRestart: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.readTestModeOriginalCanonicalRestart
  > = (...args) =>
    testModeNativeOperationsLeaf.readTestModeOriginalCanonicalRestart(
      originalTestModeCustodyKey,
      ...args
    );
  /** Transfer only this constructor's genuine old/new acquisitions and privately assigned identity. */
  const moveTestModeOriginalLockedAcquisition: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.moveTestModeOriginalLockedAcquisition
  > = (...args) =>
    testModeNativeOperationsLeaf.moveTestModeOriginalLockedAcquisition(
      originalTestModeCustodyKey,
      ...args
    );
  /** Send through the original locked TestMode message operation. */
  const sendTestModeOriginalLockedMessage: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.sendTestModeOriginalLockedMessage
  > = (...args) =>
    testModeNativeOperationsLeaf.sendTestModeOriginalLockedMessage(
      originalTestModeCustodyKey,
      ...args
    );
  /** Prepare the original locked TestMode Room responder. */
  const prepareTestModeOriginalLockedRoomResponder: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.prepareTestModeOriginalLockedRoomResponder
  > = (...args) =>
    testModeNativeOperationsLeaf.prepareTestModeOriginalLockedRoomResponder(
      originalTestModeCustodyKey,
      ...args
    );
  /** Read the original TestMode Room responder preparation. */
  const readTestModePreparedRoomResponder: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.readTestModePreparedRoomResponder
  > = (...args) =>
    testModeNativeOperationsLeaf.readTestModePreparedRoomResponder(
      originalTestModeCustodyKey,
      ...args
    );
  /** Retire the original TestMode Room responder preparation. */
  const retireTestModePreparedRoomResponder: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.retireTestModePreparedRoomResponder
  > = (...args) =>
    testModeNativeOperationsLeaf.retireTestModePreparedRoomResponder(
      originalTestModeCustodyKey,
      ...args
    );
  /** Start the original TestMode responder from its committed native operation. */
  const startTestModeCommittedRoomResponder: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.startTestModeCommittedRoomResponder
  > = (...args) =>
    testModeNativeOperationsLeaf.startTestModeCommittedRoomResponder(
      originalTestModeCustodyKey,
      ...args
    );
  /** Read evidence from the original TestMode Room responder stream. */
  const readTestModeOriginalRoomResponderStream: TestModeWithoutOwner<
    typeof testModeNativeOperationsLeaf.readTestModeOriginalRoomResponderStream
  > = (...args) =>
    testModeNativeOperationsLeaf.readTestModeOriginalRoomResponderStream(
      originalTestModeCustodyKey,
      ...args
    );

  return originalPublicFacadeFreeze({
    isTestModeOriginalRoomLaunchAlias,
    captureTestModeOriginalRoomEmitter,
    readTestModeOriginalPreparedRoomContext,
    readTestModeOriginalPlacementOptions,
    readTestModeOriginalActiveStream,
    readTestModeOriginalNativeStream,
    readTestModeOriginalNativeTurnOptions,
    readTestModeOriginalStopTerminalData,
    resolveTestModeOriginalNativeStreamPrincipal,
    readTestModeOriginalScenarioEvidence,
    requireTestModeOriginalRoomEmissionClosed,
    readTestModeOriginalScenarioCounts,
    isOriginalNativeTestModeRuntime,
    readTestModeNativeOperation,
    readTestModeOriginalCanonicalSessionId,
    captureTestModeOriginalCanonicalRestart,
    readTestModeOriginalCanonicalRestart,
    moveTestModeOriginalLockedAcquisition,
    sendTestModeOriginalLockedMessage,
    prepareTestModeOriginalLockedRoomResponder,
    readTestModePreparedRoomResponder,
    retireTestModePreparedRoomResponder,
    startTestModeCommittedRoomResponder,
    readTestModeOriginalRoomResponderStream,
  });
}
