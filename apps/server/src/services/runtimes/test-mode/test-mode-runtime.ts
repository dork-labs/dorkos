import type { OriginalTestModeNativeAcquisitionView } from './native/test-mode-native-acquisition-view.js';
import type { TestModeNativeMethodView } from './native/test-mode-native-methods.js';
import type { TestModeScenarioSessionView } from './runtime/test-mode-scenario-session-types.js';
import './runtime/test-mode-interactions-family.js';
import * as testModeSessionsMethods from './runtime/test-mode-sessions-family.js';
import * as testModeScenarioMethods from './runtime/test-mode-scenario-family.js';
import * as testModeNativeMethods from './native/test-mode-native-methods.js';
import '../../core/turn-power/turn-levels.js';
import 'node:crypto';
import { RoomContextDataSchema, type RoomContextData } from '@dorkos/shared/additional-context';
import { readInstallationOriginalRoomEmitter } from '../../canvas/doc-channel/writes/installation-file-writes.js';
import {
  requireOriginalDownstreamRoomEmissionClosed,
  type OriginalDownstreamRoomEmitter,
} from '../../canvas/doc-channel/downstream/native-room-emitter.js';
import { env } from '../../../env.js';
import type { ConnectorRuntimeTools } from '../connector-tools.js';
import type { ConnectorRuntimePrincipalPort } from '../../connectors/runtime-principal-port.js';
import {
  requireOriginalNativePrincipalPort,
  requireSameOriginalNativePrincipalPorts,
} from '../../connectors/principal/runtime-principal-service.js';
import {
  SessionLockManager,
  captureNativeSessionAcquisition,
  type NativeSessionAcquisition,
} from '../../session/session-lock.js';
import { captureOriginalRoomDispatchLifecycle } from '../../session/trigger-turn.js';
import '../../canvas/doc-channel/operations/room-current-operation.js';
import '../../canvas/doc-channel/operations/room-responder-operation.js';
import type {
  OriginalFrozenRoomSource,
  PreparedRoomResponder,
  OriginalCommittedRoomResponder,
} from '../../canvas/doc-channel/current/current-operation-types.js';

export type { OriginalTestModeCanonicalRestart } from './native/test-mode-native-types.js';
import {
  projectOriginalTestModeNativeView,
  projectOriginalTestModeSessionView,
  type OriginalTestModeNativeViewPorts,
  type OriginalTestModeSessionViewPorts,
} from './runtime/test-mode-private-view-projection.js';
import {
  createOriginalTestModeNativePublicOperations,
  type OriginalTestModeNativePublicOperations,
} from './native/test-mode-native-public-operations.js';
import { OriginalTestModeSessionInteractionFacade } from './runtime/test-mode-public-session-interactions.js';

/** Select original native maps only with the actual module-private custody key. */
export function readOriginalTestModeNativeCustodyMaps(
  owner: object
): ReturnType<typeof createIsolatedTestModeNativeCustody> {
  if (owner !== originalTestModeCustodyKey)
    throw new Error('Original TestMode native custody owner required.');
  return originalTestModeNativeMaps;
}
const originalTestModeNativeMaps = createIsolatedTestModeNativeCustody();
const originalTestModeCustodyKey = originalTestModeNativeMaps.originalObjectFreeze({});
const {
  testModeNativeConstructors,
  testModeStreams,
  nativeSignalAborted,
  originalMapGet,
  originalMapSet,
  originalMapEntries,
  originalCanonicalRestarts,
} = originalTestModeNativeMaps;
const originalPublicNativeOperations: Readonly<OriginalTestModeNativePublicOperations> =
  createOriginalTestModeNativePublicOperations(originalTestModeCustodyKey);
/** Original public native function objects close only the inaccessible actual custody key. */
const originalTestModeExplicitPublicBindings: Readonly<OriginalTestModeNativePublicOperations> =
  originalPublicNativeOperations;
/** Original public function reference with its exact named declaration contract. */
export const isTestModeOriginalRoomLaunchAlias: OriginalTestModeNativePublicOperations['isTestModeOriginalRoomLaunchAlias'] =
  originalTestModeExplicitPublicBindings.isTestModeOriginalRoomLaunchAlias;
/** Original public function reference with its exact named declaration contract. */
export const captureTestModeOriginalRoomEmitter: OriginalTestModeNativePublicOperations['captureTestModeOriginalRoomEmitter'] =
  originalTestModeExplicitPublicBindings.captureTestModeOriginalRoomEmitter;
/** Original public function reference with its exact named declaration contract. */
export const readTestModeOriginalPreparedRoomContext: OriginalTestModeNativePublicOperations['readTestModeOriginalPreparedRoomContext'] =
  originalTestModeExplicitPublicBindings.readTestModeOriginalPreparedRoomContext;
/** Original public function reference with its exact named declaration contract. */
export const readTestModeOriginalPlacementOptions: OriginalTestModeNativePublicOperations['readTestModeOriginalPlacementOptions'] =
  originalTestModeExplicitPublicBindings.readTestModeOriginalPlacementOptions;
/** Original public function reference with its exact named declaration contract. */
export const readTestModeOriginalActiveStream: OriginalTestModeNativePublicOperations['readTestModeOriginalActiveStream'] =
  originalTestModeExplicitPublicBindings.readTestModeOriginalActiveStream;
/** Original public function reference with its exact named declaration contract. */
export const readTestModeOriginalNativeStream: OriginalTestModeNativePublicOperations['readTestModeOriginalNativeStream'] =
  originalTestModeExplicitPublicBindings.readTestModeOriginalNativeStream;
/** Original public function reference with its exact named declaration contract. */
export const readTestModeOriginalNativeTurnOptions: OriginalTestModeNativePublicOperations['readTestModeOriginalNativeTurnOptions'] =
  originalTestModeExplicitPublicBindings.readTestModeOriginalNativeTurnOptions;
/** Original public function reference with its exact named declaration contract. */
export const readTestModeOriginalStopTerminalData: OriginalTestModeNativePublicOperations['readTestModeOriginalStopTerminalData'] =
  originalTestModeExplicitPublicBindings.readTestModeOriginalStopTerminalData;
/** Original public function reference with its exact named declaration contract. */
export const resolveTestModeOriginalNativeStreamPrincipal: OriginalTestModeNativePublicOperations['resolveTestModeOriginalNativeStreamPrincipal'] =
  originalTestModeExplicitPublicBindings.resolveTestModeOriginalNativeStreamPrincipal;
/** Original public function reference with its exact named declaration contract. */
export const readTestModeOriginalScenarioEvidence: OriginalTestModeNativePublicOperations['readTestModeOriginalScenarioEvidence'] =
  originalTestModeExplicitPublicBindings.readTestModeOriginalScenarioEvidence;
/** Original public function reference with its exact named declaration contract. */
export const requireTestModeOriginalRoomEmissionClosed: OriginalTestModeNativePublicOperations['requireTestModeOriginalRoomEmissionClosed'] =
  originalTestModeExplicitPublicBindings.requireTestModeOriginalRoomEmissionClosed;
/** Original public function reference with its exact named declaration contract. */
export const readTestModeOriginalScenarioCounts: OriginalTestModeNativePublicOperations['readTestModeOriginalScenarioCounts'] =
  originalTestModeExplicitPublicBindings.readTestModeOriginalScenarioCounts;
/** Original public function reference with its exact named declaration contract. */
export const isOriginalNativeTestModeRuntime: OriginalTestModeNativePublicOperations['isOriginalNativeTestModeRuntime'] =
  originalTestModeExplicitPublicBindings.isOriginalNativeTestModeRuntime;
/** Original public function reference with its exact named declaration contract. */
export const readTestModeNativeOperation: OriginalTestModeNativePublicOperations['readTestModeNativeOperation'] =
  originalTestModeExplicitPublicBindings.readTestModeNativeOperation;
/** Original public function reference with its exact named declaration contract. */
export const readTestModeOriginalCanonicalSessionId: OriginalTestModeNativePublicOperations['readTestModeOriginalCanonicalSessionId'] =
  originalTestModeExplicitPublicBindings.readTestModeOriginalCanonicalSessionId;
/** Original public function reference with its exact named declaration contract. */
export const captureTestModeOriginalCanonicalRestart: OriginalTestModeNativePublicOperations['captureTestModeOriginalCanonicalRestart'] =
  originalTestModeExplicitPublicBindings.captureTestModeOriginalCanonicalRestart;
/** Original public function reference with its exact named declaration contract. */
export const readTestModeOriginalCanonicalRestart: OriginalTestModeNativePublicOperations['readTestModeOriginalCanonicalRestart'] =
  originalTestModeExplicitPublicBindings.readTestModeOriginalCanonicalRestart;
/** Original public function reference with its exact named declaration contract. */
export const moveTestModeOriginalLockedAcquisition: OriginalTestModeNativePublicOperations['moveTestModeOriginalLockedAcquisition'] =
  originalTestModeExplicitPublicBindings.moveTestModeOriginalLockedAcquisition;
/** Original public function reference with its exact named declaration contract. */
export const sendTestModeOriginalLockedMessage: OriginalTestModeNativePublicOperations['sendTestModeOriginalLockedMessage'] =
  originalTestModeExplicitPublicBindings.sendTestModeOriginalLockedMessage;
/** Original public function reference with its exact named declaration contract. */
export const prepareTestModeOriginalLockedRoomResponder: OriginalTestModeNativePublicOperations['prepareTestModeOriginalLockedRoomResponder'] =
  originalTestModeExplicitPublicBindings.prepareTestModeOriginalLockedRoomResponder;
/** Original public function reference with its exact named declaration contract. */
export const readTestModePreparedRoomResponder: OriginalTestModeNativePublicOperations['readTestModePreparedRoomResponder'] =
  originalTestModeExplicitPublicBindings.readTestModePreparedRoomResponder;
/** Original public function reference with its exact named declaration contract. */
export const retireTestModePreparedRoomResponder: OriginalTestModeNativePublicOperations['retireTestModePreparedRoomResponder'] =
  originalTestModeExplicitPublicBindings.retireTestModePreparedRoomResponder;
/** Original public function reference with its exact named declaration contract. */
export const startTestModeCommittedRoomResponder: OriginalTestModeNativePublicOperations['startTestModeCommittedRoomResponder'] =
  originalTestModeExplicitPublicBindings.startTestModeCommittedRoomResponder;
/** Original public function reference with its exact named declaration contract. */
export const readTestModeOriginalRoomResponderStream: OriginalTestModeNativePublicOperations['readTestModeOriginalRoomResponderStream'] =
  originalTestModeExplicitPublicBindings.readTestModeOriginalRoomResponderStream;

const originalTestModeCustody: TestModeNativeGuardedCustody =
  originalTestModeNativeMaps.originalObjectFreeze({
    ...originalTestModeNativeMaps,
    ...originalPublicNativeOperations,
  });
/** Exact original native maps and guarded public functions; runtime view stays private. */
export type TestModeNativeGuardedCustody = Readonly<
  ReturnType<typeof createIsolatedTestModeNativeCustody> & OriginalTestModeNativePublicOperations
>;

import '../../canvas/doc-channel/prompt.js';
import type {
  AgentRuntime,
  RuntimeCapabilities,
  MessageOpts,
  CommandIntentOpts,
  SseResponse,
  ManagedMcpServerResolver,
  SessionSettingsPort,
  LiveSessionRef,
} from '@dorkos/shared/agent-runtime';

import type { StreamEvent } from '@dorkos/shared/types';

import { picksSession } from '@dorkos/shared/agent-runtime';
import type { RuntimeCommandIntentId } from '@dorkos/shared/command-intents';

import '../../session/session-state-projector.js';
import '../../../lib/logger.js';
import '../../session/event-log-history.js';
import '../../session/log-backed-history.js';
import { heldProcesses } from './held-process.js';
import { interactionGate } from './interaction-gate.js';
import './scenario-store.js';
import { TestModeSessionRegistry } from './session-registry.js';
import { TEST_MODE_CAPABILITIES } from './runtime-constants.js';
import { createIsolatedTestModeInteractions } from './runtime/test-mode-interactions-family.js';
import { createIsolatedTestModeSessions } from './runtime/test-mode-sessions-family.js';
import { createIsolatedTestModeScenario } from './runtime/test-mode-scenario-family.js';
import { createIsolatedTestModeNativeMethods } from './native/test-mode-native-methods.js';
import { createIsolatedTestModeNativeCustody } from './native/test-mode-native-custody.js';
import type { TestModeNativeEntry, TestModeInstalled } from './native/test-mode-native-types.js';

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

import {
  readOriginalTestModeNativeLaunchAlias,
  captureOriginalTestModeNativeRestart,
  moveOriginalTestModeNativeAcquisition,
} from './native/test-mode-native-acquisition-operations.js';
const originalNativeAcquisitionViews = new WeakMap<object, OriginalTestModeNativeAcquisitionView>();
const originalNativeAcquisitionGet = WeakMap.prototype.get;
const originalNativeAcquisitionSet = WeakMap.prototype.set;
const originalNativeAcquisitionApply = Reflect.apply;
/** Read only the original native constructor acquisition view by its inaccessible key. */
export function readOriginalTestModeNativeAcquisitionView(
  key: object
): OriginalTestModeNativeAcquisitionView {
  const view = originalNativeAcquisitionApply(
    originalNativeAcquisitionGet,
    originalNativeAcquisitionViews,
    [key]
  ) as OriginalTestModeNativeAcquisitionView | undefined;
  if (!view) throw new Error('Original TestMode native acquisition owner required.');
  return view;
}
const originalTestModeCallbackApply = Reflect.apply;
const originalTestModeMethods = createIsolatedTestModeNativeMethods();

const originalTestModeScenario = createIsolatedTestModeScenario();

const originalTestModeSessions = createIsolatedTestModeSessions();

const originalTestModeInteractions = createIsolatedTestModeInteractions();

/** Select only the actual root-private TestMode NativeMethods family. */
export function readOriginalTestModeNativeMethodView(owner: object): TestModeNativeMethodView {
  return originalTestModeMethods.read(owner);
}
/** Select only the actual root-private TestMode Scenario family. */
export function readOriginalTestModeScenarioView(owner: object): TestModeScenarioSessionView {
  return originalTestModeScenario.read(owner);
}
/** Select only the actual root-private TestMode Sessions family. */
export function readOriginalTestModeSessionsView(owner: object): TestModeScenarioSessionView {
  return originalTestModeSessions.read(owner);
}
/** Select only the actual root-private TestMode Interactions family. */
export function readOriginalTestModeInteractionsView(owner: object): TestModeScenarioSessionView {
  return originalTestModeInteractions.read(owner);
}

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
export class TestModeRuntime
  extends OriginalTestModeSessionInteractionFacade
  implements AgentRuntime
{
  readonly #nativeAcquisitionKey = originalTestModeNativeMaps.originalObjectFreeze({});
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
  readonly #nativeMethodKey = originalTestModeNativeMaps.originalObjectFreeze({});
  readonly #interactionsKey: object;
  readonly #sessionsKey: object;
  readonly #scenarioKey = originalTestModeNativeMaps.originalObjectFreeze({});
  constructor(type = 'test-mode', nativePrincipals?: ConnectorRuntimePrincipalPort) {
    const sessionsOwner = originalTestModeNativeMaps.originalObjectFreeze({});
    const interactionsOwner = originalTestModeNativeMaps.originalObjectFreeze({});
    super(sessionsOwner, interactionsOwner);
    this.#sessionsKey = sessionsOwner;
    this.#interactionsKey = interactionsOwner;
    this.type = type;
    // Sessions must carry their owning instance's type, not a hardcoded
    // 'test-mode', so session-list marks distinguish the two instances.
    this.registry = new TestModeSessionRegistry(type);
    /** Build only fixed original native acquisition descriptors at the owning constructor frontier. */
    function createOriginalNativeAcquisitionView(
      owner: TestModeRuntime
    ): OriginalTestModeNativeAcquisitionView {
      return originalTestModeNativeMaps.originalObjectFreeze<OriginalTestModeNativeAcquisitionView>(
        {
          runtime: owner,
          get entries() {
            return owner.#nativeEntries;
          },
          get locks() {
            return owner.#nativeLocks;
          },
          get principals() {
            return owner.#nativePrincipals;
          },
          get aliases() {
            return owner.#originalNativeCanonicalAliases;
          },
          originalMapGet,
          originalMapSet,
          originalMapEntries,
          nativeSignalAborted,
          originalCanonicalRestarts,
        }
      );
    }
    originalNativeAcquisitionApply(originalNativeAcquisitionSet, originalNativeAcquisitionViews, [
      this.#nativeAcquisitionKey,
      createOriginalNativeAcquisitionView(this),
    ]);
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
        isLaunchAlias: (request, retiredId) =>
          readOriginalTestModeNativeLaunchAlias(this.#nativeAcquisitionKey, request, retiredId),
        readPreparedRoomContext: (sessionId) => {
          const context = this.#preparedRoomContexts.get(sessionId);
          return context ? RoomContextDataSchema.parse(context) : undefined;
        },
        readActiveStream: (sessionId) => {
          const stream = this.#activeNativeStreams.get(sessionId);
          return stream && readTestModeOriginalNativeStream(this, stream) ? stream : undefined;
        },
        captureRestart: (sessionId, db) =>
          captureOriginalTestModeNativeRestart(this.#nativeAcquisitionKey, sessionId, db),
        move: (oldKey, canonicalKey, holder) =>
          moveOriginalTestModeNativeAcquisition(
            this.#nativeAcquisitionKey,
            oldKey,
            canonicalKey,
            holder
          ),
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
    const createOriginalNativeView = (runtime: TestModeRuntime) =>
      projectOriginalTestModeNativeView(
        this,
        originalTestModeCustody,
        originalTestModeNativeMaps.originalObjectFreeze<OriginalTestModeNativeViewPorts>({
          nativeEntries: () => runtime.#nativeEntries,
          nativePrincipals: () => runtime.#nativePrincipals,
          nativeLocks: () => runtime.#nativeLocks,
          preparedRoomContexts: () => runtime.#preparedRoomContexts,
          activeNativeStreams: () => runtime.#activeNativeStreams,
          installNative: (sessionId, path, acquisition, holder, roomOrigin) =>
            runtime.#installNative(sessionId, path, acquisition, holder, roomOrigin),
          nativeStream: (sessionId, text, opts, own, room) =>
            runtime.#nativeStream(sessionId, text, opts, own, room),
          sendScenario: (sessionId, text, opts, native) =>
            runtime.#sendScenario(sessionId, text, opts, native),
        })
      );
    originalTestModeMethods.register(this.#nativeMethodKey, createOriginalNativeView(this));
    const createOriginalSessionView = (runtime: TestModeRuntime) =>
      projectOriginalTestModeSessionView(
        this,
        originalTestModeCustody,
        declaredCanonicalIds,
        originalTestModeNativeMaps.originalObjectFreeze<OriginalTestModeSessionViewPorts>({
          type: () => runtime.type,
          registry: () => runtime.registry,
          settingsPort: () => runtime.settingsPort,
          managedMcp: () => runtime.managedMcp,
          openTurns: () => runtime.openTurns,
          nativeEntries: () => runtime.#nativeEntries,
          nativePrincipals: () => runtime.#nativePrincipals,
          nativeRoomEmitter: () => runtime.#nativeRoomEmitter,
          originalScenarioStarts: () => runtime.#originalScenarioStarts,
          setOriginalScenarioStarts: (value) => {
            runtime.#originalScenarioStarts = value;
          },
          nativeLocks: () => runtime.#nativeLocks,
          originalNativeCanonicalAliases: () => runtime.#originalNativeCanonicalAliases,
          revealCanonicalSessionId: () => {
            const fn = runtime.revealCanonicalSessionId;
            return (sessionId: string) => originalTestModeCallbackApply(fn, runtime, [sessionId]);
          },
          syntheticCompaction: () => {
            const fn = runtime.syntheticCompaction;
            return () => originalTestModeCallbackApply(fn, runtime, []);
          },
        })
      );
    const sessionView = createOriginalSessionView(this);
    originalTestModeScenario.register(this.#scenarioKey, sessionView);
    originalTestModeSessions.register(this.#sessionsKey, sessionView);
    originalTestModeInteractions.register(this.#interactionsKey, sessionView);
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
    return testModeNativeMethods.installNative(
      this.#nativeMethodKey,
      sessionId,
      path,
      acquisition,
      holder,
      roomOrigin
    );
  }
  #prepareNative(
    source: OriginalFrozenRoomSource,
    holder: SseResponse,
    key: string
  ): Promise<PreparedRoomResponder | undefined> {
    return testModeNativeMethods.prepareNative(this.#nativeMethodKey, source, holder, key);
  }
  #nativeStream(
    sessionId: string,
    text: string,
    opts: MessageOpts | undefined,
    own: TestModeInstalled,
    room?: { prepared: PreparedRoomResponder; committed: OriginalCommittedRoomResponder }
  ) {
    return testModeNativeMethods.nativeStream(
      this.#nativeMethodKey,
      sessionId,
      text,
      opts,
      own,
      room
    );
  }

  setSessionSettings(port: SessionSettingsPort): void {
    this.settingsPort = port;
  }

  sendMessage(sessionId: string, content: string, opts?: MessageOpts): AsyncGenerator<StreamEvent> {
    return this.#sendScenario(sessionId, content, opts);
  }
  #sendScenario(
    sessionId: string,
    content: string,
    opts?: MessageOpts,
    native?: {
      own: TestModeInstalled;
      room?: { prepared: PreparedRoomResponder; committed: OriginalCommittedRoomResponder };
    }
  ): AsyncGenerator<StreamEvent> {
    return testModeScenarioMethods.sendScenario(
      this.#scenarioKey,
      sessionId,
      content,
      opts,
      native
    );
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
  executeCommandIntent(
    sessionId: string,
    _intent: RuntimeCommandIntentId,
    _opts?: CommandIntentOpts
  ): AsyncGenerator<StreamEvent> {
    return testModeScenarioMethods.executeCommandIntent(
      this.#scenarioKey,
      sessionId,
      _intent,
      _opts
    );
  }

  /** The compaction {@link executeCommandIntent} reports, in the Claude adapter's shape. */
  private syntheticCompaction(): AsyncGenerator<StreamEvent> {
    return testModeScenarioMethods.syntheticCompaction(this.#scenarioKey);
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

  getCapabilities(): RuntimeCapabilities {
    return this.capabilities;
  }

  /** Start answering a declared canonical id, and move the tracked metadata to it. */
  private revealCanonicalSessionId(sessionId: string): void {
    return testModeSessionsMethods.revealCanonicalSessionId(this.#sessionsKey, sessionId);
  }

  /**
   * @inheritdoc
   *
   * Live here is a scripted turn still open or a held scripted process. Each
   * picked session has its turn aborted and its process given back.
   */
  async endSessionsWhere(belongs: (session: LiveSessionRef) => boolean): Promise<string[]> {
    readOriginalTestModeSessionsView(this.#sessionsKey);
    const ended: string[] = [];
    for (const sessionId of this.registry.ids()) {
      const open = this.isTurnOpen(sessionId) || interactionGate.isOpen(sessionId);
      const warm = heldProcesses.warmth(sessionId) !== 'cold';
      if (!open && !warm) continue;
      if (!picksSession(belongs, { sessionId, cwd: this.registry.get(sessionId)?.cwd })) continue;
      const receipt = await this.interruptQuery(sessionId);
      const released = heldProcesses.reap(sessionId);
      if (receipt.outcome === 'acked' || receipt.outcome === 'closed' || released) {
        ended.push(sessionId);
      }
    }
    return ended;
  }
}

/** Fixed retirement of the actual original raw source, never a replaced public iterator method. */
export function retireTestModeOriginalRoomResponderStream(
  stream: object
): Promise<void> | undefined {
  return testModeStreams.get(stream)?.retire();
}
