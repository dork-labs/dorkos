import { readOriginalTestModeNativeCustodyMaps } from '../test-mode-runtime.js';
import type { Db } from '@dorkos/db';
import { type RoomContextData } from '@dorkos/shared/additional-context';
import type { DocChannelStore } from '../../../canvas/doc-channel/store.js';
import { type InstallationFileWrites } from '../../../canvas/doc-channel/writes/installation-file-writes.js';
import {
  readOriginalRegisteredRuntime,
  readOriginalRegisteredRuntimeStream,
  readOriginalRegisteredNativeStream,
} from '../../../core/runtime-registry.js';
import {
  captureNativeSessionActivity,
  readNativeSessionAcquisition,
  requireOriginalNativeSessionAcquisitionRetired,
} from '../../../session/session-lock.js';
import {
  readOriginalDetachedTurnLifecycleClosed,
  readOriginalRoomDispatchLifecycle,
} from '../../../session/trigger-turn.js';
import { requireOriginalCommittedRoomResponder } from '../../../canvas/doc-channel/operations/room-responder-operation.js';
import type {
  OriginalFrozenRoomSource,
  PreparedRoomResponder,
  OriginalCommittedRoomResponder,
} from '../../../canvas/doc-channel/current/current-operation-types.js';
import type { MessageOpts, SseResponse } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import type {
  TestModeNativeEntry,
  OriginalTestModeCanonicalRestart,
} from './test-mode-native-types.js';

/** Constructor-native launch alias recognition; unknown/foreign producers stay on the ordinary busy path. */
export function isTestModeOriginalRoomLaunchAlias(
  custodyOwner: object,
  runtime: object,
  request: import('../../../rooms/room-turn-port.js').RoomTurnRequest,
  retiredId: string
): boolean {
  const view = readOriginalTestModeNativeCustodyMaps(custodyOwner);
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  return view.testModeNativeConstructors.get(runtime)?.isLaunchAlias(request, retiredId) === true;
}
/** Installation-only capture into the original constructor; no emitter argument or public setter. */
export function captureTestModeOriginalRoomEmitter(
  custodyOwner: object,
  runtime: object,
  owner: InstallationFileWrites,
  db: Db,
  store: DocChannelStore
): void {
  const view = readOriginalTestModeNativeCustodyMaps(custodyOwner);
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const own = view.testModeNativeConstructors.get(runtime);
  if (!own) throw new Error('Original dedicated TestMode constructor required.');
  own.captureEmitter(owner, db, store);
}
/** Historical DATA from actual original native entry; this never authorizes a Room launch. */
export function readTestModeOriginalPreparedRoomContext(
  custodyOwner: object,
  runtime: object,
  sessionId: string
): RoomContextData | undefined {
  const view = readOriginalTestModeNativeCustodyMaps(custodyOwner);
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  return view.testModeNativeConstructors.get(runtime)?.readPreparedRoomContext(sessionId);
}
/** Lookup only: the actual held native stream remains recognized by its original private operation. */
/** DATA-only observation of options consumed by an actually started original native entry. */
export function readTestModeOriginalPlacementOptions(
  custodyOwner: object,
  runtime: object,
  sessionId: string
) {
  const view = readOriginalTestModeNativeCustodyMaps(custodyOwner);
  const entry = view.testModeNativeConstructors.get(runtime)?.entries.get(sessionId);
  if (
    !entry ||
    entry.runtime !== runtime ||
    entry.retired ||
    entry.closed ||
    entry.scenarioStarts < 1
  )
    return undefined;
  return entry.placementOptions;
}
/** Read the original held native stream without granting Room launch authority. */
export function readTestModeOriginalActiveStream(
  custodyOwner: object,
  runtime: object,
  sessionId: string
) {
  const view = readOriginalTestModeNativeCustodyMaps(custodyOwner);
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  return view.testModeNativeConstructors.get(runtime)?.readActiveStream(sessionId);
}
/** Fixed actual producer stream identity; possession of copied stream fields never issues. */
export function readTestModeOriginalNativeStream(
  custodyOwner: object,
  runtime: object,
  stream: object
) {
  const view = readOriginalTestModeNativeCustodyMaps(custodyOwner);
  stream = readOriginalRegisteredRuntimeStream(runtime, stream) ?? stream;
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const own = view.testModeOriginalStreams.get(stream);
  if (
    !own ||
    own.runtime !== runtime ||
    !readTestModeNativeOperation(custodyOwner, own.own.operation)
  )
    return undefined;
  return Object.freeze({ operation: own.own.operation });
}
/** Lookup original construction-captured turn DATA without reopening retired native authority. */
export function readTestModeOriginalNativeTurnOptions(
  custodyOwner: object,
  runtime: object,
  sessionId: string,
  stream: object
) {
  const view = readOriginalTestModeNativeCustodyMaps(custodyOwner);
  const own = view.testModeOriginalStreams.get(stream);
  return own &&
    own.runtime === runtime &&
    own.sessionId === sessionId &&
    readTestModeNativeOperation(custodyOwner, own.own.operation)
    ? { options: own.options }
    : undefined;
}
/** Read only the exact original Stop terminal DATA; retired native authority remains unavailable. */
export function readTestModeOriginalStopTerminalData(
  custodyOwner: object,
  runtime: object,
  stream: object,
  event?: StreamEvent
): boolean {
  const view = readOriginalTestModeNativeCustodyMaps(custodyOwner);
  stream = readOriginalRegisteredRuntimeStream(runtime, stream) ?? stream;
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const own = view.testModeOriginalStreams.get(stream);
  return (
    !!own &&
    own.runtime === runtime &&
    own.stopContinuation() &&
    (event === undefined || own.stopEvents.has(event))
  );
}
/** Uses the real original service's captured policy and native SQL gate after its awaits. */
export function resolveTestModeOriginalNativeStreamPrincipal(
  custodyOwner: object,
  runtime: object,
  stream: object
) {
  const view = readOriginalTestModeNativeCustodyMaps(custodyOwner);
  stream = readOriginalRegisteredRuntimeStream(runtime, stream) ?? stream;
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const own = view.testModeOriginalStreams.get(stream);
  if (
    !own ||
    own.runtime !== runtime ||
    !readTestModeNativeOperation(custodyOwner, own.own.operation)
  )
    return Promise.resolve({ status: 'refused' as const, reason: 'revoked' as const });
  return own.resolve();
}
/** Historical effect evidence only, keyed by an actual constructor-created raw stream. No permission is returned. */
export function readTestModeOriginalScenarioEvidence(
  custodyOwner: object,
  runtime: object,
  stream: object
) {
  const view = readOriginalTestModeNativeCustodyMaps(custodyOwner);
  stream = readOriginalRegisteredRuntimeStream(runtime, stream) ?? stream;
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const own = view.testModeOriginalStreams.get(stream);
  if (!own || own.runtime !== runtime) return undefined;
  return Object.freeze({
    scenarioStarts: own.own.entry.scenarioStarts,
    retired: own.own.entry.retired,
    sessionId: own.own.entry.sessionId,
  });
}
/** Pump closure gate on the genuine constructor-created stream, after actual owned drains. */
export function requireTestModeOriginalRoomEmissionClosed(
  custodyOwner: object,
  runtime: object,
  stream: object,
  db: Db
): void {
  const view = readOriginalTestModeNativeCustodyMaps(custodyOwner);
  stream = readOriginalRegisteredRuntimeStream(runtime, stream) ?? stream;
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const original = view.testModeOriginalStreams.get(stream),
    constructor = view.testModeNativeConstructors.get(runtime);
  if (
    !original ||
    original.runtime !== runtime ||
    !constructor ||
    !original.own.entry.retired ||
    original.own.entry.scenarioStarts !== 1 ||
    !view.testModeStreams.has(stream)
  )
    throw new Error('Original retired ONE TestMode Room stream required');
  constructor.requireEmitterClosed(db);
}
/** Cumulative DATA from the actual native constructor; an unrecognized runtime is UNKNOWN, never zero. */
export function readTestModeOriginalScenarioCounts(
  custodyOwner: object,
  runtime: object
): Readonly<{ scenarioStarts: number }> | undefined {
  const view = readOriginalTestModeNativeCustodyMaps(custodyOwner);
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const own = view.testModeNativeConstructors.get(runtime);
  if (!own) return undefined;
  return Object.freeze({ scenarioStarts: own.scenarioStarts() });
}
/** Constructor recognition selects only this internal runtime lane; it is not document permission. */
export function isOriginalNativeTestModeRuntime(custodyOwner: object, runtime: object): boolean {
  const view = readOriginalTestModeNativeCustodyMaps(custodyOwner);
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  return view.testModeNativeConstructors.has(runtime);
}
/** Actual TestMode constructor/entry only; a logical runtime alias cannot confer authority. */
export function readTestModeNativeOperation(custodyOwner: object, token: object) {
  const view = readOriginalTestModeNativeCustodyMaps(custodyOwner);
  const entry = view.testModeNativeOperations.get(token);
  const owner = entry && view.testModeNativeConstructors.get(entry.runtime);
  if (
    !entry ||
    !owner ||
    entry.retired ||
    view.nativeSignalAborted.call(entry.controller.signal) ||
    view.originalMapGet.call(owner.entries, entry.sessionId) !== entry
  )
    return undefined;
  if (
    entry.roomOrigin &&
    readOriginalRoomDispatchLifecycle(entry.roomOrigin.holder, entry.runtime) !==
      entry.roomOrigin.custody
  ) {
    entry.retired = true;
    return undefined;
  }
  return {
    runtime: 'claude-code' as const,
    canonicalSessionId: entry.canonicalSessionId,
    agentPath: entry.path,
    canonicalCwd: entry.path,
    signal: entry.controller.signal,
    acquisition: entry.acquisition,
    roomCustody: entry.roomOrigin?.custody,
  };
}
/** Actual native stream's internally assigned canonical identity; public declarations are DATA only. */
export function readTestModeOriginalCanonicalSessionId(
  custodyOwner: object,
  runtime: object,
  sessionId: string
) {
  const view = readOriginalTestModeNativeCustodyMaps(custodyOwner);
  const own = view.testModeNativeConstructors.get(runtime);
  if (!own) return undefined;
  const entry = view.originalMapGet.call(own.entries, sessionId) as TestModeNativeEntry | undefined;
  if (
    !entry ||
    entry.retired ||
    view.nativeSignalAborted.call(entry.controller.signal) ||
    entry.scenarioStarts !== 1 ||
    entry.canonicalSessionId === entry.sessionId
  )
    return { canonicalId: undefined };
  const time = Date.now(),
    activity = captureNativeSessionActivity(entry.acquisition, time);
  const current =
    activity &&
    (readNativeSessionAcquisition(entry.acquisition, activity, time, entry.sessionId) ||
      readNativeSessionAcquisition(entry.acquisition, activity, time, entry.canonicalSessionId));
  return {
    canonicalId:
      current && !entry.retired && !view.nativeSignalAborted.call(entry.controller.signal)
        ? entry.canonicalSessionId
        : undefined,
  };
}
/** Capture canonical restart evidence from the original TestMode constructor. */
export function captureTestModeOriginalCanonicalRestart(
  custodyOwner: object,
  runtime: object,
  sessionId: string,
  db: Db
): OriginalTestModeCanonicalRestart {
  const view = readOriginalTestModeNativeCustodyMaps(custodyOwner);
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const own = view.testModeNativeConstructors.get(runtime);
  if (!own) throw new Error('Original canonical TestMode constructor required');
  return own.captureRestart(sessionId, db);
}
/** Read-only DATA. Positive closure is checked against the original entry and lock retirement witness. */
export function readTestModeOriginalCanonicalRestart(
  custodyOwner: object,
  runtime: object,
  token: OriginalTestModeCanonicalRestart,
  db: Db
): Readonly<{ canonicalId: string; closed: boolean }> {
  const view = readOriginalTestModeNativeCustodyMaps(custodyOwner);
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const own = view.originalCanonicalRestarts.get(token);
  if (!own || own.runtime !== runtime || own.db !== db)
    throw new Error('Foreign original canonical restart');
  if (!own.entry.closed || readOriginalDetachedTurnLifecycleClosed(own.entry.holder) !== true)
    return Object.freeze({ canonicalId: own.entry.canonicalSessionId, closed: false });
  requireOriginalNativeSessionAcquisitionRetired(
    own.locks,
    own.entry.acquisition,
    own.entry.holder
  );
  return Object.freeze({ canonicalId: own.entry.canonicalSessionId, closed: true });
}
/** Transfer only this constructor's genuine old/new acquisitions and privately assigned identity. */
export function moveTestModeOriginalLockedAcquisition(
  custodyOwner: object,
  runtime: object,
  oldKey: string,
  canonicalKey: string,
  holder: SseResponse
): boolean | undefined {
  const view = readOriginalTestModeNativeCustodyMaps(custodyOwner);
  return view.testModeNativeConstructors.get(runtime)?.move(oldKey, canonicalKey, holder);
}
/** Send through the original locked TestMode message operation. */
export function sendTestModeOriginalLockedMessage(
  custodyOwner: object,
  runtime: object,
  session: string,
  text: string,
  opts: MessageOpts | undefined,
  holder: SseResponse,
  key: string
) {
  const view = readOriginalTestModeNativeCustodyMaps(custodyOwner);
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  return view.testModeNativeConstructors.get(runtime)?.locked(session, text, opts, holder, key);
}
/** Prepare the original locked TestMode Room responder. */
export function prepareTestModeOriginalLockedRoomResponder(
  custodyOwner: object,
  runtime: object,
  holder: SseResponse,
  key: string,
  source: OriginalFrozenRoomSource
): Promise<PreparedRoomResponder | undefined> {
  const view = readOriginalTestModeNativeCustodyMaps(custodyOwner);
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  return (
    view.testModeNativeConstructors.get(runtime)?.prepare(source, holder, key) ??
    Promise.resolve(undefined)
  );
}
/** Read the original TestMode Room responder preparation. */
export function readTestModePreparedRoomResponder(
  custodyOwner: object,
  runtime: object,
  prepared: PreparedRoomResponder
) {
  const view = readOriginalTestModeNativeCustodyMaps(custodyOwner);
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const own = view.testModePrepared.get(prepared);
  if (!own || own.runtime !== runtime) return undefined;
  const at = Date.now(),
    activity = captureNativeSessionActivity(own.entry.acquisition, at);
  const native = readTestModeNativeOperation(custodyOwner, own.nativeOperation);
  if (
    !native ||
    !activity ||
    !readNativeSessionAcquisition(own.entry.acquisition, activity, at, own.entry.sessionId) ||
    view.testModePrepared.get(prepared) !== own ||
    !readTestModeNativeOperation(custodyOwner, own.nativeOperation)
  )
    return undefined;
  return Object.freeze({
    source: own.source,
    nativeOperation: own.nativeOperation,
    acquisition: own.entry.acquisition,
    native,
  });
}
/** Retire the original TestMode Room responder preparation. */
export function retireTestModePreparedRoomResponder(
  custodyOwner: object,
  runtime: object,
  prepared: PreparedRoomResponder
) {
  const view = readOriginalTestModeNativeCustodyMaps(custodyOwner);
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const own = view.testModePrepared.get(prepared);
  if (!own || own.runtime !== runtime) throw new Error('TestMode preparation is not original.');
  view.testModePrepared.delete(prepared);
  return own.retire();
}
/** Start the original TestMode responder from its committed native operation. */
export function startTestModeCommittedRoomResponder(
  custodyOwner: object,
  runtime: object,
  prepared: PreparedRoomResponder,
  committed?: OriginalCommittedRoomResponder
): AsyncGenerator<StreamEvent> {
  const view = readOriginalTestModeNativeCustodyMaps(custodyOwner);
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const own = view.testModePrepared.get(prepared);
  if (!own || own.runtime !== runtime) throw new Error('TestMode preparation is not original.');
  requireOriginalCommittedRoomResponder(committed, runtime, prepared, own.nativeOperation);
  if (!committed) throw new Error('TestMode requires original COMMIT/FIRST.');
  return own.start(committed);
}
/** Read evidence from the original TestMode Room responder stream. */
export function readTestModeOriginalRoomResponderStream(
  custodyOwner: object,
  runtime: object | undefined,
  stream: object,
  event?: StreamEvent
) {
  const view = readOriginalTestModeNativeCustodyMaps(custodyOwner);
  stream = readOriginalRegisteredNativeStream(stream) ?? stream;
  if (runtime) runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const own = view.testModeStreams.get(stream);
  if (
    !own ||
    (runtime !== undefined && runtime !== own.runtime) ||
    (event && !own.events.has(event))
  )
    return undefined;
  return {
    runtime: own.runtime,
    prepared: own.prepared,
    operation: own.operation,
    committed: own.committed,
    outcome: own.terminal,
  };
}
