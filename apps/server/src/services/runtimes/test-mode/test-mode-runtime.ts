import { captureTurnLevelOptions } from '../../core/turn-power/turn-levels.js';
import { randomUUID } from 'node:crypto';
import type { Db } from '@dorkos/db';
import { RoomContextDataSchema, type RoomContextData } from '@dorkos/shared/additional-context';
import type { DocChannelStore } from '../../canvas/doc-channel/store.js';
import {
  readInstallationOriginalRoomEmitter,
  type InstallationFileWrites,
} from '../../canvas/doc-channel/writes/installation-file-writes.js';
import {
  requireOriginalDownstreamRoomEmissionClosed,
  sendOriginalRoomResponderScriptStep,
  type OriginalDownstreamRoomEmitter,
} from '../../canvas/doc-channel/downstream/native-room-emitter.js';
import {
  rekeyOriginalRuntimeSessionSettings,
  readOriginalRegisteredRuntime,
  readOriginalRegisteredRuntimeStream,
  readOriginalRegisteredNativeStream,
} from '../../core/runtime-registry.js';
import { env } from '../../../env.js';
import type { ConnectorRuntimeTools } from '../connector-tools.js';
import type {
  ConnectorRuntimePrincipalPort,
  OpenConnectorTurnResult,
} from '../../connectors/runtime-principal-port.js';
import {
  openOriginalNativeTurn,
  requireCurrentOriginalNativeTurn,
  resolveOriginalNativePrincipal,
  requireOriginalNativePrincipalPort,
  requireNativePrincipalDatabase,
  requireSameOriginalNativePrincipalPorts,
  retireOriginalNativeTurn,
} from '../../connectors/principal/runtime-principal-service.js';
import {
  SessionLockManager,
  captureNativeSessionAcquisition,
  captureNativeSessionActivity,
  readNativeSessionAcquisition,
  isNativeSessionAcquisitionMove,
  isOriginalNativeSessionAcquisitionAlias,
  requireOriginalNativeSessionAcquisitionRetired,
  type NativeSessionAcquisition,
} from '../../session/session-lock.js';
import {
  captureOriginalRoomDispatchLifecycle,
  readOriginalRoomLaunchHolder,
  readOriginalDetachedTurnLifecycleClosed,
  readOriginalPreparedRoomContext,
  readOriginalRoomDispatchLifecycle,
} from '../../session/trigger-turn.js';
import type { OriginalRoomDispatchCustody } from '../../rooms/service/room-core.js';
import {
  readOriginalFrozenRoomTarget,
  requireOriginalRoomPrincipalService,
} from '../../canvas/doc-channel/operations/room-current-operation.js';
import {
  requireOriginalCommittedRoomResponder,
  requireCurrentOriginalCommittedRoomResponder,
  consumeOriginalCommittedRoomResponder,
  retireOriginalCommittedRoomResponder,
} from '../../canvas/doc-channel/operations/room-responder-operation.js';
import type {
  OriginalFrozenRoomSource,
  PreparedRoomResponder,
  OriginalCommittedRoomResponder,
} from '../../canvas/doc-channel/current/current-operation-types.js';

type TestModeNativeEntry = {
  runtime: TestModeRuntime;
  sessionId: string;
  canonicalSessionId: string;
  path: string;
  acquisition: NativeSessionAcquisition;
  controller: AbortController;
  retired: boolean;
  closed: boolean;
  holder: SseResponse;
  scenarioStarts: number;
  interrupted?: true;
  placementOptions?: Readonly<{
    cwd?: string;
    forAgent?: string;
    additionalDirectories?: readonly Readonly<{ path: string; access: 'read' | 'write' }>[];
  }>;
  canonicalScenarioStarted?: true;
  roomOrigin?: { holder: SseResponse; custody: OriginalRoomDispatchCustody };
  closeScenario?: () => void;
};
type TestModeInstalled = {
  entry: TestModeNativeEntry;
  operation: object;
  retire(): Promise<void>;
  open(): Promise<OpenConnectorTurnResult>;
};
type TestModePreparation = {
  runtime: TestModeRuntime;
  source: OriginalFrozenRoomSource;
  nativeOperation: object;
  entry: TestModeNativeEntry;
  binding: OpenConnectorTurnResult;
  retire(): Promise<void>;
  start(committed: OriginalCommittedRoomResponder): AsyncGenerator<StreamEvent>;
};
const testModeNativeConstructors = new WeakMap<
  object,
  {
    entries: Map<string, TestModeNativeEntry>;
    scenarioStarts: () => number;
    isLaunchAlias(
      request: import('../../rooms/room-turn-port.js').RoomTurnRequest,
      retiredId: string
    ): boolean;
    readPreparedRoomContext(sessionId: string): RoomContextData | undefined;
    readActiveStream(sessionId: string): AsyncGenerator<StreamEvent> | undefined;
    captureRestart(sessionId: string, db: Db): OriginalTestModeCanonicalRestart;
    move(oldKey: string, canonicalKey: string, holder: SseResponse): boolean;
    captureEmitter(owner: InstallationFileWrites, db: Db, store: DocChannelStore): void;
    requireEmitterClosed(db: Db): void;
    locked(
      session: string,
      text: string,
      opts: MessageOpts | undefined,
      holder: SseResponse,
      key: string
    ): AsyncGenerator<StreamEvent>;
    prepare(
      source: OriginalFrozenRoomSource,
      holder: SseResponse,
      key: string
    ): Promise<PreparedRoomResponder | undefined>;
  }
>();
const testModeNativeOperations = new WeakMap<object, TestModeNativeEntry>();
const testModePrepared = new WeakMap<PreparedRoomResponder, TestModePreparation>();
const testModeOriginalStreams = new WeakMap<
  object,
  {
    runtime: TestModeRuntime;
    own: TestModeInstalled;
    sessionId: string;
    options: Readonly<MessageOpts>;
    stopContinuation(): boolean;
    stopEvents: WeakSet<object>;
    resolve(): Promise<
      import('../../connectors/runtime-principal-port.js').ResolveConnectorTurnResult
    >;
  }
>();
/** Constructor-native launch alias recognition; unknown/foreign producers stay on the ordinary busy path. */
export function isTestModeOriginalRoomLaunchAlias(
  runtime: object,
  request: import('../../rooms/room-turn-port.js').RoomTurnRequest,
  retiredId: string
): boolean {
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  return testModeNativeConstructors.get(runtime)?.isLaunchAlias(request, retiredId) === true;
}
/** Installation-only capture into the original constructor; no emitter argument or public setter. */
export function captureTestModeOriginalRoomEmitter(
  runtime: object,
  owner: InstallationFileWrites,
  db: Db,
  store: DocChannelStore
): void {
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const own = testModeNativeConstructors.get(runtime);
  if (!own) throw new Error('Original dedicated TestMode constructor required.');
  own.captureEmitter(owner, db, store);
}
/** Historical DATA from actual original native entry; this never authorizes a Room launch. */
export function readTestModeOriginalPreparedRoomContext(
  runtime: object,
  sessionId: string
): RoomContextData | undefined {
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  return testModeNativeConstructors.get(runtime)?.readPreparedRoomContext(sessionId);
}
/** Lookup only: the actual held native stream remains recognized by its original private operation. */
/** DATA-only observation of options consumed by an actually started original native entry. */
export function readTestModeOriginalPlacementOptions(runtime: object, sessionId: string) {
  const entry = testModeNativeConstructors.get(runtime)?.entries.get(sessionId);
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
export function readTestModeOriginalActiveStream(runtime: object, sessionId: string) {
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  return testModeNativeConstructors.get(runtime)?.readActiveStream(sessionId);
}
/** Fixed actual producer stream identity; possession of copied stream fields never issues. */
export function readTestModeOriginalNativeStream(runtime: object, stream: object) {
  stream = readOriginalRegisteredRuntimeStream(runtime, stream) ?? stream;
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const own = testModeOriginalStreams.get(stream);
  if (!own || own.runtime !== runtime || !readTestModeNativeOperation(own.own.operation))
    return undefined;
  return Object.freeze({ operation: own.own.operation });
}
/** Lookup original construction-captured turn DATA without reopening retired native authority. */
export function readTestModeOriginalNativeTurnOptions(
  runtime: object,
  sessionId: string,
  stream: object
) {
  const own = testModeOriginalStreams.get(stream);
  return own &&
    own.runtime === runtime &&
    own.sessionId === sessionId &&
    readTestModeNativeOperation(own.own.operation)
    ? { options: own.options }
    : undefined;
}
/** Read only the exact original Stop terminal DATA; retired native authority remains unavailable. */
export function readTestModeOriginalStopTerminalData(
  runtime: object,
  stream: object,
  event?: StreamEvent
): boolean {
  stream = readOriginalRegisteredRuntimeStream(runtime, stream) ?? stream;
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const own = testModeOriginalStreams.get(stream);
  return (
    !!own &&
    own.runtime === runtime &&
    own.stopContinuation() &&
    (event === undefined || own.stopEvents.has(event))
  );
}
/** Uses the real original service's captured policy and native SQL gate after its awaits. */
export function resolveTestModeOriginalNativeStreamPrincipal(runtime: object, stream: object) {
  stream = readOriginalRegisteredRuntimeStream(runtime, stream) ?? stream;
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const own = testModeOriginalStreams.get(stream);
  if (!own || own.runtime !== runtime || !readTestModeNativeOperation(own.own.operation))
    return Promise.resolve({ status: 'refused' as const, reason: 'revoked' as const });
  return own.resolve();
}
/** Historical effect evidence only, keyed by an actual constructor-created raw stream. No permission is returned. */
export function readTestModeOriginalScenarioEvidence(runtime: object, stream: object) {
  stream = readOriginalRegisteredRuntimeStream(runtime, stream) ?? stream;
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const own = testModeOriginalStreams.get(stream);
  if (!own || own.runtime !== runtime) return undefined;
  return Object.freeze({
    scenarioStarts: own.own.entry.scenarioStarts,
    retired: own.own.entry.retired,
    sessionId: own.own.entry.sessionId,
  });
}
/** Pump closure gate on the genuine constructor-created stream, after actual owned drains. */
export function requireTestModeOriginalRoomEmissionClosed(
  runtime: object,
  stream: object,
  db: Db
): void {
  stream = readOriginalRegisteredRuntimeStream(runtime, stream) ?? stream;
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const original = testModeOriginalStreams.get(stream),
    constructor = testModeNativeConstructors.get(runtime);
  if (
    !original ||
    original.runtime !== runtime ||
    !constructor ||
    !original.own.entry.retired ||
    original.own.entry.scenarioStarts !== 1 ||
    !testModeStreams.has(stream)
  )
    throw new Error('Original retired ONE TestMode Room stream required');
  constructor.requireEmitterClosed(db);
}
/** Cumulative DATA from the actual native constructor; an unrecognized runtime is UNKNOWN, never zero. */
export function readTestModeOriginalScenarioCounts(
  runtime: object
): Readonly<{ scenarioStarts: number }> | undefined {
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const own = testModeNativeConstructors.get(runtime);
  if (!own) return undefined;
  return Object.freeze({ scenarioStarts: own.scenarioStarts() });
}
const testModeStreams = new WeakMap<
  object,
  {
    runtime: object;
    prepared: PreparedRoomResponder;
    operation: object;
    committed: OriginalCommittedRoomResponder;
    events: WeakSet<object>;
    terminal?: 'turn_done' | 'failed' | 'cancelled';
    retire(): Promise<void>;
  }
>();
const nativeSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const originalMapGet = Map.prototype.get;
const originalObjectFreeze = Object.freeze;
const originalMapSet = Map.prototype.set;
const originalMapEntries = Map.prototype.entries;
/** Constructor recognition selects only this internal runtime lane; it is not document permission. */
export function isOriginalNativeTestModeRuntime(runtime: object): boolean {
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  return testModeNativeConstructors.has(runtime);
}
/** Actual TestMode constructor/entry only; a logical runtime alias cannot confer authority. */
export function readTestModeNativeOperation(token: object) {
  const entry = testModeNativeOperations.get(token);
  const owner = entry && testModeNativeConstructors.get(entry.runtime);
  if (
    !entry ||
    !owner ||
    entry.retired ||
    nativeSignalAborted.call(entry.controller.signal) ||
    originalMapGet.call(owner.entries, entry.sessionId) !== entry
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
export function readTestModeOriginalCanonicalSessionId(runtime: object, sessionId: string) {
  const own = testModeNativeConstructors.get(runtime);
  if (!own) return undefined;
  const entry = originalMapGet.call(own.entries, sessionId) as TestModeNativeEntry | undefined;
  if (
    !entry ||
    entry.retired ||
    nativeSignalAborted.call(entry.controller.signal) ||
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
      current && !entry.retired && !nativeSignalAborted.call(entry.controller.signal)
        ? entry.canonicalSessionId
        : undefined,
  };
}
/** Opaque observation of one real held canonical producer; no alias/source authority is issued. */
export interface OriginalTestModeCanonicalRestart {
  readonly kind: 'original-testmode-canonical-restart';
}
const originalCanonicalRestarts = new WeakMap<
  OriginalTestModeCanonicalRestart,
  {
    runtime: TestModeRuntime;
    db: Db;
    entry: TestModeNativeEntry;
    locks: SessionLockManager;
  }
>();
/** Capture canonical restart evidence from the original TestMode constructor. */
export function captureTestModeOriginalCanonicalRestart(
  runtime: object,
  sessionId: string,
  db: Db
): OriginalTestModeCanonicalRestart {
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const own = testModeNativeConstructors.get(runtime);
  if (!own) throw new Error('Original canonical TestMode constructor required');
  return own.captureRestart(sessionId, db);
}
/** Read-only DATA. Positive closure is checked against the original entry and lock retirement witness. */
export function readTestModeOriginalCanonicalRestart(
  runtime: object,
  token: OriginalTestModeCanonicalRestart,
  db: Db
): Readonly<{ canonicalId: string; closed: boolean }> {
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const own = originalCanonicalRestarts.get(token);
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
  runtime: object,
  oldKey: string,
  canonicalKey: string,
  holder: SseResponse
): boolean | undefined {
  return testModeNativeConstructors.get(runtime)?.move(oldKey, canonicalKey, holder);
}
/** Send through the original locked TestMode message operation. */
export function sendTestModeOriginalLockedMessage(
  runtime: object,
  session: string,
  text: string,
  opts: MessageOpts | undefined,
  holder: SseResponse,
  key: string
) {
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  return testModeNativeConstructors.get(runtime)?.locked(session, text, opts, holder, key);
}
/** Prepare the original locked TestMode Room responder. */
export function prepareTestModeOriginalLockedRoomResponder(
  runtime: object,
  holder: SseResponse,
  key: string,
  source: OriginalFrozenRoomSource
): Promise<PreparedRoomResponder | undefined> {
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  return (
    testModeNativeConstructors.get(runtime)?.prepare(source, holder, key) ??
    Promise.resolve(undefined)
  );
}
/** Read the original TestMode Room responder preparation. */
export function readTestModePreparedRoomResponder(
  runtime: object,
  prepared: PreparedRoomResponder
) {
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const own = testModePrepared.get(prepared);
  if (!own || own.runtime !== runtime) return undefined;
  const at = Date.now(),
    activity = captureNativeSessionActivity(own.entry.acquisition, at);
  const native = readTestModeNativeOperation(own.nativeOperation);
  if (
    !native ||
    !activity ||
    !readNativeSessionAcquisition(own.entry.acquisition, activity, at, own.entry.sessionId) ||
    testModePrepared.get(prepared) !== own ||
    !readTestModeNativeOperation(own.nativeOperation)
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
  runtime: object,
  prepared: PreparedRoomResponder
) {
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const own = testModePrepared.get(prepared);
  if (!own || own.runtime !== runtime) throw new Error('TestMode preparation is not original.');
  testModePrepared.delete(prepared);
  return own.retire();
}
/** Start the original TestMode responder from its committed native operation. */
export function startTestModeCommittedRoomResponder(
  runtime: object,
  prepared: PreparedRoomResponder,
  committed?: OriginalCommittedRoomResponder
): AsyncGenerator<StreamEvent> {
  runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const own = testModePrepared.get(prepared);
  if (!own || own.runtime !== runtime) throw new Error('TestMode preparation is not original.');
  requireOriginalCommittedRoomResponder(committed, runtime, prepared, own.nativeOperation);
  if (!committed) throw new Error('TestMode requires original COMMIT/FIRST.');
  return own.start(committed);
}
/** Read evidence from the original TestMode Room responder stream. */
export function readTestModeOriginalRoomResponderStream(
  runtime: object | undefined,
  stream: object,
  event?: StreamEvent
) {
  stream = readOriginalRegisteredNativeStream(stream) ?? stream;
  if (runtime) runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;
  const own = testModeStreams.get(stream);
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

import { renderDocEvents } from '../../canvas/doc-channel/prompt.js';
import type {
  AgentRuntime,
  DependencyCheck,
  DeliverIntoTurnOpts,
  RuntimeCapabilities,
  RuntimeDeliveryResult,
  SessionOpts,
  SessionWarmth,
  MessageOpts,
  CommandIntentOpts,
  SseResponse,
  ManagedMcpServerResolver,
  McpAppServerConnection,
  InteractionAnswerOptions,
  ToolDecisionOptions,
  SessionUpdateResult,
  SessionSettingsPort,
} from '@dorkos/shared/agent-runtime';
import type { McpServerEntry } from '@dorkos/shared/transport';
import type {
  StreamEvent,
  Session,
  HistoryMessage,
  TaskItem,
  ModelOption,
  CommandRegistry,
  InterruptReceipt,
  SessionSettings,
} from '@dorkos/shared/types';
import type {
  SessionSnapshot,
  SessionEvent,
  SessionListEvent,
} from '@dorkos/shared/session-stream';
import type { RuntimeCommandIntentId } from '@dorkos/shared/command-intents';
import type { RelayCore } from '@dorkos/relay';
import {
  disposeProjector,
  getOrCreateProjector,
  getSessionEventStore,
  peekProjector,
  streamGenerationOf,
} from '../../session/session-state-projector.js';
import { logger } from '../../../lib/logger.js';
import { reconstructHistoryFromEvents } from '../../session/event-log-history.js';
import { readLogBackedHistory } from '../../session/log-backed-history.js';
import { heldProcesses } from './held-process.js';
import { ScenarioAborted, interactionGate } from './interaction-gate.js';
import {
  declaredInterruptOutcome,
  scenarioStore,
  originalRoomPartialAckReplyScenario,
  originalNativeCanonicalRekeyScenario,
} from './scenario-store.js';
import { TestModeSessionRegistry } from './session-registry.js';
import { TEST_MODE_CAPABILITIES } from './runtime-constants.js';

/**
 * Canonical ids a test has declared for a first turn, keyed by the id the client
 * minted, plus whether the turn that reveals one has started.
 *
 * **Module-scoped, not per-instance**, exactly as `heldProcesses` and the
 * scenario store are. An e2e server registers up to three TestModeRuntime
 * instances (`test-mode`, `test-mode-b`, and a `claude-code`-typed alias), and
 * which one a session resolves to depends on what the first write binds it to —
 * which is decided AFTER a test has declared the rename. Holding this per
 * instance meant the declaration landed on one object and the turn ran on
 * another, and the session was simply never renamed, with nothing saying so.
 *
 * See {@link TestModeRuntime.declareCanonicalSessionId}.
 */
const declaredCanonicalIds = new Map<string, { canonicalId: string; revealed: boolean }>();

/**
 * A zero-latency, STATELESS AgentRuntime that yields StreamEvents from the
 * scenario store and persists NOTHING natively: completed history is
 * reconstructed from the DorkOS-owned EventLog (via the session projector),
 * live events come from the projector's seq'd stream, and session discovery
 * comes from an in-memory tracked set with no filesystem watch. This is the
 * end-to-end proof that the snapshot/subscribe/list contract has no baked-in
 * JSONL/file assumptions (spec chat-stream-reconnection task #15, ADR-0263
 * Decision 1). Registered instead of ClaudeCodeRuntime when
 * DORKOS_TEST_RUNTIME=true.
 *
 * The original test boot constructs this adapter only when its environment flag
 * is enabled. Fixed native readers now import this module for lookup-only
 * constructor recognition; importing it does not construct a runtime or run a
 * scenario/provider. Dedicated authority remains unavailable outside test boot.
 */
export class TestModeRuntime implements AgentRuntime {
  readonly type: string;
  readonly #nativeLocks = new SessionLockManager();
  readonly #nativeEntries = new Map<string, TestModeNativeEntry>();
  readonly #originalNativeCanonicalAliases = new Map<string, string>();
  readonly #preparedRoomContexts = new Map<string, RoomContextData>();
  readonly #activeNativeStreams = new Map<string, AsyncGenerator<StreamEvent>>();
  #nativeTools: Readonly<ConnectorRuntimeTools> | undefined;
  #nativePrincipals: ConnectorRuntimePrincipalPort | undefined;

  private readonly registry: TestModeSessionRegistry;
  private readonly capabilities: RuntimeCapabilities;
  private settingsPort: SessionSettingsPort | undefined;
  /** The managed-MCP server resolver, injected at boot; drives {@link getMcpStatus}. */
  private managedMcp: ManagedMcpServerResolver | undefined;
  /** Turns running right now, per session; drives {@link isTurnOpen}. */
  private readonly openTurns = new Map<string, number>();

  /**
   * Create a test-mode runtime instance registered under `type`.
   *
   * @param type - Runtime type identifier this instance registers under.
   *   Defaults to `'test-mode'`. e2e servers register a SECOND instance under
   *   a distinct type (`DORKOS_TEST_RUNTIME_SECONDARY=true` in index.ts) so
   *   multi-runtime UI — the status-bar picker, `?runtime=` launch binding,
   *   session-list runtime marks — is testable with zero real agent binaries.
   */
  #nativeRoomEmitter: OriginalDownstreamRoomEmitter | undefined;
  #nativeRoomEmitterCaptureStarted = false;
  #originalScenarioStarts = 0;
  constructor(type = 'test-mode', nativePrincipals?: ConnectorRuntimePrincipalPort) {
    this.type = type;
    // Sessions must carry their owning instance's type, not a hardcoded
    // 'test-mode', so session-list marks distinguish the two instances.
    this.registry = new TestModeSessionRegistry(type);
    // Only this actual constructor under the real test boot owns the dedicated alias lane.
    if (nativePrincipals) {
      if (!env.DORKOS_TEST_RUNTIME || type !== 'claude-code')
        throw new Error('Dedicated TestMode principal capture requires the actual test boot lane.');
      requireOriginalNativePrincipalPort(nativePrincipals);
      this.#nativePrincipals = nativePrincipals;
    }
    if (env.DORKOS_TEST_RUNTIME && type === 'claude-code') {
      testModeNativeConstructors.set(this, {
        entries: this.#nativeEntries,
        scenarioStarts: () => this.#originalScenarioStarts,
        isLaunchAlias: (request, retiredId) => {
          const launch = readOriginalRoomLaunchHolder(request);
          const canonical = originalMapGet.call(this.#originalNativeCanonicalAliases, retiredId) as
            string | undefined;
          if (
            !launch ||
            (readOriginalRegisteredRuntime(launch.runtime) ?? launch.runtime) !== this ||
            canonical !== launch.key
          )
            return false;
          const acquisition = captureNativeSessionAcquisition(
            this.#nativeLocks,
            launch.key,
            launch.holder
          );
          return (
            !!acquisition &&
            isOriginalNativeSessionAcquisitionAlias(
              this.#nativeLocks,
              acquisition,
              launch.holder,
              launch.key,
              retiredId
            ) &&
            readOriginalRoomLaunchHolder(request) === launch &&
            originalMapGet.call(this.#originalNativeCanonicalAliases, retiredId) === canonical
          );
        },
        readPreparedRoomContext: (sessionId) => {
          const context = this.#preparedRoomContexts.get(sessionId);
          return context ? RoomContextDataSchema.parse(context) : undefined;
        },
        readActiveStream: (sessionId) => {
          const stream = this.#activeNativeStreams.get(sessionId);
          return stream && readTestModeOriginalNativeStream(this, stream) ? stream : undefined;
        },
        captureRestart: (sessionId, db) => {
          if (!this.#nativePrincipals)
            throw new Error('Original canonical principal assembly required');
          requireNativePrincipalDatabase(this.#nativePrincipals, db);
          const entry = originalMapGet.call(this.#nativeEntries, sessionId) as
            TestModeNativeEntry | undefined;
          if (
            !entry ||
            entry.retired ||
            entry.roomOrigin ||
            !entry.canonicalScenarioStarted ||
            entry.scenarioStarts !== 1 ||
            nativeSignalAborted.call(entry.controller.signal)
          )
            throw new Error('Original held interactive canonical producer required');
          const time = Date.now(),
            activity = captureNativeSessionActivity(entry.acquisition, time);
          if (
            !activity ||
            !readNativeSessionAcquisition(
              entry.acquisition,
              activity,
              time,
              entry.canonicalSessionId
            )
          )
            throw new Error('Original held canonical acquisition required');
          const token: OriginalTestModeCanonicalRestart = Object.freeze({
            kind: 'original-testmode-canonical-restart',
          });
          originalCanonicalRestarts.set(token, {
            runtime: this,
            db,
            entry,
            locks: this.#nativeLocks,
          });
          return token;
        },
        move: (oldKey, canonicalKey, holder) => {
          const entry = originalMapGet.call(this.#nativeEntries, oldKey) as
            TestModeNativeEntry | undefined;
          if (
            !entry ||
            entry.retired ||
            entry.canonicalSessionId !== canonicalKey ||
            nativeSignalAborted.call(entry.controller.signal)
          )
            return false;
          const time = Date.now(),
            activity = captureNativeSessionActivity(entry.acquisition, time);
          if (!activity || !readNativeSessionAcquisition(entry.acquisition, activity, time, oldKey))
            return false;
          const next = captureNativeSessionAcquisition(this.#nativeLocks, canonicalKey, holder);
          if (!next || !isNativeSessionAcquisitionMove(entry.acquisition, next, holder))
            return false;
          entry.acquisition = next;
          // Historical alias DATA comes only from this actual native acquisition move.
          // Public declared test renames cannot certify a constructor-native launch.
          for (const [id, current] of originalMapEntries.call(this.#originalNativeCanonicalAliases))
            if (current === oldKey)
              originalMapSet.call(this.#originalNativeCanonicalAliases, id, canonicalKey);
          originalMapSet.call(this.#originalNativeCanonicalAliases, oldKey, canonicalKey);
          return true;
        },
        captureEmitter: (owner, db, store) => {
          if (this.#nativeRoomEmitterCaptureStarted || !this.#nativePrincipals)
            throw new Error(
              'Original TestMode emitter capture is unavailable or already consumed.'
            );
          this.#nativeRoomEmitterCaptureStarted = true;
          this.#nativeRoomEmitter = readInstallationOriginalRoomEmitter(
            owner,
            db,
            store,
            this.#nativePrincipals
          );
        },
        requireEmitterClosed: (db) => {
          if (!this.#nativeRoomEmitter)
            throw new Error('Original installed TestMode emitter required');
          requireOriginalDownstreamRoomEmissionClosed(this.#nativeRoomEmitter, db);
        },
        locked: (session, text, opts, holder, key) => {
          const acquisition = captureNativeSessionAcquisition(this.#nativeLocks, key, holder);
          if (!acquisition || session !== key || !opts?.cwd || !this.#nativePrincipals)
            throw new Error(
              'TestMode native turn requires its actual lock, path and principal assembly.'
            );
          const custody = captureOriginalRoomDispatchLifecycle(holder, this);
          const own = this.#installNative(
            session,
            opts.cwd,
            acquisition,
            holder,
            custody ? { holder, custody } : undefined
          );
          return this.#nativeStream(session, text, opts, own);
        },
        prepare: (source, holder, key) => this.#prepareNative(source, holder, key),
      });
    }
    // Capabilities are identical across instances except the identity field;
    // the default instance returns the shared constant BY REFERENCE (the
    // capabilities contract test pins that).
    this.capabilities =
      type === TEST_MODE_CAPABILITIES.type
        ? TEST_MODE_CAPABILITIES
        : { ...TEST_MODE_CAPABILITIES, type };
  }

  /** Existing boot tooling shape; capture once, never accept a caller currentness callback. */
  setConnectorRuntimeTools(tools: ConnectorRuntimeTools): void {
    if (this.#nativeTools) throw new Error('TestMode principal assembly is already captured.');
    requireOriginalNativePrincipalPort(tools.principals);
    if (this.#nativePrincipals)
      requireSameOriginalNativePrincipalPorts(this.#nativePrincipals, tools.principals);
    this.#nativePrincipals = tools.principals;
    this.#nativeTools = Object.freeze({ ...tools });
  }
  #installNative(
    sessionId: string,
    path: string,
    acquisition: NativeSessionAcquisition,
    holder: SseResponse,
    roomOrigin?: TestModeNativeEntry['roomOrigin']
  ): TestModeInstalled {
    if (!testModeNativeConstructors.has(this) || this.#nativeEntries.has(sessionId))
      throw new Error('TestMode native slot is unavailable.');
    const entry: TestModeNativeEntry = {
      runtime: this,
      sessionId,
      canonicalSessionId: sessionId,
      path,
      acquisition,
      controller: new AbortController(),
      retired: false,
      closed: false,
      holder,
      scenarioStarts: 0,
      roomOrigin,
    };
    const operation = Object.freeze({});
    this.#nativeEntries.set(sessionId, entry);
    testModeNativeOperations.set(operation, entry);
    let binding: OpenConnectorTurnResult | undefined;
    let retirement: Promise<void> | undefined;
    const retire = (): Promise<void> => {
      if (retirement) return retirement;
      entry.retired = true;
      if (this.#nativeEntries.get(sessionId) === entry) this.#nativeEntries.delete(sessionId);
      retirement = Promise.resolve().then(async () => {
        let failed = false,
          first: unknown;
        try {
          entry.controller.abort();
        } catch (cause) {
          failed = true;
          first = cause;
        }
        try {
          entry.closeScenario?.();
        } catch (cause) {
          if (!failed) {
            failed = true;
            first = cause;
          }
        }
        try {
          if (binding)
            await retireOriginalNativeTurn(this.#nativePrincipals!, operation, 'turn_terminal');
        } catch (cause) {
          if (!failed) {
            failed = true;
            first = cause;
          }
        }
        if (failed) throw first;
        entry.closed = true;
      });
      return retirement;
    };
    return {
      entry,
      operation,
      retire,
      open: async () => {
        binding = await openOriginalNativeTurn(
          this.#nativePrincipals!,
          {
            runtime: 'claude-code',
            canonicalSessionId: sessionId,
            agentPath: path,
            canonicalCwd: path,
            signal: entry.controller.signal,
          },
          operation
        );
        if (entry.retired) {
          await retireOriginalNativeTurn(this.#nativePrincipals!, operation, 'setup_failed');
          throw new Error('TestMode native opening completed after retirement.');
        }
        return binding;
      },
    };
  }
  async #prepareNative(
    source: OriginalFrozenRoomSource,
    holder: SseResponse,
    key: string
  ): Promise<PreparedRoomResponder | undefined> {
    const principals = this.#nativePrincipals;
    if (!principals || this.#nativeEntries.has(key)) return undefined;
    const target = readOriginalFrozenRoomTarget(source, 'claude-code');
    requireOriginalRoomPrincipalService(source, principals);
    const acquisition = captureNativeSessionAcquisition(this.#nativeLocks, key, holder);
    if (!acquisition || target.sessionId !== key) return undefined;
    const own = this.#installNative(key, target.agentPath, acquisition, holder);
    try {
      const binding = await own.open();
      const prepared: PreparedRoomResponder = Object.freeze({ kind: 'prepared-room-responder' });
      let started = false;
      testModePrepared.set(prepared, {
        runtime: this,
        source,
        nativeOperation: own.operation,
        entry: own.entry,
        binding,
        retire: own.retire,
        start: (committed) => {
          if (started || !readTestModePreparedRoomResponder(this, prepared))
            throw new Error(
              'TestMode original preparation cannot start twice or after retirement.'
            );
          started = true;
          return this.#nativeStream(key, 'Document update', { cwd: target.agentPath }, own, {
            prepared,
            committed,
          });
        },
      });
      if (!readTestModePreparedRoomResponder(this, prepared)) {
        testModePrepared.delete(prepared);
        throw new Error('TestMode preparation retired during setup.');
      }
      return prepared;
    } catch (cause) {
      try {
        await own.retire();
      } catch {}
      throw cause;
    }
  }
  #nativeStream(
    sessionId: string,
    text: string,
    opts: MessageOpts | undefined,
    own: TestModeInstalled,
    room?: { prepared: PreparedRoomResponder; committed: OriginalCommittedRoomResponder }
  ) {
    own.entry.placementOptions = Object.freeze({
      ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts?.forAgent !== undefined ? { forAgent: opts.forAgent } : {}),
      ...(opts?.additionalDirectories !== undefined
        ? {
            additionalDirectories: Object.freeze(
              opts.additionalDirectories.map((grant) => Object.freeze({ ...grant }))
            ),
          }
        : {}),
    });
    let closed = false;
    let stopPhase = 0;
    const stopEvents = new WeakSet<object>();
    const stopContinuation = () =>
      !closed &&
      stopPhase < 3 &&
      own.entry.interrupted === true &&
      own.entry.retired &&
      nativeSignalAborted.call(own.entry.controller.signal) &&
      own.entry.scenarioStarts === 1 &&
      originalMapGet.call(this.#nativeEntries, sessionId) === own.entry;
    const streamCapture: { returned?: AsyncGenerator<StreamEvent> } = {};
    const run = async function* (this: TestModeRuntime): AsyncGenerator<StreamEvent> {
      let failed = false,
        first: unknown;
      try {
        if (!room) await own.open();
        if (!readTestModeNativeOperation(own.operation))
          throw new Error('TestMode native entry retired.');
        if (room) {
          requireCurrentOriginalCommittedRoomResponder(
            room.committed,
            this,
            room.prepared,
            own.operation
          );
        }
        const context = readOriginalPreparedRoomContext(this, own.entry.holder, sessionId, opts);
        if (!readTestModeNativeOperation(own.operation))
          throw new Error('TestMode native entry retired during context capture.');
        if (context) this.#preparedRoomContexts.set(sessionId, context);
        // Fixed original scenario continuation; public sendMessage replacement cannot redirect this effect.
        yield* this.#sendScenario(sessionId, text, opts, { own, room });
      } catch (cause) {
        failed = true;
        first = cause;
      } finally {
        if (room) {
          testModePrepared.delete(room.prepared);
          try {
            retireOriginalCommittedRoomResponder(
              room.committed,
              this,
              room.prepared,
              own.operation
            );
          } catch (cause) {
            if (!failed) {
              failed = true;
              first = cause;
            }
          }
        }
        try {
          await own.retire();
          if (
            streamCapture.returned &&
            this.#activeNativeStreams.get(sessionId) === streamCapture.returned
          )
            this.#activeNativeStreams.delete(sessionId);
        } catch (cause) {
          if (!failed) {
            failed = true;
            first = cause;
          }
        }
      }
      if (failed) throw first;
    }.call(this);
    const metadata = room
      ? {
          runtime: this,
          prepared: room.prepared,
          operation: own.operation,
          committed: room.committed,
          events: new WeakSet<object>(),
          terminal: undefined as 'turn_done' | 'failed' | 'cancelled' | undefined,
          retire: async () => {
            let failed = false,
              first: unknown;
            try {
              await close();
            } catch (cause) {
              failed = true;
              first = cause;
            }
            try {
              await run.return(undefined);
            } catch (cause) {
              if (!failed) {
                failed = true;
                first = cause;
              }
            }
            if (failed) throw first;
          },
        }
      : undefined;
    const close = async () => {
      if (closed) return;
      closed = true;
      // Retirement happens synchronously before the first cleanup await, including an unpulled stream.
      own.entry.retired = true;
      own.entry.controller.abort();
      let failed = false,
        first: unknown;
      if (room) {
        testModePrepared.delete(room.prepared);
        try {
          retireOriginalCommittedRoomResponder(room.committed, this, room.prepared, own.operation);
        } catch (cause) {
          failed = true;
          first = cause;
        }
      }
      try {
        await own.retire();
        if (
          streamCapture.returned &&
          this.#activeNativeStreams.get(sessionId) === streamCapture.returned
        )
          this.#activeNativeStreams.delete(sessionId);
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
      if (failed) throw first;
    };
    const returned: AsyncGenerator<StreamEvent> = {
      async next(value) {
        if (closed) return { done: true, value: undefined };
        const result = await run.next(value);
        if (stopContinuation()) {
          if (result.done) {
            stopPhase = 3;
          } else if (
            stopPhase === 0 &&
            result.value.type === 'session_status' &&
            'terminalReason' in result.value.data &&
            result.value.data.terminalReason === 'aborted_streaming'
          ) {
            originalObjectFreeze(result.value.data);
            originalObjectFreeze(result.value);
            stopEvents.add(result.value);
            stopPhase = 1;
          } else if (stopPhase === 1 && result.value.type === 'done') {
            originalObjectFreeze(result.value.data);
            originalObjectFreeze(result.value);
            stopEvents.add(result.value);
            stopPhase = 2;
          }
        }
        if (metadata && !result.done) {
          metadata.events.add(result.value);
          if (result.value.type === 'error') metadata.terminal = 'failed';
          if (
            result.value.type === 'session_status' &&
            'terminalReason' in result.value.data &&
            result.value.data.terminalReason === 'aborted_streaming'
          )
            metadata.terminal = 'cancelled';
          if (result.value.type === 'done' && metadata.terminal === undefined)
            metadata.terminal = 'turn_done';
        }
        return result;
      },
      async return(value) {
        const closure = close().then(
          () => ({ failed: false as const }),
          (cause: unknown) => ({ failed: true as const, cause })
        );
        let failed = false,
          first: unknown;
        let result: IteratorResult<StreamEvent> = { done: true, value };
        try {
          result = await run.return(value);
        } catch (cause) {
          failed = true;
          first = cause;
        }
        const cleanup = await closure;
        if (cleanup.failed && !failed) {
          failed = true;
          first = cleanup.cause;
        }
        if (failed) throw first;
        return result;
      },
      async throw(cause) {
        const closure = close().then(
          () => ({ failed: false as const }),
          (cause: unknown) => ({ failed: true as const, cause })
        );
        let failed = false,
          first: unknown;
        let result: IteratorResult<StreamEvent> = { done: true, value: undefined };
        try {
          result = await run.throw(cause);
        } catch (error) {
          failed = true;
          first = error;
        }
        const cleanup = await closure;
        if (cleanup.failed && !failed) {
          failed = true;
          first = cleanup.cause;
        }
        if (failed) throw first;
        return result;
      },
      async [Symbol.asyncDispose]() {
        await disposeOriginalStream();
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    streamCapture.returned = returned;
    const disposeOriginalStream = returned.return.bind(returned, undefined);
    testModeOriginalStreams.set(returned, {
      runtime: this,
      own,
      sessionId,
      options: captureTurnLevelOptions(opts),
      stopContinuation,
      stopEvents,
      resolve: async () => {
        const result = await resolveOriginalNativePrincipal(this.#nativePrincipals!, own.operation);
        if (
          !readTestModeNativeOperation(own.operation) ||
          testModeOriginalStreams.get(returned)?.own !== own
        )
          return { status: 'refused', reason: 'revoked' };
        return result;
      },
    });
    if (metadata) testModeStreams.set(returned, metadata);
    this.#activeNativeStreams.set(sessionId, returned);
    return returned;
  }
  ensureSession(sessionId: string, opts: SessionOpts): void {
    this.registry.register(sessionId, {
      permissionMode: opts.permissionMode,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });
  }

  hasSession(sessionId: string): boolean {
    return this.registry.has(sessionId);
  }

  /** @inheritdoc Counted per session: a turn is open from its first line to its `finally`. */
  isTurnOpen(sessionId: string): boolean {
    return (this.openTurns.get(sessionId) ?? 0) > 0;
  }

  /**
   * Full state reset (the `/api/test/reset` control path): for every tracked
   * session, disposes its in-memory projector AND deletes its durable
   * `session_events` rows, then drops the tracked metadata (which emits
   * `session_removed` to live list subscribers).
   *
   * Both persistence tiers must be cleared. The projector is the LIVE tier, but
   * a completed turn is also flushed to the durable SQLite store (DOR-189),
   * which `readLogBackedHistory` reads FIRST when a store is wired (the e2e
   * server). Disposing only the projector would leave those rows behind, so a
   * reused id resurrects pre-reset history straight from SQLite. The store is
   * absent in bare unit tests — then `getSessionEventStore()` is `undefined`
   * and only the projector is disposed, the pre-DOR-189 behavior.
   *
   * Held processes go back too (DOR-1326), and so do declared first-turn
   * renames. They are per-session runtime state like the projectors above, so a
   * session id reused after a reset must not inherit the previous test's warmth
   * — which would make a cold session report `warm` and offer a Steer nothing
   * could take — or its rename.
   */
  resetTrackedSessions(): void {
    heldProcesses.reset();
    // Declared first-turn renames go too: a session id reused after a reset must
    // not inherit a rename the previous test asked for.
    declaredCanonicalIds.clear();
    this.#originalNativeCanonicalAliases.clear();
    const store = getSessionEventStore();
    for (const sessionId of this.registry.ids()) {
      disposeProjector(sessionId);
      try {
        store?.deleteSession(sessionId);
      } catch (error) {
        // Warn-and-swallow (the flushTurn pattern): one session's failed durable
        // delete must not abort the loop and leave later projectors un-disposed.
        logger.warn('[TestModeRuntime] durable session delete failed during reset', {
          sessionId,
          error,
        });
      }
    }
    this.registry.reset();
  }

  async forkSession(): Promise<Session | null> {
    return null;
  }

  async reloadPlugins(): Promise<null> {
    return null;
  }

  setSessionSettings(port: SessionSettingsPort): void {
    this.settingsPort = port;
  }

  async updateSession(sessionId: string, opts: SessionSettings): Promise<SessionUpdateResult> {
    await this.settingsPort?.saveSessionSettings(sessionId, opts);
    return {
      updated: this.registry.applySettings(sessionId, {
        ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
      }),
    };
  }

  sendMessage(sessionId: string, content: string, opts?: MessageOpts): AsyncGenerator<StreamEvent> {
    return this.#sendScenario(sessionId, content, opts);
  }
  async *#sendScenario(
    sessionId: string,
    content: string,
    opts?: MessageOpts,
    native?: {
      own: TestModeInstalled;
      room?: { prepared: PreparedRoomResponder; committed: OriginalCommittedRoomResponder };
    }
  ): AsyncGenerator<StreamEvent> {
    let ctx: ReturnType<typeof interactionGate.open> | undefined;
    let heldTurn: ReturnType<typeof heldProcesses.beginTurn> = undefined;
    let failed = false,
      first: unknown;
    this.openTurns.set(sessionId, (this.openTurns.get(sessionId) ?? 0) + 1);
    try {
      // Read the original persisted settings without replacing native turn custody.
      const stored = await this.settingsPort?.getSessionSettings(sessionId);
      if (native) {
        requireCurrentOriginalNativeTurn(this.#nativePrincipals!, native.own.operation);
        if (!readTestModeNativeOperation(native.own.operation))
          throw new Error('TestMode original scenario entry retired during settings acquisition.');
      }
      this.registry.recordMessage(sessionId, content, {
        ...(stored?.permissionMode !== undefined ? { permissionMode: stored.permissionMode } : {}),
        ...(stored?.model !== undefined ? { model: stored.model } : {}),
        ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
      });
      if (!native) this.revealCanonicalSessionId(sessionId);
      const scenario = scenarioStore.getScenario(sessionId);
      const opened = interactionGate.open(sessionId);
      ctx = opened;
      if (native)
        native.own.entry.closeScenario = () => interactionGate.close(sessionId, opened.token);
      const scenarioContext = {
        ...opened,
        docEventsPrompt: opts?.additionalContext
          ?.filter((entry) => entry.kind === 'doc_events')
          .map((entry) => renderDocEvents(entry.data))
          .join('\n\n'),
      };
      heldTurn = heldProcesses.beginTurn(sessionId);
      if (native) {
        requireCurrentOriginalNativeTurn(this.#nativePrincipals!, native.own.operation);
        if (!readTestModeNativeOperation(native.own.operation))
          throw new Error('TestMode original scenario entry retired before effect.');
        if (native.room)
          consumeOriginalCommittedRoomResponder(
            native.room.committed,
            this,
            native.room.prepared,
            native.own.operation
          );
      }
      // Count the actual original local provider entry, after the private once-start consume.
      if (native) {
        native.own.entry.scenarioStarts++;
        this.#originalScenarioStarts++;
      }
      if (scenario === originalNativeCanonicalRekeyScenario) {
        if (!native || native.room || !this.#nativePrincipals)
          throw new Error('Canonical recovery requires an original native interactive turn');
        native.own.entry.canonicalScenarioStarted = true;
        yield { type: 'session_status', data: { sessionId, model: 'test-mode' } } as StreamEvent;
        yield {
          type: 'text_delta',
          data: { text: 'NATIVE_CANONICAL_REKEY_WAITING' },
        } as StreamEvent;
        await scenarioContext.awaitStep();
        requireCurrentOriginalNativeTurn(this.#nativePrincipals, native.own.operation);
        const canonicalId = randomUUID();
        await rekeyOriginalRuntimeSessionSettings(
          this,
          this.#nativePrincipals,
          sessionId,
          canonicalId
        );
        const time = Date.now(),
          activity = captureNativeSessionActivity(native.own.entry.acquisition, time);
        if (
          !readTestModeNativeOperation(native.own.operation) ||
          !activity ||
          !readNativeSessionAcquisition(native.own.entry.acquisition, activity, time, sessionId)
        )
          throw new Error('Original canonical source retired during settings move');
        native.own.entry.canonicalSessionId = canonicalId;
        this.registry.rekey(sessionId, canonicalId);
        yield {
          type: 'session_status',
          data: { sessionId: canonicalId, model: 'test-mode' },
        } as StreamEvent;
        yield { type: 'text_delta', data: { text: 'NATIVE_CANONICAL_REKEY_HELD' } } as StreamEvent;
        await scenarioContext.awaitStep();
        yield { type: 'done', data: { sessionId: canonicalId } } as StreamEvent;
      } else if (scenario === originalRoomPartialAckReplyScenario) {
        if (!native?.room || !this.#nativeRoomEmitter)
          throw new Error(
            'Original Room partial reply scenario requires the installed native emitter.'
          );
        yield { type: 'session_status', data: { sessionId, model: 'test-mode' } } as StreamEvent;
        await sendOriginalRoomResponderScriptStep(
          this.#nativeRoomEmitter,
          native.room.committed,
          this,
          native.room.prepared,
          native.own.operation,
          'ack-first'
        );
        // A real operator step keeps the source turn/FIRST alive while the first receipt is inspected.
        yield {
          type: 'text_delta',
          data: { text: 'First native document input acknowledged.' },
        } as StreamEvent;
        await scenarioContext.awaitStep();
        requireCurrentOriginalNativeTurn(this.#nativePrincipals!, native.own.operation);
        await sendOriginalRoomResponderScriptStep(
          this.#nativeRoomEmitter,
          native.room.committed,
          this,
          native.room.prepared,
          native.own.operation,
          'reply-second'
        );
        yield { type: 'done', data: { sessionId } } as StreamEvent;
      } else {
        yield* scenario(content, scenarioContext, opts);
      }
    } catch (cause) {
      if (cause instanceof ScenarioAborted) {
        yield {
          type: 'session_status',
          data: { sessionId: 'test-mode', terminalReason: 'aborted_streaming' },
        } as StreamEvent;
        yield { type: 'done', data: { sessionId: 'test-mode' } } as StreamEvent;
      } else {
        failed = true;
        first = cause;
      }
    } finally {
      try {
        if (ctx) interactionGate.close(sessionId, ctx.token);
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
      try {
        if (heldTurn !== undefined) heldProcesses.endTurn(sessionId, heldTurn);
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
      const open = (this.openTurns.get(sessionId) ?? 1) - 1;
      if (open > 0) this.openTurns.set(sessionId, open);
      else this.openTurns.delete(sessionId);
    }
    if (failed) throw first;
  }

  /**
   * Fulfill the runtime-fulfilled `compact` intent by yielding a synthetic
   * compaction — the deterministic e2e/conformance vehicle, mirroring
   * {@link FakeAgentRuntime}'s final form. Lets the palette-gating + dispatch
   * e2e (Phase 4) and the conformance suite assert a supported runtime's
   * dispatch reached the adapter and produced a boundary the durable projector
   * drives. `TEST_MODE_CAPABILITIES.commandIntents` gates the route before this
   * is ever called.
   *
   * Yields the Claude adapter's full three-event shape (progress `started` →
   * boundary → progress `done`), not a bare boundary — see the note in the body
   * for why the readings matter — and ends with the one `done` every runtime's
   * run ends with. It counts as an open turn while it runs, as every runtime's
   * compaction does ({@link isTurnOpen}).
   */
  async *executeCommandIntent(
    sessionId: string,
    _intent: RuntimeCommandIntentId,
    _opts?: CommandIntentOpts
  ): AsyncGenerator<StreamEvent> {
    this.openTurns.set(sessionId, (this.openTurns.get(sessionId) ?? 0) + 1);
    try {
      yield* this.syntheticCompaction();
      yield { type: 'done', data: { sessionId } };
    } finally {
      const open = (this.openTurns.get(sessionId) ?? 1) - 1;
      if (open > 0) this.openTurns.set(sessionId, open);
      else this.openTurns.delete(sessionId);
    }
  }

  /** The compaction {@link executeCommandIntent} reports, in the Claude adapter's shape. */
  private async *syntheticCompaction(): AsyncGenerator<StreamEvent> {
    // Full-fidelity, in the Claude adapter's own shape: the progress pair its
    // system-event mapper builds from `status:'compacting'` and
    // `compact_result:'success'`, around a boundary carrying the same four
    // camelCased fields it forwards from `compact_metadata`. A bare
    // `{trigger:'manual'}` satisfied the conformance suite but left every
    // reading the boundary row exists to report empty, so nothing downstream
    // was ever driven with real numbers.
    yield {
      type: 'operation_progress',
      data: {
        operation: 'compaction',
        state: 'started',
        determinate: false,
        message: 'Compacting context…',
      },
    };
    yield {
      type: 'compact_boundary',
      data: { trigger: 'manual', preTokens: 51_226, postTokens: 4_151, durationMs: 63_275 },
    };
    yield {
      type: 'operation_progress',
      data: { operation: 'compaction', state: 'done', determinate: false },
    };
  }

  setRelay(_relay: RelayCore): void {
    // No-op: retained to satisfy the AgentRuntime interface.
  }

  /**
   * Capture the managed-MCP server resolver so {@link getMcpStatus} can report an
   * agent's managed servers. Injected at boot into every runtime (index.ts); the
   * claude-code alias registered under `DORKOS_TEST_RUNTIME_CLAUDE_ALIAS` is the
   * one the managed-MCP OAuth e2e drives, since its seeded agent declares
   * `runtime: 'claude-code'`.
   *
   * @param resolver - The managed-server resolver from the composition root.
   */
  setManagedMcpServers(resolver: ManagedMcpServerResolver): void {
    this.managedMcp = resolver;
  }

  /**
   * @inheritdoc
   *
   * TestModeRuntime opens no real MCP connections, so it synthesizes live status
   * from the injection resolver: an enabled http/sse managed server reports
   * `connected` once DorkOS injects its `Authorization: Bearer` header (the
   * operator signed its OAuth flow in) and `needs-auth` until then; stdio is
   * always `connected`. `null` when no resolver is wired. This is the
   * deterministic stand-in the managed-MCP OAuth e2e (DOR-952) asserts against.
   */
  getMcpStatus(cwd: string): McpServerEntry[] | null {
    const servers = this.managedMcp?.injectableServersForCwd(cwd);
    if (!servers) return null;
    return Object.entries(servers).map(([name, connection]) => ({
      name,
      type: connection.transport,
      status: mcpStatusFor(connection),
      scope: 'managed',
    }));
  }

  /** Read the same boot-injected connection used for current managed-server membership. */
  getMcpServerConfig(cwd: string, serverName: string): McpAppServerConnection | null {
    return this.managedMcp?.injectableServersForCwd(cwd)[serverName] ?? null;
  }

  /**
   * Whether a session here carries the DorkOS room tools — always, since the
   * graduation (spec `tool-only-room-replies` §A2).
   *
   * A scripted turn reaches the real capability registry in-process, exactly as
   * claude-code does, so the claim is true rather than convenient: the scenarios
   * that mean to say something in a room call `post_to_room` through
   * {@link sayInRoom}, and the ones that mean to stay silent call nothing.
   *
   * It used to answer `false` unless the selected scenario opted in, which kept
   * the browser and eval suites on the auto-post path while the flip was an
   * experiment. There is no second path to keep them on, so the opt-in is gone
   * and each scenario says what it means outright.
   *
   * @returns `true`.
   */
  async carriesRoomTools(): Promise<boolean> {
    return true;
  }

  async listSessions(projectDir: string): Promise<Session[]> {
    return this.registry.list(projectDir);
  }

  async getSession(_projectDir: string, id: string): Promise<Session | null> {
    return this.registry.get(id);
  }

  /** Discover tracked identities without falling back to another scripted runtime. */
  async findSession(id: string): Promise<Session | null> {
    return this.registry.get(id);
  }

  /**
   * Completed messages reconstructed from the DorkOS-owned event stream, read
   * DURABLY from the `session_events` store (DOR-189) when wired so history
   * survives a restart; falls back to the live projector's EventLog when no
   * store is injected (bare unit tests). No JSONL, no native store.
   */
  async getMessageHistory(_projectDir: string, id: string): Promise<HistoryMessage[]> {
    return readLogBackedHistory(id);
  }

  async getSessionTasks(_projectDir: string, _id: string): Promise<TaskItem[]> {
    return [];
  }

  async getSessionETag(_projectDir: string, _id: string): Promise<string | null> {
    return null;
  }

  async getLastMessageIds(_sessionId: string): Promise<{ user: string; assistant: string } | null> {
    return null;
  }

  async readFromOffset(
    _projectDir: string,
    _id: string,
    _offset: number
  ): Promise<{ content: string; newOffset: number }> {
    return { content: '', newOffset: 0 };
  }

  acquireLock(id: string, clientId: string, res: SseResponse, token?: symbol): boolean {
    return testModeNativeConstructors.has(this)
      ? this.#nativeLocks.acquireLock(id, clientId, res, token)
      : true;
  }

  releaseLock(id: string, clientId: string, token?: symbol): void {
    if (testModeNativeConstructors.has(this)) this.#nativeLocks.releaseLock(id, clientId, token);
  }

  isLocked(id: string, clientId?: string): boolean {
    return testModeNativeConstructors.has(this) ? this.#nativeLocks.isLocked(id, clientId) : false;
  }

  getLockInfo(id: string): { clientId: string; acquiredAt: number } | null {
    return testModeNativeConstructors.has(this) ? this.#nativeLocks.getLockInfo(id) : null;
  }

  getCapabilities(): RuntimeCapabilities {
    return this.capabilities;
  }

  async getSupportedModels(): Promise<ModelOption[]> {
    return [];
  }

  async getSupportedSubagents(): Promise<import('@dorkos/shared/types').SubagentInfo[]> {
    return [];
  }

  /**
   * Set a session's title, as the Claude adapter does in its transcript: the
   * list, the sidebar and `GET /api/sessions/:id` all read it from now on, and
   * a later message never replaces it.
   */
  async renameSession(sessionId: string, title: string): Promise<void> {
    this.registry.rename(sessionId, title);
  }

  /**
   * Declare the canonical id this session's FIRST turn will rename it to.
   *
   * The scripted stand-in for the one thing about a real first turn that no
   * browser test can otherwise reach: a brand-new claude-code session streams
   * under the request UUID the client minted and is renamed to the SDK's own id
   * mid-turn, which moves the projector, the lock, the route the window is on —
   * and the session's canvas. Test mode has no SDK to mint an id, so a test
   * names one instead and this promises to answer it.
   *
   * **Declared now, revealed on the first `sendMessage`.** Until the turn
   * starts, {@link getInternalSessionId} keeps answering `undefined`, so the
   * turn begins under the id the client minted exactly as a real one does and
   * the rename happens mid-turn rather than before it. Declaring it is otherwise
   * inert: nothing else in this runtime reads the map.
   *
   * @param sessionId - The id the client minted and is streaming under.
   * @param canonicalId - The id the first turn will rename it to.
   */
  declareCanonicalSessionId(sessionId: string, canonicalId: string): void {
    if (sessionId === canonicalId) return;
    declaredCanonicalIds.set(sessionId, { canonicalId, revealed: false });
  }

  /** Start answering a declared canonical id, and move the tracked metadata to it. */
  private revealCanonicalSessionId(sessionId: string): void {
    const declared = declaredCanonicalIds.get(sessionId);
    if (!declared || declared.revealed) return;
    declared.revealed = true;
    this.registry.rekey(sessionId, declared.canonicalId);
  }

  getInternalSessionId(id: string): string | undefined {
    const declared = declaredCanonicalIds.get(id);
    return declared?.revealed === true ? declared.canonicalId : undefined;
  }

  /** Required by AgentRuntimeLike (relay package) for SDK session ID lookup. */
  getSdkSessionId(_id: string): string | undefined {
    return undefined;
  }

  async getCommands(_forceRefresh?: boolean, _cwd?: string): Promise<CommandRegistry> {
    return { commands: [], lastScanned: '' };
  }

  async checkDependencies(): Promise<DependencyCheck[]> {
    return [
      {
        name: 'Test Mode Runtime',
        description: 'No external dependencies required.',
        status: 'satisfied',
      },
    ];
  }

  checkSessionHealth(): void {}

  /**
   * @inheritdoc
   *
   * Answers the pending approval a scenario is parked on, then resolves the
   * projector's interaction so the card is dropped from every window through the
   * same seq'd stream a production runtime uses.
   *
   * The projector resolve is what earns the transcript receipt: without it a
   * decision would unblock the scenario while every window went on showing an
   * answerable card, which is exactly the OpenCode ghost DOR-1148 closed.
   * `false` when nothing was waiting — the signal the `/approve` and `/deny`
   * routes turn into a 409 rather than a silent 200.
   */
  approveTool(
    id: string,
    toolCallId: string,
    approved: boolean,
    opts?: ToolDecisionOptions
  ): boolean {
    const resolved = interactionGate.resolveApproval(id, toolCallId, {
      approved,
      ...(opts?.alwaysAllow !== undefined ? { alwaysAllow: opts.alwaysAllow } : {}),
      ...(opts?.denyReason !== undefined ? { denyReason: opts.denyReason } : {}),
    });
    if (!resolved) return false;
    peekProjector(id)?.resolveInteraction(toolCallId, approved ? 'approved' : 'denied', {
      // Only claimable when the words were actually carried to the scenario,
      // which is precisely when a reason was given.
      ...(opts?.denyReason !== undefined ? { reasonGiven: true } : {}),
      ...(opts?.answeredBy ? { answeredBy: opts.answeredBy } : {}),
    });
    return true;
  }

  /**
   * @inheritdoc
   *
   * Delivers an AskUserQuestion answer to the parked scenario and resolves the
   * projector's interaction. See {@link approveTool} for why both halves matter.
   */
  submitAnswers(
    id: string,
    toolCallId: string,
    answers: Record<string, string>,
    opts?: InteractionAnswerOptions
  ): boolean {
    if (!interactionGate.resolveAnswers(id, toolCallId, answers)) return false;
    peekProjector(id)?.resolveInteraction(toolCallId, 'answered', {
      ...(opts?.answeredBy ? { answeredBy: opts.answeredBy } : {}),
    });
    return true;
  }

  /**
   * @inheritdoc
   *
   * Delivers an MCP elicitation response to the parked scenario and resolves the
   * projector's interaction. An `accept` is recorded as `answered`; a decline or
   * a cancel is a refusal, and says so.
   */
  submitElicitation(
    id: string,
    interactionId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>,
    opts?: InteractionAnswerOptions
  ): boolean {
    const resolved = interactionGate.resolveElicitation(id, interactionId, {
      action,
      ...(content !== undefined ? { content } : {}),
    });
    if (!resolved) return false;
    peekProjector(id)?.resolveInteraction(
      interactionId,
      action === 'accept' ? 'answered' : 'denied',
      { ...(opts?.answeredBy ? { answeredBy: opts.answeredBy } : {}) }
    );
    return true;
  }

  /** Test-mode scripts no addressable background tasks — nothing to stop. */
  async stopTask(_sessionId: string, _taskId: string): Promise<InterruptReceipt> {
    return { outcome: 'not-running', reason: 'no-open-turn', runtime: this.type };
  }

  /**
   * @inheritdoc
   *
   * The deterministic double for the two non-turn-opening dispositions
   * (spec `persistent-session-runtime` §2.3, task 4.4). Test-mode declares both
   * capabilities, and since DOR-1326 both ride the session's HELD process —
   * which is what makes the refusals below real rather than decorative.
   *
   * - `'steer'` needs two things, exactly as claude-code does: a held process to
   *   push into, and a turn already running to join. Missing either is
   *   `no-open-turn`, which the dispatcher tells apart for the person — a turn
   *   IS open and could not be joined reads `not-steerable`, no turn open reads
   *   `session-idle`. A session on the resume path therefore refuses a steer
   *   that would once have been accepted here, which is the whole point: that is
   *   the pairing DOR-1268 shipped and nothing above the unit layer could stage.
   *   The steered content SURFACES via the dispatcher's `turn_input` carrier, not
   *   here — a runtime never mints that event (it rides the open turn's stream).
   * - `'stage'` needs no open turn, and it asks exactly the question
   *   {@link canStageSession} answers, so the two can never disagree: a session
   *   that WOULD run its next turn on a held process is staged onto — warming it
   *   first if it holds none yet, which is what claude-code's own native stage
   *   does (`PersistentDispatch.stage` launches the pump before appending). The
   *   words go onto that process and the next scripted answer repeats them, so a
   *   browser can see the stage LANDED rather than that a receipt was emitted.
   *   A session that would NOT is refused as `unsupported`, which is the only
   *   refusal the server is allowed to fold — anything else would put a person's
   *   staged words on the queue, where they provoke a reply.
   *
   * Never throws for an ordinary refusal, per the `deliverIntoTurn` contract.
   *
   * @param sessionId - Target session.
   * @param content - The person's text, kept only by a stage onto a held process.
   * @param opts - The delivery mode and its correlation id.
   */
  async deliverIntoTurn(
    sessionId: string,
    content: string,
    opts: DeliverIntoTurnOpts
  ): Promise<RuntimeDeliveryResult> {
    if (opts.mode === 'stage') {
      // One question, asked the way `canStageSession` asks it. Gating on `holds`
      // instead diverged from that answer in two states this really reaches —
      // opted in before the first turn, and opted in after a reap — and the
      // server, told the session was stageable, would have queued the words
      // rather than folding them (see `ensureHeld`).
      if (!heldProcesses.ensureHeld(sessionId)) {
        return { delivered: false, reason: 'unsupported' };
      }
      heldProcesses.stage(sessionId, content);
      return { delivered: true };
    }
    // A steer needs the process AND a turn already running on it. `holds` rather
    // than `willHold` on purpose: a turn cannot be open on a session that holds
    // nothing (every turn on the held path begins by taking the process), so this
    // only ever refuses a session with no live turn to join.
    if (!heldProcesses.holds(sessionId) || !interactionGate.isOpen(sessionId)) {
      return { delivered: false, reason: 'no-open-turn' };
    }
    return { delivered: true };
  }

  /**
   * @inheritdoc
   *
   * Test-mode's steer rides the session's held process, so the honest answer is
   * the same question the dispatch path asks: will this session's next turn run
   * on one? A session that opted in is steerable before its first turn, and one
   * already holding a process stays steerable after the opt-in is turned off —
   * both mirroring claude-code's `PersistentDispatch.shouldDispatch`.
   *
   * Deliberately NOT {@link getSessionWarmth}: warmth is about this instant
   * (`warm` versus `running`), and an affordance offered only while a turn was
   * already open would flicker with the turn instead of describing the session.
   */
  canSteerSession(sessionId: string): boolean {
    return heldProcesses.willHold(sessionId);
  }

  /**
   * @inheritdoc
   *
   * The same question as {@link canSteerSession}, and here the same answer,
   * because both rides are the same ride: a stage appends to the held process,
   * so a session that will not run its next turn on one has nothing to append
   * to. `false` is not a refusal — the server folds the words into the next
   * dispatch and the person still sees "Added context for the next reply".
   *
   * {@link deliverIntoTurn}'s stage branch asks this SAME question rather than
   * "is a process held right now", so the two cannot disagree — the divergence
   * that would otherwise queue a staged message instead of folding it.
   */
  canStageSession(sessionId: string): boolean {
    return heldProcesses.willHold(sessionId);
  }

  /**
   * @inheritdoc
   *
   * `cold` for every session that holds no scripted process, including one this
   * runtime has never heard of.
   */
  getSessionWarmth(sessionId: string): SessionWarmth {
    return heldProcesses.warmth(sessionId);
  }

  /**
   * @inheritdoc
   *
   * Gives the scripted process back. Invisible to the person: the next message
   * boots a fresh one and answers the same way, which is what conformance C5
   * checks — and what the browser leg drives through
   * `POST /api/test/reap` to reach a warmth that went back to `cold` without
   * waiting out an idle window nothing can hurry.
   */
  async reapSession(sessionId: string): Promise<void> {
    heldProcesses.reap(sessionId);
  }

  /**
   * @inheritdoc
   *
   * Always `false`, and that is the honest answer rather than a stub: a
   * test-mode turn is bounded by the generator {@link sendMessage} hands back on
   * BOTH paths, so there is no way for one to outlive its stream and be left
   * open. The held process is bookkeeping, not a subprocess with an input stream
   * of its own — the thing that can strand a turn on the real pump does not
   * exist here.
   *
   * Implemented rather than omitted because declaring
   * `supportsPersistentSession` is what creates the obligation (conformance C8),
   * and because the server reads the ABSENCE of this method as "this runtime
   * cannot strand a turn" — which is true of test-mode and would then be
   * indistinguishable from a persistent runtime that forgot to wire it.
   */
  async settleOpenTurn(_sessionId: string): Promise<boolean> {
    return false;
  }

  /**
   * @inheritdoc
   *
   * Aborts the running scenario: every wait it is parked on rejects with
   * {@link ScenarioAborted}, which {@link sendMessage} turns into a terminal
   * `aborted_streaming` + `done` so the turn closes and the composer comes back.
   *
   * **Resolves the projector's pending interactions too**, exactly as
   * {@link approveTool}, {@link submitAnswers} and {@link submitElicitation} do.
   * Stopping a turn that is parked on an approval makes that card unanswerable —
   * the scenario waiting on it is gone — so leaving it in `pendingInteractions`
   * would strand an immortal card in every window's snapshot, answerable-looking
   * and answering only 409s. Resolved with NO outcome: nobody approved or denied
   * it, and claiming either would be a lie in the transcript.
   *
   * Answers `not-running` when no turn is open, which is the honest report — a
   * stop that arrives after a turn finished on its own is a race, not an error.
   *
   * **A stopped scripted turn is `closed`, not `acked`, by default** (spec
   * `runtime-interrupt-receipts` D10). `interactionGate.abort` is DorkOS ending
   * the scenario from the outside; nothing in the scripted turn acknowledges
   * anything, so reporting `acked` would make the one runtime the browser tests
   * trust the one runtime that lies.
   *
   * A test that needs a different ending **declares** it
   * (`POST /api/test/interrupt-outcome`), which is how the browser leg reaches
   * `acked`, `unconfirmed` and `failed` deterministically. A declared
   * `unconfirmed` or `failed` leaves the turn running, exactly as it would on a
   * runtime that genuinely could not confirm — the whole point is to stage the
   * shape, not to narrate over an abort that happened anyway.
   */
  async interruptQuery(sessionId: string): Promise<InterruptReceipt> {
    const notRunning: InterruptReceipt = {
      outcome: 'not-running',
      reason: 'no-open-turn',
      runtime: this.type,
    };
    const declared = declaredInterruptOutcome();
    // A declared `unconfirmed` or `failed` means the turn did NOT end, so the
    // abort is deliberately not performed: the test is staging the ending a
    // runtime that could not confirm would produce, and a turn that quietly
    // stopped underneath that copy would prove nothing about it.
    if (declared === 'unconfirmed' || declared === 'failed') {
      if (!interactionGate.isOpen(sessionId)) return notRunning;
      return {
        outcome: declared,
        reason: declared === 'failed' ? 'delivery-failed' : 'runtime-declined',
        runtime: this.type,
      };
    }
    // Read before the abort, which clears them.
    const pending = interactionGate.pendingInteractionIds(sessionId);
    const native = this.#nativeEntries.get(sessionId);
    if (native) {
      native.retired = true;
      native.controller.abort();
    }
    if (!interactionGate.abort(sessionId)) return notRunning;
    if (native) native.interrupted = true;
    const projector = peekProjector(sessionId);
    for (const interactionId of pending) projector?.resolveInteraction(interactionId);
    return { outcome: declared ?? 'closed', runtime: this.type };
  }

  /**
   * @inheritdoc
   *
   * Built ENTIRELY from the DorkOS-owned projection: completed `messages` are
   * reconstructed from the EventLog (the injected loader — "own the boundary,
   * not the bytes", ADR-0263), and the live turn/status/pending/cursor come
   * from the same projector. No JSONL, no native transcript.
   */
  async getSessionSnapshot(ctx: SessionOpts, sessionId: string): Promise<SessionSnapshot> {
    const projector = getOrCreateProjector(sessionId, ctx.cwd, { persist: 'history' });
    return projector.buildSnapshot(() =>
      Promise.resolve(reconstructHistoryFromEvents(projector.replayFrom(0)))
    );
  }

  /**
   * @inheritdoc
   *
   * Delegates to the projector's resumable seq'd stream — the SAME projector
   * the trigger path feeds (`triggerTurn` → `feedProjector`), so `/events`
   * serves a test-mode turn through exactly the code path the Claude adapter
   * uses. Throws {@link StaleResumeCursorError} eagerly via the projector's
   * cursor validation.
   */
  subscribeSession(
    ctx: SessionOpts,
    sessionId: string,
    sinceCursor?: number,
    signal?: AbortSignal
  ): AsyncIterable<SessionEvent> {
    return getOrCreateProjector(sessionId, ctx.cwd, { persist: 'history' }).subscribe(
      sinceCursor,
      signal
    );
  }

  /**
   * @inheritdoc
   *
   * The registry answers directly here: test-mode keys its projectors by the
   * DorkOS session id and holds no second id to resolve through, so this reads
   * the same entry {@link subscribeSession} binds to. Peek-only — asking which
   * counter serves a session must not mint one, and the fresh projector a
   * subsequent subscribe would mint refuses every cursor above 0 anyway.
   */
  streamGeneration(_ctx: SessionOpts, sessionId: string): string {
    return streamGenerationOf(peekProjector(sessionId));
  }

  /**
   * @inheritdoc
   *
   * Emits the tracked-session inventory then live upserts from the in-memory
   * registry — NO filesystem watch, proving the list contract is satisfiable
   * without any native store. `session_status` liveness is not emitted here:
   * it fans out runtime-neutrally from the projector via the session-list
   * broadcaster, same as every runtime.
   */
  subscribeSessionList(_ctx: SessionOpts): AsyncIterable<SessionListEvent> {
    return this.registry.subscribe();
  }
}

/**
 * The synthesized MCP status for one injected managed server: http/sse reads
 * `connected` once a bearer is injected (OAuth signed in) and `needs-auth`
 * otherwise; stdio needs no token and is always `connected`. See
 * {@link TestModeRuntime.getMcpStatus}.
 *
 * @param connection - The injected connection from the managed-server resolver.
 */
function mcpStatusFor(connection: McpAppServerConnection): McpServerEntry['status'] {
  if (connection.transport === 'stdio') return 'connected';
  return hasBearerHeader(connection.headers) ? 'connected' : 'needs-auth';
}

/**
 * Whether a header map carries a non-empty `Authorization: Bearer` (case-insensitive key).
 *
 * "Non-empty" means the TOKEN, not the header: a bare `'Bearer '` passes
 * `startsWith` and would otherwise report a server as connected on a header
 * carrying no credential at all. Not reachable through the injection path today
 * — the OAuth engine injects a token or no header — but the docblock said
 * non-empty and the check did not, and the next caller reads the docblock.
 */
function hasBearerHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  const prefix = 'Bearer ';
  return Object.entries(headers).some(
    ([key, value]) =>
      key.toLowerCase() === 'authorization' &&
      value.startsWith(prefix) &&
      value.length > prefix.length
  );
}

/** Fixed retirement of the actual original raw source, never a replaced public iterator method. */
export function retireTestModeOriginalRoomResponderStream(
  stream: object
): Promise<void> | undefined {
  return testModeStreams.get(stream)?.retire();
}
