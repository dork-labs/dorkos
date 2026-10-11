import { createIsolatedCodexNativeContinuations } from './runtime/codex-native-continuations.js';
const originalCodexNativeContinuations = createIsolatedCodexNativeContinuations();
const originalCodexNativeContinuationApply = Reflect.apply;
const originalCodexPrivateConstructionFreeze = Object.freeze;
import { createIsolatedCodexCommandIntentProducer } from './runtime/codex-command-intent-producer.js';
const originalCodexCommandIntents = createIsolatedCodexCommandIntentProducer();
import { createIsolatedCodexRuntimeDiscovery } from './runtime/codex-runtime-discovery.js';
const originalCodexDiscovery = createIsolatedCodexRuntimeDiscovery();
const originalCodexDiscoveryApply = Reflect.apply;
import { createIsolatedCodexOwnedMessageProducer } from './runtime/codex-owned-message-producer.js';
const originalCodexOwnedMessages = createIsolatedCodexOwnedMessageProducer();
const originalCodexOwnedMessageApply = Reflect.apply;
import { createIsolatedCodexSessionQueries } from './runtime/codex-session-queries.js';
const originalCodexQueries = createIsolatedCodexSessionQueries();
const originalCodexQueryApply = Reflect.apply;
import {
  MAX_CONSECUTIVE_WAKES,
  WAKE_BUDGET_SPENT_COPY,
  sharedWakeContext,
  type CodexRuntimeOptions,
  type CodexPreparedRoomContinuation,
  type CodexWakeContext,
} from './runtime/codex-runtime-data.js';
export { MAX_CONSECUTIVE_WAKES, WAKE_BUDGET_SPENT_COPY } from './runtime/codex-runtime-data.js';
export type { CodexRuntimeOptions } from './runtime/codex-runtime-data.js';
import { createIsolatedCodexNativeCustody } from './runtime/codex-native-custody.js';
import { captureOriginalRoomDispatchLifecycle } from '../../session/trigger-turn.js';
import type { OriginalRoomDispatchCustody } from '../../rooms/service/room-core.js';
import { readOriginalFrozenRoomTarget } from '../../canvas/doc-channel/operations/room-current-operation.js';
import type {
  OriginalFrozenRoomSource,
  PreparedRoomResponder,
} from '../../canvas/doc-channel/current/current-operation-types.js';
import { AccountsAccessContext } from '../shared/accounts-access-context.js';
/**
 * Codex Runtime — implements the AgentRuntime interface for OpenAI Codex.
 *
 * One DorkOS session maps to one Codex thread (ADR-0309), bound durably via
 * {@link CodexThreadMap}. How a turn reaches Codex is a transport's job
 * (`transport/`, ADR 261005-113107): on `exec` each turn is a fresh
 * `codex exec` subprocess through the SDK; on `app-server` it is one turn on a
 * long-lived `codex app-server` per Codex home. Everything above "run one
 * resolved turn" lives here: settings, the cwd chain, who pays, the model
 * swap, the connector binding and its lease, the identity token, managed MCP
 * servers, the context gate, prompt assembly, the registry and `codex_threads`
 * writes, and media capture.
 *
 * Live turn state follows the test-mode pattern: `sendMessage` is a pure
 * StreamEvent producer (the platform's trigger-turn consumes it into the
 * per-session {@link SessionStateProjector}), and `subscribeSession` /
 * `getSessionSnapshot` / `getMessageHistory` are served from that projector's
 * DorkOS-owned EventLog for sessions created here. Local CLI and desktop
 * threads are discovered from Codex's native rollouts in the selected home;
 * imported sessions read those native transcripts and resume the same thread.
 * Durable `codex_threads` bindings and display metadata survive restart.
 *
 * Approvals, questions, elicitations and steering exist only on the
 * app-server transport (spec §10, §11): `codex exec` closes stdin after the
 * prompt (NOTES.md Verdict 1), so on exec `approveTool` honestly reports
 * `false` and `deliverIntoTurn` is absent. The capabilities a client reads
 * follow the transport the runtime was built with.
 *
 * @module services/runtimes/codex/codex-runtime
 */
import type {
  StreamEvent,
  ModelOption,
  SubagentInfo,
  Session,
  HistoryMessage,
  TaskItem,
  CommandRegistry,
  SessionSettings,
  InterruptReceipt,
} from '@dorkos/shared/types';
import type {
  AgentRegistryPort,
  AgentRuntime,
  RuntimeCapabilities,
  DependencyCheck,
  SessionOpts,
  MessageOpts,
  CommandIntentOpts,
  SseResponse,
  SessionSettingsPort,
  ManagedMcpServerResolver,
  SessionUpdateResult,
  SessionWarmth,
  ToolDecisionOptions,
  InteractionAnswerOptions,
  DeliverIntoTurnOpts,
  RuntimeDeliveryResult,
} from '@dorkos/shared/agent-runtime';
import type {
  SessionSnapshot,
  SessionEvent,
  SessionListEvent,
} from '@dorkos/shared/session-stream';
import type { RuntimeCommandIntentId } from '@dorkos/shared/command-intents';
import type { McpServerEntry } from '@dorkos/shared/transport';
import { peekProjector } from '../../session/session-state-projector.js';
import {
  SessionLockManager,
  runtimeLockHolder,
  captureNativeSessionAcquisition,
  requireOriginalNativeSessionAcquisitionRetired,
  type NativeSessionAcquisition,
} from '../../session/session-lock.js';
import { logger } from '../../../lib/logger.js';
import { DEFAULT_CWD } from '../../../lib/resolve-root.js';
import { type AgentHome } from '../../core/agent-identity/index.js';
import { resolveCodexBinaryPath } from './check-dependencies.js';
import { ensureCreditsCodexHome, threadRunsOnCredits } from './credits-launch.js';
import { resolveCreditsLaunch } from '../../core/cloud/credits-inference.js';
import { type CreditsLaunch } from '../../core/cloud/credits-protocols.js';
import { creditsIsDefaultFor } from '../../core/cloud/credits-defaults.js';
import type { SessionAttachmentStore } from '../../session/attachments/index.js';
import { CodexSessionRegistry } from './session-registry.js';
import { CodexNativeSessionReader } from './native-session-reader.js';
import {
  CodexThreadMap,
  type CodexThreadMetadataPatch,
  type CodexThreadRecord,
} from './thread-map.js';
import { CODEX_CAPABILITIES } from './runtime-constants.js';
import {
  ExecCodexTransport,
  createAppServerTransport,
  type CodexTransport,
  type CodexTransportKind,
} from './transport/index.js';
import { backgroundDoneEvent } from './transport/app-server-transport.js';
import { buildBackgroundUpdate, type BackgroundWake } from './app-server/background-work.js';
import type { CreditsRelay } from '../../core/cloud/credits-relay.js';
import { CodexModelCatalog } from './model-catalog.js';
import { CodexContextGate } from './context-gate.js';
import { type ConnectorRuntimeTools } from '../connector-tools.js';

/**
 * How long a warmed Codex MCP-status cache stays fresh before {@link CodexRuntime.getMcpStatus}
 * kicks a background re-warm. Codex MCP config changes out-of-band (`codex mcp
 * add/remove`), so a lifetime cache would never reflect edits without a server
 * restart; a short TTL surfaces them on the next poll while keeping the getter
 * synchronous.
 */
const MCP_STATUS_TTL_MS = 60_000;

/**
 * Deadline for reading a rollout's last context reading when a session is
 * opened. Wider than a live turn's (that one waits on nothing but a file just
 * written); still bounded, so a slow disk only costs the gauge.
 */
const CONTEXT_USAGE_AT_REST_TIMEOUT_MS = 500;

/** This runtime's own mode descriptors — the only meaning any mode id has. */
const CODEX_MODES = CODEX_CAPABILITIES.permissionModes.values ?? [];

/** The mode a session runs under until something says otherwise. */
const CODEX_DEFAULT_MODE = CODEX_CAPABILITIES.permissionModes.default ?? 'default';

/**
 * Codex runtime implementing the universal AgentRuntime interface.
 */
const nativeMapGet = Map.prototype.get;
const nativeMapSet = Map.prototype.set;
const nativeSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const originalCodexCustody = createIsolatedCodexNativeCustody(nativeMapGet, nativeSignalAborted);
const codexLockedRunners = originalCodexCustody.codexLockedRunners;
const codexRoomPreparers = originalCodexCustody.codexRoomPreparers;
const codexOriginalActiveSlots = originalCodexCustody.codexOriginalActiveSlots;
const codexNativeConstructors = originalCodexCustody.codexNativeConstructors;
const codexNativeControllers = originalCodexCustody.codexNativeControllers;
/** Original native custody reader bound to the runtime module-private instance. */
export const readCodexOriginalLockedStream: (
  ...args: Parameters<typeof originalCodexCustody.readCodexOriginalLockedStream>
) => ReturnType<typeof originalCodexCustody.readCodexOriginalLockedStream> =
  originalCodexCustody.readCodexOriginalLockedStream;
/** Original native custody reader bound to the runtime module-private instance. */
export const readCodexOriginalLockedTurnOptions: (
  ...args: Parameters<typeof originalCodexCustody.readCodexOriginalLockedTurnOptions>
) => ReturnType<typeof originalCodexCustody.readCodexOriginalLockedTurnOptions> =
  originalCodexCustody.readCodexOriginalLockedTurnOptions;
/** Original native custody reader bound to the runtime module-private instance. */
export const retireCodexOriginalRoomResponderStream: (
  ...args: Parameters<typeof originalCodexCustody.retireCodexOriginalRoomResponderStream>
) => ReturnType<typeof originalCodexCustody.retireCodexOriginalRoomResponderStream> =
  originalCodexCustody.retireCodexOriginalRoomResponderStream;
/** Original native custody reader bound to the runtime module-private instance. */
export const readCodexOriginalRoomResponderStream: (
  ...args: Parameters<typeof originalCodexCustody.readCodexOriginalRoomResponderStream>
) => ReturnType<typeof originalCodexCustody.readCodexOriginalRoomResponderStream> =
  originalCodexCustody.readCodexOriginalRoomResponderStream;
/** Original native custody reader bound to the runtime module-private instance. */
export const sendCodexOriginalLockedMessage: (
  ...args: Parameters<typeof originalCodexCustody.sendCodexOriginalLockedMessage>
) => ReturnType<typeof originalCodexCustody.sendCodexOriginalLockedMessage> =
  originalCodexCustody.sendCodexOriginalLockedMessage;
/** Original native custody reader bound to the runtime module-private instance. */
export const prepareCodexOriginalLockedRoomResponder: (
  ...args: Parameters<typeof originalCodexCustody.prepareCodexOriginalLockedRoomResponder>
) => ReturnType<typeof originalCodexCustody.prepareCodexOriginalLockedRoomResponder> =
  originalCodexCustody.prepareCodexOriginalLockedRoomResponder;
/** Original native custody reader bound to the runtime module-private instance. */
export const retireCodexPreparedRoomResponder: (
  ...args: Parameters<typeof originalCodexCustody.retireCodexPreparedRoomResponder>
) => ReturnType<typeof originalCodexCustody.retireCodexPreparedRoomResponder> =
  originalCodexCustody.retireCodexPreparedRoomResponder;
/** Original native custody reader bound to the runtime module-private instance. */
export const readCodexPreparedRoomResponder: (
  ...args: Parameters<typeof originalCodexCustody.readCodexPreparedRoomResponder>
) => ReturnType<typeof originalCodexCustody.readCodexPreparedRoomResponder> =
  originalCodexCustody.readCodexPreparedRoomResponder;
/** Original native custody reader bound to the runtime module-private instance. */
export const startCodexCommittedRoomResponder: (
  ...args: Parameters<typeof originalCodexCustody.startCodexCommittedRoomResponder>
) => ReturnType<typeof originalCodexCustody.startCodexCommittedRoomResponder> =
  originalCodexCustody.startCodexCommittedRoomResponder;
/** Original native custody reader bound to the runtime module-private instance. */
export const readCodexNativeOperation: (
  ...args: Parameters<typeof originalCodexCustody.readCodexNativeOperation>
) => ReturnType<typeof originalCodexCustody.readCodexNativeOperation> =
  originalCodexCustody.readCodexNativeOperation;

/** Run Codex sessions with their original client and native turn lifetimes. */
export class CodexRuntime implements AgentRuntime {
  readonly #nativeContinuationKey = originalCodexPrivateConstructionFreeze({});
  readonly #queryKey = originalCodexPrivateConstructionFreeze({});
  readonly #discoveryKey = originalCodexPrivateConstructionFreeze({});
  readonly #ownedMessageKey = originalCodexPrivateConstructionFreeze({});
  readonly #commandIntentKey = originalCodexPrivateConstructionFreeze({});
  readonly type = 'codex' as const;

  /** How turns reach Codex — see {@link CodexRuntimeOptions.transport}. */
  readonly #transport: CodexTransport;
  readonly #runTransportTurn: CodexTransport['runTurn'];
  /** How this runtime finds its `codex` binary — see {@link CodexRuntimeOptions.resolveBinary}. */
  private readonly resolveBinary: () => Promise<string | null>;
  /** Models visible to the same binary and Codex account a real turn uses. */
  private readonly modelCatalog: Pick<CodexModelCatalog, 'getSupportedModels'>;
  /**
   * The agent registry, when the composition root injected it. Used only to
   * decide whether this turn's working directory hosts a registered agent: the
   * same guard the Claude adapter applies before minting an identity token.
   */
  private meshCore: AgentRegistryPort | undefined;
  /** Internal connector tool boundary, installed after boot opens its listener. */
  private connectorRuntimeTools: ConnectorRuntimeTools | undefined;
  private readonly accountsAccess = new AccountsAccessContext();
  /**
   * Resolver for an agent's enabled managed MCP servers, when the composition
   * root injected it. Absent leaves every turn with only the `dorkos_ui`
   * bridge — the safe default (spec `mcp-server-management`, DOR-892).
   */
  private managedMcpServers: ManagedMcpServerResolver | undefined;
  private readonly nativeSessions: CodexNativeSessionReader;
  private readonly threadMap: CodexThreadMap;
  /** Floor of the turn cwd resolution chain — see {@link CodexRuntimeOptions.defaultCwd}. */
  private readonly defaultCwd: string;
  private readonly registry = new CodexSessionRegistry();
  /** The in-flight turns running on DorkOS credits, so an unlink can stop them at once. */
  private readonly creditsTurns = new Set<AbortController>();
  private readonly locks = new SessionLockManager();
  readonly #runtimeWakeAcquisitions = new Map<
    string,
    Readonly<{
      acquisition: NativeSessionAcquisition;
      holder: SseResponse;
      manager: SessionLockManager;
    }>
  >();
  /** One AbortController per in-flight turn (NOTES.md Verdict 3). */
  private readonly activeTurns = new Map<string, AbortController>();
  /** Told when a dispatched turn opens (DOR-2717), on a transport with background work. */
  private readonly dispatchedTurnListeners = new Set<(sessionId: string) => void>();
  /**
   * Model turns each session's background work started in a row with no
   * dispatched turn between them; see {@link MAX_CONSECUTIVE_WAKES}.
   */
  private readonly consecutiveWakes = new Map<string, number>();
  /**
   * The one wake per session that is being read right now. Only it may start
   * a model turn: a second wake read meanwhile (drained by a consumer that
   * gave up on the lock the first one holds) shows its finishes and stops.
   */
  private readonly openWakes = new Map<string, symbol>();
  /** Connector bearer bound to the exact in-flight turn controller. */
  private readonly activeConnectorBindings = new Map<AbortController, string>();
  /**
   * What DorkOS context each session's thread already holds, so the identity
   * blocks are not re-sent into a rollout that already carries them (DOR-477).
   */
  private readonly contextGate = new CodexContextGate();
  private settingsPort: SessionSettingsPort | undefined;
  /**
   * Last enumerated Codex MCP servers, or `null` until the first successful
   * enumeration. `getMcpStatus` is synchronous (the interface contract), so the
   * async `codex mcp list` probe warms this cache lazily and out-of-band.
   */
  private mcpStatusCache: McpServerEntry[] | null = null;
  /** In-flight MCP warm, so concurrent `getMcpStatus` calls trigger at most one probe. */
  private mcpWarmPromise: Promise<void> | null = null;
  /**
   * Wall-clock ms of the last successful warm, or `null` until the first
   * success. Drives the {@link MCP_STATUS_TTL_MS} re-warm so config edits made
   * via `codex mcp add/remove` surface without a server restart.
   */
  private mcpStatusWarmedAt: number | null = null;

  /** Where a turn's images go, or `null` when the composition root wired none. */
  private readonly attachments: SessionAttachmentStore | null;

  constructor(options: CodexRuntimeOptions) {
    /** Build the exact constructor-owned continuation view with original live descriptors. */
    const createOriginalContinuationView = (
      continuationRuntime: CodexRuntime
    ): Readonly<Parameters<typeof originalCodexNativeContinuations.register>[1]> =>
      originalCodexPrivateConstructionFreeze<
        Parameters<typeof originalCodexNativeContinuations.register>[1]
      >({
        runtime: continuationRuntime,
        custody: originalCodexCustody,
        nativeMapGet,
        nativeMapSet,
        get activeTurns() {
          return continuationRuntime.activeTurns;
        },
        get activeConnectorBindings() {
          return continuationRuntime.activeConnectorBindings;
        },
        get connectorRuntimeTools() {
          return continuationRuntime.connectorRuntimeTools;
        },
        get meshCore() {
          return continuationRuntime.meshCore;
        },
        get sendOwnedMessage() {
          const fn = continuationRuntime.#sendOwnedMessage;
          return (...args: Parameters<typeof fn>) =>
            originalCodexNativeContinuationApply(fn, continuationRuntime, args);
        },
        get installNativeTurn() {
          const fn = continuationRuntime.#installNativeTurn;
          return (...args: Parameters<typeof fn>) =>
            originalCodexNativeContinuationApply(fn, continuationRuntime, args);
        },
        get createMessage() {
          const fn = continuationRuntime.#createMessage;
          return (...args: Parameters<typeof fn>) =>
            originalCodexNativeContinuationApply(fn, continuationRuntime, args);
        },
        get identityPathFor() {
          const fn = continuationRuntime.identityPathFor;
          return (...args: Parameters<typeof fn>) =>
            originalCodexNativeContinuationApply(fn, continuationRuntime, args);
        },
      });
    originalCodexNativeContinuations.register(
      this.#nativeContinuationKey,
      createOriginalContinuationView(this)
    );
    /** Build the exact constructor-owned discovery view with original live descriptors. */
    const createOriginalDiscoveryView = (
      discoveryRuntime: CodexRuntime
    ): Readonly<Parameters<typeof originalCodexDiscovery.register>[1]> =>
      originalCodexPrivateConstructionFreeze<Parameters<typeof originalCodexDiscovery.register>[1]>(
        {
          MCP_STATUS_TTL_MS,
          CONTEXT_USAGE_AT_REST_TIMEOUT_MS,
          get transport() {
            return discoveryRuntime.#transport;
          },
          get modelCatalog() {
            return discoveryRuntime.modelCatalog;
          },
          get attachments() {
            return discoveryRuntime.attachments;
          },
          get meshCore() {
            return discoveryRuntime.meshCore;
          },
          get connectorRuntimeTools() {
            return discoveryRuntime.connectorRuntimeTools;
          },
          get threadMap() {
            return discoveryRuntime.threadMap;
          },
          get resolveBinary() {
            return discoveryRuntime.resolveBinary;
          },
          get mcpStatusCache() {
            return discoveryRuntime.mcpStatusCache;
          },
          set mcpStatusCache(value: McpServerEntry[] | null) {
            discoveryRuntime.mcpStatusCache = value;
          },
          get mcpStatusWarmedAt() {
            return discoveryRuntime.mcpStatusWarmedAt;
          },
          set mcpStatusWarmedAt(value: number | null) {
            discoveryRuntime.mcpStatusWarmedAt = value;
          },
          get mcpWarmPromise() {
            return discoveryRuntime.mcpWarmPromise;
          },
          set mcpWarmPromise(value: Promise<void> | null) {
            discoveryRuntime.mcpWarmPromise = value;
          },
          get identityPathFor() {
            const fn = discoveryRuntime.identityPathFor;
            return (cwd: string, forAgent: string | undefined) =>
              originalCodexDiscoveryApply(fn, discoveryRuntime, [cwd, forAgent]);
          },
          get maybeWarmMcpStatus() {
            const fn = discoveryRuntime.maybeWarmMcpStatus;
            return () => originalCodexDiscoveryApply(fn, discoveryRuntime, []);
          },
          get warmMcpStatus() {
            const fn = discoveryRuntime.warmMcpStatus;
            return () => originalCodexDiscoveryApply(fn, discoveryRuntime, []);
          },
        }
      );
    originalCodexDiscovery.register(this.#discoveryKey, createOriginalDiscoveryView(this));
    /** Build the shared constructor-owned message and command view with original live descriptors. */
    const createOriginalProducerView = (
      producerRuntime: CodexRuntime
    ): Readonly<
      Parameters<typeof originalCodexOwnedMessages.register>[1] &
        Parameters<typeof originalCodexCommandIntents.register>[1]
    > =>
      originalCodexPrivateConstructionFreeze<
        Parameters<typeof originalCodexOwnedMessages.register>[1] &
          Parameters<typeof originalCodexCommandIntents.register>[1]
      >({
        runtime: producerRuntime,
        get transport() {
          return producerRuntime.#transport;
        },
        get runTransportTurn() {
          return producerRuntime.#runTransportTurn;
        },
        get dispatchedTurnListeners() {
          return producerRuntime.dispatchedTurnListeners;
        },
        get consecutiveWakes() {
          return producerRuntime.consecutiveWakes;
        },
        get threadMap() {
          return producerRuntime.threadMap;
        },
        get registry() {
          return producerRuntime.registry;
        },
        get defaultCwd() {
          return producerRuntime.defaultCwd;
        },
        get meshCore() {
          return producerRuntime.meshCore;
        },
        get connectorRuntimeTools() {
          return producerRuntime.connectorRuntimeTools;
        },
        get managedMcpServers() {
          return producerRuntime.managedMcpServers;
        },
        get creditsTurns() {
          return producerRuntime.creditsTurns;
        },
        get activeConnectorBindings() {
          return producerRuntime.activeConnectorBindings;
        },
        get activeTurns() {
          return producerRuntime.activeTurns;
        },
        get type() {
          return producerRuntime.type;
        },
        get contextGate() {
          return producerRuntime.contextGate;
        },
        get accountsAccess() {
          return producerRuntime.accountsAccess;
        },
        get attachments() {
          return producerRuntime.attachments;
        },
        get importNativeThread() {
          const fn = producerRuntime.importNativeThread;
          return (sessionId: string, isCurrent?: () => boolean) =>
            originalCodexOwnedMessageApply(fn, producerRuntime, [sessionId, isCurrent]);
        },
        get seedFromDurable() {
          const fn = producerRuntime.seedFromDurable;
          return (sessionId: string) =>
            originalCodexOwnedMessageApply(fn, producerRuntime, [sessionId]);
        },
        get resolveTurnSettings() {
          const fn = producerRuntime.resolveTurnSettings;
          return (sessionId: string, opts?: MessageOpts) =>
            originalCodexOwnedMessageApply(fn, producerRuntime, [sessionId, opts]);
        },
        get persistSessionMetadata() {
          const fn = producerRuntime.persistSessionMetadata;
          return (sessionId: string) =>
            originalCodexOwnedMessageApply(fn, producerRuntime, [sessionId]);
        },
        get identityPathFor() {
          const fn = producerRuntime.identityPathFor;
          return (cwd: string, forAgent: string | undefined) =>
            originalCodexOwnedMessageApply(fn, producerRuntime, [cwd, forAgent]);
        },
        get creditsLaunchFor() {
          const fn = producerRuntime.creditsLaunchFor;
          return (threadId: string | undefined) =>
            originalCodexOwnedMessageApply(fn, producerRuntime, [threadId]);
        },
        get getCapabilities() {
          const fn = producerRuntime.getCapabilities;
          return () => originalCodexOwnedMessageApply(fn, producerRuntime, []);
        },
        get updateSession() {
          const fn = producerRuntime.updateSession;
          return (sessionId: string, opts: SessionSettings) =>
            originalCodexOwnedMessageApply(fn, producerRuntime, [sessionId, opts]);
        },
        get resolveTurnBinary() {
          const fn = producerRuntime.resolveTurnBinary;
          return () => originalCodexOwnedMessageApply(fn, producerRuntime, []);
        },
        get toMetadataPatch() {
          const fn = producerRuntime.toMetadataPatch;
          return (session: Session) =>
            originalCodexOwnedMessageApply(fn, producerRuntime, [session]);
        },
        get installNativeTurn() {
          const fn = producerRuntime.#installNativeTurn;
          return (
            sessionId: string,
            cwd: string,
            agentPath: string | undefined,
            controller: AbortController,
            acquisition?: NativeSessionAcquisition,
            refuseExisting?: boolean,
            roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>
          ) =>
            originalCodexOwnedMessageApply(fn, producerRuntime, [
              sessionId,
              cwd,
              agentPath,
              controller,
              acquisition,
              refuseExisting,
              roomOrigin,
            ]);
        },
      });
    const originalProducerView = createOriginalProducerView(this);
    originalCodexOwnedMessages.register(this.#ownedMessageKey, originalProducerView);
    originalCodexCommandIntents.register(this.#commandIntentKey, originalProducerView);
    /** Build the exact constructor-owned query view with original live descriptors. */
    const createOriginalQueryView = (
      queryRuntime: CodexRuntime
    ): Readonly<Parameters<typeof originalCodexQueries.register>[1]> =>
      originalCodexPrivateConstructionFreeze<Parameters<typeof originalCodexQueries.register>[1]>({
        CODEX_MODES,
        CODEX_DEFAULT_MODE,
        get settingsPort() {
          return queryRuntime.settingsPort;
        },
        get importNativeThread() {
          const fn = queryRuntime.importNativeThread;
          return (sessionId: string, ...args: [isCurrent?: () => boolean]) =>
            originalCodexQueryApply(fn, queryRuntime, [sessionId, ...args]);
        },
        get maybeWarmMcpStatus() {
          const fn = queryRuntime.maybeWarmMcpStatus;
          return () => originalCodexQueryApply(fn, queryRuntime, []);
        },
        get seedDisplayFromDurable() {
          const fn = queryRuntime.seedDisplayFromDurable;
          return (sessionId: string) => originalCodexQueryApply(fn, queryRuntime, [sessionId]);
        },
        get persistSessionMetadata() {
          const fn = queryRuntime.persistSessionMetadata;
          return (sessionId: string) => originalCodexQueryApply(fn, queryRuntime, [sessionId]);
        },
        get buildDurableSession() {
          const fn = queryRuntime.buildDurableSession;
          return (record: CodexThreadRecord) => originalCodexQueryApply(fn, queryRuntime, [record]);
        },
        get toDurableDisplaySession() {
          const fn = queryRuntime.toDurableDisplaySession;
          return (record: CodexThreadRecord) => originalCodexQueryApply(fn, queryRuntime, [record]);
        },
        get toMetadataPatch() {
          const fn = queryRuntime.toMetadataPatch;
          return (session: Session) => originalCodexQueryApply(fn, queryRuntime, [session]);
        },
        get getCapabilities() {
          const fn = queryRuntime.getCapabilities;
          return () => originalCodexQueryApply(fn, queryRuntime, []);
        },
        get threadMap() {
          return queryRuntime.threadMap;
        },
        get activeTurns() {
          return queryRuntime.activeTurns;
        },
        get registry() {
          return queryRuntime.registry;
        },
        get nativeSessions() {
          return queryRuntime.nativeSessions;
        },
        get hasThreadProof() {
          const fn = queryRuntime.hasThreadProof;
          return (sessionId: string) => originalCodexQueryApply(fn, queryRuntime, [sessionId]);
        },
        get withNativeSettings() {
          const fn = queryRuntime.withNativeSettings;
          return (native: Session) => originalCodexQueryApply(fn, queryRuntime, [native]);
        },
        get withNativeIdentity() {
          const fn = queryRuntime.withNativeIdentity;
          return (tracked: Session, native: Session) =>
            originalCodexQueryApply(fn, queryRuntime, [tracked, native]);
        },
        get seedFromDurable() {
          const fn = queryRuntime.seedFromDurable;
          return (sessionId: string) => originalCodexQueryApply(fn, queryRuntime, [sessionId]);
        },
        get findSession() {
          const fn = queryRuntime.findSession;
          return (sessionId: string) => originalCodexQueryApply(fn, queryRuntime, [sessionId]);
        },
        get getMessageHistory() {
          const fn = queryRuntime.getMessageHistory;
          return (projectDir: string, sessionId: string) =>
            originalCodexQueryApply(fn, queryRuntime, [projectDir, sessionId]);
        },
      });
    originalCodexQueries.register(this.#queryKey, createOriginalQueryView(this));
    codexNativeConstructors.add(this);
    codexOriginalActiveSlots.set(this, this.activeTurns);
    const originalLocks = this.locks;
    codexRoomPreparers.set(this, (source, holder, key) => {
      const target = readOriginalFrozenRoomTarget(source, 'codex');
      const acquisition = captureNativeSessionAcquisition(originalLocks, key, holder);
      if (!acquisition || target.sessionId !== key) return Promise.resolve(undefined);
      return this.#prepareRoomResponder(source, target, acquisition);
    });
    codexLockedRunners.set(this, (sessionId, content, opts, holder, lockKey) => {
      const acquisition = captureNativeSessionAcquisition(originalLocks, lockKey, holder);
      if (!acquisition)
        throw new Error('Native turn requires its exact original session lock acquisition.');
      const custody = captureOriginalRoomDispatchLifecycle(holder, this);
      const roomOrigin = custody ? Object.freeze({ holder, custody }) : undefined;
      return this.#createMessage(sessionId, content, opts, acquisition, roomOrigin);
    });
    this.attachments = options.attachments ?? null;
    this.nativeSessions = new CodexNativeSessionReader(undefined, this.attachments);
    this.threadMap = options.threadMap;
    this.defaultCwd = options.defaultCwd ?? DEFAULT_CWD;
    this.resolveBinary = options.resolveBinary ?? resolveCodexBinaryPath;
    this.modelCatalog =
      options.modelCatalog ?? new CodexModelCatalog({ resolveBinary: this.resolveBinary });
    this.#transport = this.buildTransport(options.transport, options.creditsRelay);
    this.#runTransportTurn = this.#transport.runTurn;
    // Capability-gated members exist only where the transport backs them, so a
    // runtime on exec keeps the shape it always had.
    if (this.#transport.getSessionWarmth) {
      const transport = this.#transport;
      this.getSessionWarmth = (sessionId) => transport.getSessionWarmth?.(sessionId) ?? 'cold';
      this.reapSession = async (sessionId) => transport.reapSession?.(sessionId);
      // A turn here ends with its stream (the generator returns at its own
      // terminal), so there is never an open turn left to settle.
      this.settleOpenTurn = async () => false;
    }
    // Present only where the transport can take a message mid-turn: on exec
    // it stays absent (C1: "absent or refused as unsupported").
    if (this.#transport.deliverIntoTurn) {
      const transport = this.#transport;
      this.deliverIntoTurn = (sessionId, content, opts) =>
        transport.deliverIntoTurn!(sessionId, content, opts);
    }
    // Work that outlives its turn (spec §12): only a transport that keeps the
    // thread loaded can hear it finish, so only there can the agent start a
    // turn of its own. On exec every one of these stays absent.
    if (this.#transport.onWake) this.installBackgroundWork(this.#transport);
  }

  /**
   * Subscribe to turns the agent starts on its own: a wake when its
   * background work finishes (spec §12). Present only on a transport that
   * keeps threads loaded.
   */
  onRuntimeTurn?: (
    listener: (sessionId: string, events: AsyncIterable<StreamEvent>) => void
  ) => () => void;
  /** Whether a wake is on its way for the session (bounded). */
  isSegmentPending?: (sessionId: string) => boolean;
  /** Told when a pending wake was dropped without opening a turn. */
  onDispatchGateChange?: (listener: (sessionId: string) => void) => () => void;
  /** Whether the session still holds work that can wake it after its turn. */
  holdsBackgroundWork?: (sessionId: string) => boolean;
  /** Told when a turn somebody dispatched opens on a session. */
  onDispatchedTurn?: (listener: (sessionId: string) => void) => () => void;
  /** Whether the open turn has helper agents working (inside the ceiling). */
  isHelperWorking?: (sessionId: string) => boolean;
  /** Take a session for a turn the agent started (the reserved holder). */
  acquireRuntimeLock?: (sessionKey: string, res: SseResponse, token?: symbol) => boolean;

  /**
   * Wire the background-work members over a transport that has them. Each
   * wake becomes one runtime turn: the finished tasks, then — only when the
   * work's own turn ended normally — a model turn told what finished.
   */
  private installBackgroundWork(transport: CodexTransport): void {
    const runtimeTurnListeners = new Set<
      (sessionId: string, events: AsyncIterable<StreamEvent>) => void
    >();
    transport.onWake!((wake) => {
      const listener = [...runtimeTurnListeners].at(-1);
      if (!listener) return false;
      listener(wake.sessionId, this.wakeTurn(wake));
      return true;
    });
    this.onRuntimeTurn = (listener) => {
      runtimeTurnListeners.add(listener);
      return () => void runtimeTurnListeners.delete(listener);
    };
    this.isSegmentPending = (sessionId) => transport.isSegmentPending?.(sessionId) ?? false;
    this.onDispatchGateChange = (listener) =>
      transport.onDispatchGateChange?.(listener) ?? (() => {});
    this.holdsBackgroundWork = (sessionId) => transport.holdsBackgroundWork?.(sessionId) ?? false;
    this.isHelperWorking = (sessionId) => transport.isHelperWorking?.(sessionId) ?? false;
    this.onDispatchedTurn = (listener) => {
      this.dispatchedTurnListeners.add(listener);
      return () => void this.dispatchedTurnListeners.delete(listener);
    };
    const originalLocks = this.locks;
    const acquireRuntimeLock = originalLocks.acquireRuntimeLock;
    this.acquireRuntimeLock = (sessionKey, res, token) => {
      const acquired = acquireRuntimeLock.call(originalLocks, sessionKey, res, token);
      if (acquired) {
        const acquisition = captureNativeSessionAcquisition(originalLocks, sessionKey, res);
        if (acquisition)
          this.#runtimeWakeAcquisitions.set(
            sessionKey,
            Object.freeze({ acquisition, holder: res, manager: originalLocks })
          );
        else this.#runtimeWakeAcquisitions.delete(sessionKey);
      }
      return acquired;
    };
  }

  /**
   * One wake's events: what finished, then either a model turn told about it
   * or a plain end. The notice is DorkOS's, sent as the turn's input; the
   * stream never shows it as the person's words (the turn is the agent's).
   */
  private async *wakeTurn(wake: BackgroundWake): AsyncGenerator<StreamEvent> {
    const { sessionId } = wake;
    const self = Symbol('wake');
    const owner = !this.openWakes.has(sessionId);
    const acquisition = owner ? this.#runtimeWakeAcquisitions.get(sessionId) : undefined;
    if (owner) this.openWakes.set(sessionId, self);
    try {
      yield* this.wakeEvents(wake, owner, acquisition);
    } finally {
      if (this.openWakes.get(sessionId) === self) this.openWakes.delete(sessionId);
      if (owner && this.#runtimeWakeAcquisitions.get(sessionId) === acquisition)
        this.#runtimeWakeAcquisitions.delete(sessionId);
    }
  }

  private async *wakeEvents(
    wake: BackgroundWake,
    owner: boolean,
    acquisition:
      | Readonly<{
          acquisition: NativeSessionAcquisition;
          holder: SseResponse;
          manager: SessionLockManager;
        }>
      | undefined
  ): AsyncGenerator<StreamEvent> {
    const { sessionId } = wake;
    for (const message of wake.notices) {
      yield { type: 'system_status', data: { message } };
    }
    for (const completion of wake.completions) yield backgroundDoneEvent(completion);
    const waking = wake.completions.filter((completion) => completion.wakes);
    const context = wake.startTurn ? sharedWakeContext(waking) : undefined;
    // Only under the reserved runtime lock, and only the wake being read first:
    // a consumer that never took the lock (one that gave up waiting while
    // another wake held it, and is merely draining) must not start a hidden turn.
    const locked =
      owner &&
      !!acquisition &&
      captureNativeSessionAcquisition(acquisition.manager, sessionId, acquisition.holder) ===
        acquisition.acquisition &&
      this.locks.getLockInfo(sessionId)?.clientId === runtimeLockHolder(sessionId);
    const spent = this.consecutiveWakes.get(sessionId) ?? 0;
    if (context === undefined || !locked || spent >= MAX_CONSECUTIVE_WAKES) {
      if (context !== undefined && !locked) {
        logger.warn('[CodexRuntime] a wake ran without the session lock; no model turn', {
          sessionId,
        });
      }
      if (context !== undefined && locked) {
        yield { type: 'system_status', data: { message: WAKE_BUDGET_SPENT_COPY } };
      }
      yield { type: 'done', data: { sessionId } };
      return;
    }
    this.consecutiveWakes.set(sessionId, spent + 1);
    // The session's CURRENT mode, model and effort apply (`resolveTurnSettings`
    // reads them): the context carries none, so a mode the person lowered
    // since the starting turn is never climbed back over.
    yield* this.runTurn(
      sessionId,
      buildBackgroundUpdate(waking),
      context.opts,
      'runtime',
      context,
      acquisition?.acquisition
    );
  }

  /**
   * Deliver a message into the session's open turn (a steer); present only on
   * a transport with mid-turn input. Steering is uniform across its sessions,
   * so there is no `canSteerSession`.
   */
  deliverIntoTurn?: (
    sessionId: string,
    content: string,
    opts: DeliverIntoTurnOpts
  ) => Promise<RuntimeDeliveryResult>;

  /** How warm a session's thread is; present only on a persistent transport. */
  getSessionWarmth?: (sessionId: string) => SessionWarmth;
  /** Give back a session's warm thread; present only on a persistent transport. */
  reapSession?: (sessionId: string) => Promise<void>;
  /** Nothing to settle; present only on a persistent transport. */
  settleOpenTurn?: (sessionId: string) => Promise<boolean>;

  private buildTransport(
    choice: CodexTransportKind | CodexTransport,
    creditsRelay: (() => CreditsRelay | undefined) | undefined
  ): CodexTransport {
    if (typeof choice !== 'string') return choice;
    if (choice === 'app-server') {
      return createAppServerTransport({
        connectorTools: () => this.connectorRuntimeTools,
        ...(creditsRelay ? { creditsRelay } : {}),
      });
    }
    return new ExecCodexTransport();
  }

  /** Stop every process this runtime's transport started (server shutdown). */
  async shutdown(): Promise<void> {
    await this.#transport.shutdown();
  }

  /**
   * Accept the agent registry so a turn can tell whether its working directory
   * hosts a registered agent (the identity-token guard).
   *
   * @param meshCore - The agent registry port from the composition root.
   */
  setMeshCore(meshCore: AgentRegistryPort): void {
    this.meshCore = meshCore;
  }

  /**
   * Accept the managed-MCP-server resolver so a turn can inject the agent's own
   * enabled servers alongside the `dorkos_ui` bridge (spec
   * `mcp-server-management`; Codex declares `supportsManagedMcpServers`).
   *
   * @param resolver - The managed-server resolver from the composition root.
   */
  setManagedMcpServers(resolver: ManagedMcpServerResolver): void {
    this.managedMcpServers = resolver;
  }

  /**
   * The `codex` binary this turn will run, resolved through the same ladder the
   * dependency check reports on.
   *
   * Resolved per turn rather than once at boot, and deliberately not cached: the
   * ladder is a config read plus a couple of `existsSync` calls, which is
   * nothing next to spawning `codex exec`, and paying it every turn means a
   * one-click install or a `runtimes.codex.binaryPath` edit takes effect
   * immediately instead of at the next server restart. Only the CLIENT is
   * memoised, and only while the binary it was built for is still the answer.
   *
   * @throws When nothing resolves — the honest, actionable end of the ladder.
   *   The runtime still registered and its status card still says `missing`
   *   with an install hint; this is what a person sees if they start a turn
   *   anyway.
   */
  private async resolveTurnBinary(): Promise<string> {
    const binary = await this.resolveBinary();
    if (!binary) {
      throw new Error(
        'Codex CLI not found — install it (`npm i -g @openai/codex`) or set `runtimes.codex.binaryPath` in your DorkOS config.'
      );
    }
    return binary;
  }

  /**
   * Stop every turn running on DorkOS credits (ADR 261001-000811): called when
   * this computer is unlinked, so no credits turn outlives the link it was
   * paid under. The next turn of such a session is refused, never moved.
   */
  stopCreditsTurns(): void {
    for (const controller of this.creditsTurns) {
      const operation = codexNativeControllers.get(controller);
      if (operation) operation.retired = true;
      controller.abort();
    }
    void this.#transport.closeCreditsProcess?.().catch((err: unknown) => {
      logger.warn('[CodexRuntime] credits process close failed', { err });
    });
  }

  /**
   * Whether a session's next turn runs on DorkOS credits, by the rule its turn
   * uses (`creditsLaunchFor`): an existing thread by the home its rollout is
   * in, a new one by Codex's recorded default. Read by the model gate, so a
   * model credits do not serve is refused before it is stored (DOR-2636).
   *
   * @param sessionId - The session.
   */
  async sessionRunsOnCredits(sessionId: string): Promise<boolean> {
    const boundThreadId = this.threadMap.get(sessionId)?.threadId;
    if (boundThreadId !== undefined) return threadRunsOnCredits(boundThreadId);
    // A native personal conversation predates DorkOS's current new-session default.
    if (await this.nativeSessions.findSession(sessionId)) return false;
    return creditsIsDefaultFor(this.type);
  }

  /**
   * The credits endpoint and token this turn runs on, or `null` when it runs on
   * the person's own Codex sign-in.
   *
   * Codex has no per-session account pick (the launch route passes an account
   * hint to Claude Code only), so a new thread follows Codex's recorded
   * default, and an existing one follows the home its rollout is in.
   *
   * @param boundThreadId - The thread already bound to the session, if any.
   * @throws {CreditsUnavailableError} When the turn is on credits and credits
   *   cannot pay for it.
   */
  private async creditsLaunchFor(boundThreadId: string | undefined): Promise<CreditsLaunch | null> {
    const onCredits =
      boundThreadId !== undefined
        ? await threadRunsOnCredits(boundThreadId)
        : creditsIsDefaultFor(this.type);
    if (!onCredits) return null;
    ensureCreditsCodexHome();
    return resolveCreditsLaunch(this.getCapabilities(), 'Codex');
  }

  /** Install the internal connector tool boundary after its listener starts. */
  setConnectorRuntimeTools(tools: ConnectorRuntimeTools): void {
    this.connectorRuntimeTools = tools;
  }

  // --- Session lifecycle ---

  ensureSession(sessionId: string, opts: SessionOpts): void {
    return originalCodexQueries.queryEnsureSession(this.#queryKey, sessionId, opts);
  }

  hasSession(sessionId: string): boolean {
    return originalCodexQueries.queryHasSession(this.#queryKey, sessionId);
  }

  /** @inheritdoc */
  isTurnOpen(sessionId: string): boolean {
    return originalCodexQueries.queryIsTurnOpen(this.#queryKey, sessionId);
  }

  /** Codex has no fork surface — a thread can only be resumed, not branched. */
  async forkSession(): Promise<Session | null> {
    return null;
  }

  /**
   * @inheritdoc
   *
   * Auto-creates untracked sessions (the PATCH-before-first-message path) and
   * writes the operator's choice through the durable settings store first
   * (ADR-0260) so it survives restarts; the new mode/model applies on the
   * next turn's ThreadOptions projection.
   *
   * **"Next turn" is the whole story here, and for a TIGHTENING that has to be
   * said out loud (DOR-1435).** A mode becomes a `sandboxMode` in
   * `projectThreadOptions` at the moment a turn starts (`turn-input.ts`), and
   * Codex has no control channel to move it afterwards — there is not even an
   * ack to wait for. So a session PATCHed from Full access back to Read only
   * while a turn is streaming keeps full file and network access until that
   * turn ends, and answering a plain `200 {permissionMode:'default'}` would
   * state a posture the run has not adopted. When a turn is in flight and the
   * change takes permissions away, that is reported rather than assumed.
   */
  async updateSession(sessionId: string, opts: SessionSettings): Promise<SessionUpdateResult> {
    return originalCodexQueries.queryUpdateSession(this.#queryKey, sessionId, opts);
  }

  /**
   * Codex has no writable native session store, so the title lives in the
   * tracked-session metadata and is written through to the session's durable
   * `codex_threads` row (when one exists) so it survives a server restart.
   */
  async renameSession(sessionId: string, title: string): Promise<void> {
    return originalCodexQueries.queryRenameSession(this.#queryKey, sessionId, title);
  }

  /**
   * Re-seed the in-memory session registry from the durable `codex_threads`
   * rows (title/preview/cwd written through by past turns), joining each
   * session's persisted settings (permissionMode/model/effort/fastMode) from
   * the core settings store (ADR-0260) where available.
   *
   * Idempotent: {@link CodexSessionRegistry.hydrate} inserts only untracked
   * ids, so fresher in-memory state is never clobbered and repeat calls are
   * no-ops. The composition root calls this fire-and-forget after
   * `setSessionSettings` — restart survival must not delay server listen, and
   * the registry's per-session upserts let live list subscribers self-heal
   * even when hydration completes after the broadcaster subscribed. Sessions
   * touched before this completes are seeded on demand from their own durable
   * row ({@link CodexRuntime.seedFromDurable}), so the boot-time window never
   * mints a fresh entry that would make this hydrate skip the persisted one.
   */
  async hydrateSessions(): Promise<void> {
    return originalCodexQueries.queryHydrateSessions(this.#queryKey);
  }

  /**
   * Project a durable `codex_threads` row into its display-only Session shape
   * (persisted title/timestamps/preview/cwd, default settings). The settings
   * join lives one level up in {@link CodexRuntime.buildDurableSession}; sync
   * seeding paths use this shape directly.
   */
  private toDurableDisplaySession(record: CodexThreadRecord): Session {
    return originalCodexQueries.queryToDurableDisplaySession(this.#queryKey, record);
  }

  /**
   * A durable row's full hydration shape: the display session plus the
   * session's persisted settings (permissionMode/model/effort/fastMode)
   * joined from the core settings store (ADR-0260) where available.
   */
  private async buildDurableSession(record: CodexThreadRecord): Promise<Session> {
    return originalCodexQueries.queryBuildDurableSession(this.#queryKey, record);
  }

  /**
   * Insert-if-absent seed of ONE session from its durable `codex_threads` row
   * (display metadata + persisted settings). Closes the boot-time race where
   * a session touched before {@link CodexRuntime.hydrateSessions} completes
   * would be created fresh in memory (blank title, fresh createdAt, no cwd),
   * causing the insert-only hydrate to skip (and permanently lose) the
   * durable title/cwd/createdAt. Idempotent and concurrency-safe: hydrate is
   * insert-only, so a racing seed or the startup hydration never overwrites
   * fresher in-memory state.
   */
  private async seedFromDurable(sessionId: string): Promise<void> {
    return originalCodexQueries.querySeedFromDurable(this.#queryKey, sessionId);
  }

  /**
   * Sync display-only variant of {@link CodexRuntime.seedFromDurable} for the
   * sync `ensureSession` path, whose settings arrive from the caller's own
   * opts via the `register()` that follows (exactly as before this fix: no
   * persisted-settings join ever existed on that path).
   */
  private seedDisplayFromDurable(sessionId: string): void {
    return originalCodexQueries.querySeedDisplayFromDurable(this.#queryKey, sessionId);
  }

  /** Bind only a verified imported thread; no SDK resume or model turn is started. */
  private async importNativeThread(
    sessionId: string,
    isCurrent: () => boolean = () => true
  ): Promise<void> {
    return originalCodexQueries.queryImportNativeThread(this.#queryKey, sessionId, isCurrent);
  }

  // --- Messaging ---

  /**
   * @inheritdoc
   *
   * Resolves the thread (resume when bound, start otherwise), runs one
   * `codex exec` turn, and yields the mapped StreamEvents. The event mapper
   * guarantees exactly one terminal `done` on every path — completion,
   * failure, abort (a fired `TurnOptions.signal` makes the SDK generator
   * throw AbortError, normalized to a quiet `done`), and crash — so no
   * additional done-guard is layered here.
   */
  sendMessage(sessionId: string, content: string, opts?: MessageOpts): AsyncGenerator<StreamEvent> {
    return this.#createMessage(sessionId, content, opts);
  }

  private runTurn(
    sessionId: string,
    content: string,
    opts: MessageOpts | undefined,
    origin: 'dispatched' | 'runtime',
    inherited?: CodexWakeContext,
    acquisition?: NativeSessionAcquisition
  ): AsyncGenerator<StreamEvent> {
    return this.#createMessage(
      sessionId,
      content,
      opts,
      origin === 'runtime' ? acquisition : undefined,
      undefined,
      undefined,
      origin,
      inherited
    );
  }

  #createMessage(
    sessionId: string,
    content: string,
    opts: MessageOpts | undefined,
    acquisition?: NativeSessionAcquisition,
    roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>,
    roomPrepared?: CodexPreparedRoomContinuation,
    origin: 'dispatched' | 'runtime' = 'dispatched',
    inherited?: CodexWakeContext
  ): AsyncGenerator<StreamEvent> {
    return originalCodexNativeContinuations.createMessage(
      this.#nativeContinuationKey,
      sessionId,
      content,
      opts,
      acquisition,
      roomOrigin,
      roomPrepared,
      origin,
      inherited
    );
  }

  #installNativeTurn(
    sessionId: string,
    cwd: string,
    agentPath: string | undefined,
    controller: AbortController,
    acquisition?: NativeSessionAcquisition,
    refuseExisting = false,
    roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>
  ) {
    return originalCodexNativeContinuations.installNativeTurn(
      this.#nativeContinuationKey,
      sessionId,
      cwd,
      agentPath,
      controller,
      acquisition,
      refuseExisting,
      roomOrigin
    );
  }

  async #prepareRoomResponder(
    source: OriginalFrozenRoomSource,
    target: Readonly<{ sessionId: string; agentPath: string; agentId: string }>,
    acquisition: NativeSessionAcquisition
  ): Promise<PreparedRoomResponder | undefined> {
    return originalCodexNativeContinuations.prepareRoomResponder(
      this.#nativeContinuationKey,
      source,
      target,
      acquisition
    );
  }

  async *#sendOwnedMessage(
    sessionId: string,
    content: string,
    opts: MessageOpts | undefined,
    lifetime: {
      closed: boolean;
      entered: boolean;
      retire?: () => void;
      acquisition?: NativeSessionAcquisition;
      roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>;
      roomPrepared?: CodexPreparedRoomContinuation;
    },
    origin: 'dispatched' | 'runtime',
    inherited?: CodexWakeContext
  ): AsyncGenerator<StreamEvent> {
    yield* originalCodexOwnedMessages.sendOriginalOwnedMessage(
      this.#ownedMessageKey,
      sessionId,
      content,
      opts,
      lifetime,
      origin,
      inherited
    );
  }

  /**
   * @inheritdoc
   *
   * Summarizes the session's thread with `thread/compact/start`, which Codex
   * runs as a turn of its own. Only the app-server transport can ask for one
   * (`codex exec` only runs prompts), so on exec
   * {@link CODEX_CAPABILITIES} keeps `commandIntents.compact` false, the
   * route and the agent's tool list never reach this, and it throws as the
   * defensive contract.
   *
   * It is tracked as an open turn ({@link isTurnOpen}, a stop, the stall
   * watchdog) exactly like a prompt. `opts.instructions` is ignored: Codex's
   * compaction takes none, the same honest difference OpenCode has. Who pays
   * is decided as for any turn on the thread: a credits thread is summarized
   * on credits, and refused when credits cannot pay. A summary Codex
   * finished re-anchors the thread's DorkOS context on its next turn.
   */
  async *executeCommandIntent(
    sessionId: string,
    _intent: RuntimeCommandIntentId,
    opts?: CommandIntentOpts
  ): AsyncGenerator<StreamEvent> {
    yield* originalCodexCommandIntents.executeOriginalCommandIntent(
      this.#commandIntentKey,
      sessionId,
      _intent,
      opts
    );
  }

  /**
   * Effective settings for one turn: per-send override → tracked session →
   * persisted store (hydrated once for untracked sessions, e.g. resume after
   * a server restart) → runtime default.
   */
  private async resolveTurnSettings(
    sessionId: string,
    opts?: MessageOpts
  ): Promise<SessionSettings> {
    return originalCodexQueries.queryResolveTurnSettings(this.#queryKey, sessionId, opts);
  }

  /**
   * Project a tracked session's display metadata into the thread map's patch
   * shape. An unset title (the registry's `''` default) is omitted so a blank
   * never overwrites a previously persisted title (or lands as `''` in a
   * fresh row — NULL hydrates back to the same blank default).
   */
  private toMetadataPatch(session: Session): CodexThreadMetadataPatch {
    return originalCodexQueries.queryToMetadataPatch(this.#queryKey, session);
  }

  /**
   * Write the registry's current title/updatedAt/preview through to the
   * session's durable `codex_threads` row. A no-op until `thread.started`
   * binds the row. Failures are logged, never thrown — durable metadata is
   * best-effort and the in-memory registry already holds the fresh state.
   */
  private persistSessionMetadata(sessionId: string): void {
    return originalCodexQueries.queryPersistSessionMetadata(this.#queryKey, sessionId);
  }

  // --- Interactive flows (app-server only — spec §10; exec: NOTES.md Verdict 1) ---

  /**
   * @inheritdoc
   *
   * On app-server, answers the approval Codex is waiting on and resolves the
   * projector's card, so every window drops it through the same seq'd stream.
   * On exec there is no approval channel, so nothing can be pending and the
   * answer is `false` (the approval UI is gated off by `supportsToolApproval`).
   * Codex's decisions carry no reason text, so a `denyReason` is not carried
   * (`permissionModes.denyReason: false` hides the box).
   */
  approveTool(
    sessionId: string,
    toolCallId: string,
    approved: boolean,
    opts?: ToolDecisionOptions
  ): boolean {
    if (
      !this.#transport.answerApproval?.(sessionId, toolCallId, approved, opts?.alwaysAllow === true)
    ) {
      return false;
    }
    peekProjector(sessionId)?.resolveInteraction(toolCallId, approved ? 'approved' : 'denied', {
      ...(opts?.answeredBy ? { answeredBy: opts.answeredBy } : {}),
    });
    return true;
  }

  /** @inheritdoc */
  submitAnswers(
    sessionId: string,
    toolCallId: string,
    answers: Record<string, string>,
    opts?: InteractionAnswerOptions
  ): boolean {
    if (!this.#transport.answerQuestion?.(sessionId, toolCallId, answers)) return false;
    peekProjector(sessionId)?.resolveInteraction(toolCallId, 'answered', {
      ...(opts?.answeredBy ? { answeredBy: opts.answeredBy } : {}),
    });
    return true;
  }

  /** @inheritdoc */
  submitElicitation(
    sessionId: string,
    interactionId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>,
    opts?: InteractionAnswerOptions
  ): boolean {
    if (!this.#transport.answerElicitation?.(sessionId, interactionId, action, content)) {
      return false;
    }
    peekProjector(sessionId)?.resolveInteraction(
      interactionId,
      action === 'accept' ? 'answered' : 'denied',
      { ...(opts?.answeredBy ? { answeredBy: opts.answeredBy } : {}) }
    );
    return true;
  }

  /**
   * @inheritdoc
   *
   * On app-server a background command or helper agent that outlived its turn
   * (spec §12). On exec nothing outlives the turn, so there is nothing to stop.
   */
  async stopTask(sessionId: string, taskId: string): Promise<InterruptReceipt> {
    if (this.#transport.stopTask) return this.#transport.stopTask(sessionId, taskId);
    return { outcome: 'not-running', reason: 'no-open-turn', runtime: this.type };
  }

  /**
   * @inheritdoc
   *
   * Aborts the in-flight turn's AbortController and revokes its connector
   * binding, then asks the transport what that did. On exec the abort SIGTERMs
   * the per-turn `codex exec` subprocess and the receipt is `closed` (nothing
   * acknowledges a stop; spec `runtime-interrupt-receipts` D7). On app-server
   * the abort sends `turn/interrupt` and the receipt is `acked` when Codex
   * wound the turn down within the shared bound, `unconfirmed` when it did not.
   */
  async interruptQuery(sessionId: string): Promise<InterruptReceipt> {
    const controller = this.activeTurns.get(sessionId);
    if (controller) {
      const operation = codexNativeControllers.get(controller);
      if (operation) operation.retired = true;
    }
    if (!controller) return { outcome: 'not-running', reason: 'no-open-turn', runtime: this.type };
    this.activeTurns.delete(sessionId);
    const connectorBindingId = this.activeConnectorBindings.get(controller);
    this.activeConnectorBindings.delete(controller);
    controller.abort();
    if (connectorBindingId) {
      try {
        await this.connectorRuntimeTools?.principals.revoke(connectorBindingId, 'turn_cancelled');
      } catch (err) {
        logger.warn('[CodexRuntime] failed to persist interrupted connector binding revoke', {
          sessionId,
          err,
        });
      }
    }
    logger.debug('[CodexRuntime] interrupted in-flight turn', { sessionId });
    return this.#transport.interrupt(sessionId);
  }

  // --- Session queries (storage) ---

  /** Settings and ensureSession metadata alone never prove native existence. */
  private hasThreadProof(sessionId: string): boolean {
    return originalCodexQueries.queryHasThreadProof(this.#queryKey, sessionId);
  }

  /** Preserve native identity, directory and account while overlaying launch settings. */
  private withNativeSettings(native: Session): Session {
    return originalCodexQueries.queryWithNativeSettings(this.#queryKey, native);
  }

  /** Display edits stay durable; native directory and account remain authoritative. */
  private withNativeIdentity(tracked: Session, native: Session): Session {
    return originalCodexQueries.queryWithNativeIdentity(this.#queryKey, tracked, native);
  }

  async listSessions(projectDir: string): Promise<Session[]> {
    return originalCodexQueries.queryListSessions(this.#queryKey, projectDir);
  }

  async getSession(_projectDir: string, sessionId: string): Promise<Session | null> {
    return originalCodexQueries.queryGetSession(this.#queryKey, _projectDir, sessionId);
  }

  async findSession(sessionId: string): Promise<Session | null> {
    return originalCodexQueries.queryFindSession(this.#queryKey, sessionId);
  }

  /**
   * DorkOS-created threads retain their durable event history. Imported native
   * threads read their own transcript so turns made outside DorkOS survive.
   * Never concatenate these stores: Codex records DorkOS turns there too.
   */
  async getMessageHistory(_projectDir: string, sessionId: string): Promise<HistoryMessage[]> {
    return originalCodexQueries.queryGetMessageHistory(this.#queryKey, _projectDir, sessionId);
  }

  /** Completed history comes from the owning store; live state/cursors remain projector-owned. */
  async getSessionSnapshot(ctx: SessionOpts, sessionId: string): Promise<SessionSnapshot> {
    return originalCodexQueries.queryGetSessionSnapshot(this.#queryKey, ctx, sessionId);
  }

  /**
   * @inheritdoc
   *
   * Delegates to the projector's resumable seq'd stream — the SAME projector
   * the trigger path feeds, so `/events` serves a Codex turn through exactly
   * the code path the Claude adapter uses.
   */
  subscribeSession(
    ctx: SessionOpts,
    sessionId: string,
    sinceCursor?: number,
    signal?: AbortSignal
  ): AsyncIterable<SessionEvent> {
    return originalCodexQueries.querySubscribeSession(
      this.#queryKey,
      ctx,
      sessionId,
      sinceCursor,
      signal
    );
  }

  /**
   * @inheritdoc
   *
   * The registry answers directly here: Codex keys its projectors by the
   * DorkOS session id and holds no second id to resolve through, so this reads
   * the same entry {@link subscribeSession} binds to. Peek-only — asking which
   * counter serves a session must not mint one, and the fresh projector a
   * subsequent subscribe would mint refuses every cursor above 0 anyway.
   */
  streamGeneration(_ctx: SessionOpts, sessionId: string): string {
    return originalCodexQueries.queryStreamGeneration(this.#queryKey, _ctx, sessionId);
  }

  /**
   * @inheritdoc
   *
   * Emits the tracked-session inventory then live upserts. Discovery is
   * bounded by what this server observed (the SDK exposes no thread listing);
   * `session_status` liveness fans out runtime-neutrally from the projector
   * via the session-list broadcaster, same as every runtime.
   */
  subscribeSessionList(_ctx: SessionOpts): AsyncIterable<SessionListEvent> {
    return originalCodexQueries.querySubscribeSessionList(this.#queryKey, _ctx);
  }

  /** Todo state streams live as task_update events; Codex persists no task store. */
  async getSessionTasks(): Promise<TaskItem[]> {
    return [];
  }

  async getSessionETag(): Promise<string | null> {
    return null;
  }

  async getLastMessageIds(): Promise<{ user: string; assistant: string } | null> {
    return null;
  }

  /** No byte-addressable transcript exists — rollout files are SDK-internal. */
  async readFromOffset(): Promise<{ content: string; newOffset: number }> {
    return { content: '', newOffset: 0 };
  }

  // --- Session locking ---

  acquireLock(sessionId: string, clientId: string, res: SseResponse, token?: symbol): boolean {
    return this.locks.acquireLock(sessionId, clientId, res, token);
  }

  releaseLock(sessionId: string, clientId: string, token?: symbol): void {
    const own = this.#runtimeWakeAcquisitions.get(sessionId);
    this.locks.releaseLock(sessionId, clientId, token);
    if (
      own &&
      this.#runtimeWakeAcquisitions.get(sessionId) === own &&
      captureNativeSessionAcquisition(own.manager, sessionId, own.holder) !== own.acquisition
    ) {
      requireOriginalNativeSessionAcquisitionRetired(own.manager, own.acquisition, own.holder);
      this.#runtimeWakeAcquisitions.delete(sessionId);
    }
  }

  isLocked(sessionId: string, clientId?: string): boolean {
    return this.locks.isLocked(sessionId, clientId);
  }

  getLockInfo(sessionId: string): { clientId: string; acquiredAt: number } | null {
    return this.locks.getLockInfo(sessionId);
  }

  // --- Capabilities ---

  async getSupportedModels(): Promise<ModelOption[]> {
    return originalCodexDiscovery.discoverGetSupportedModels(this.#discoveryKey);
  }

  /** Codex exposes no subagent registry. */
  async getSupportedSubagents(): Promise<SubagentInfo[]> {
    return originalCodexDiscovery.discoverGetSupportedSubagents(this.#discoveryKey);
  }

  /**
   * @inheritdoc
   *
   * `mediaOutput` is resolved per INSTANCE rather than baked into
   * {@link CODEX_CAPABILITIES}, because it is the one capability here that
   * depends on how the runtime was wired: with no attachment store there is
   * nowhere to put an image, and claiming otherwise would be exactly the silent
   * promise this field exists to end. Same arrangement as the OpenCode adapter.
   */
  getCapabilities(): RuntimeCapabilities {
    return originalCodexDiscovery.discoverGetCapabilities(this.#discoveryKey);
  }

  async checkDependencies(): Promise<DependencyCheck[]> {
    return originalCodexDiscovery.discoverCheckDependencies(this.#discoveryKey);
  }

  // --- Commands ---

  /**
   * @inheritdoc
   *
   * Codex's built-in TUI commands can't run under `codex exec` and the SDK has
   * no command-discovery API, so instead of faking them this surfaces every
   * skill Codex itself can see in `<cwd>/.agents/skills` — authored dirs,
   * linked-in sources, and the `<pkg>__<name>` projections of installed plugins
   * alike — as `/<name>` slash commands, the same skills Claude's SDK exposes
   * from `.claude/skills`. With no `cwd` (cold discovery, no session context)
   * there is no project to scan, so the palette is empty.
   */
  async getCommands(_forceRefresh?: boolean, cwd?: string): Promise<CommandRegistry> {
    return originalCodexDiscovery.discoverGetCommands(this.#discoveryKey, _forceRefresh, cwd);
  }

  // --- MCP ---

  /**
   * @inheritdoc
   *
   * Surfaces the MCP servers Codex loads from its own config
   * (`$CODEX_HOME/config.toml`), enumerated via `codex mcp list --json`. The
   * interface is synchronous, so the async CLI probe warms {@link mcpStatusCache}
   * out-of-band and this returns the last-known list (`null` until the first
   * successful enumeration — "not yet available"). Codex sessions pre-warm the
   * cache on {@link ensureSession}, so it is usually populated by the first call.
   * A stale cache (older than {@link MCP_STATUS_TTL_MS}) triggers a background
   * re-warm and returns the current value immediately. `cwd` is ignored: Codex
   * MCP config is user-global, not per-project.
   */
  getMcpStatus(_cwd: string): McpServerEntry[] | null {
    return originalCodexDiscovery.discoverGetMcpStatus(this.#discoveryKey, _cwd);
  }

  /**
   * Whether a turn in this directory would carry the DorkOS room tools (spec
   * `tool-only-room-replies` §D2).
   *
   * **It asks the question the exact way the injection site asks it**, and the
   * `meshCore` hop is the part that has to match rather than merely resemble.
   * `sendMessage` gates on `meshAgent ? agentPath : undefined`, so a directory that
   * hosts no registered agent — an absent registry, or a `getByPath` miss —
   * withholds the entry. Handing this a bare `cwd` string instead made the
   * `'no-agent'` answer structurally unreachable from here: the posture said
   * `wired: true` for a session the runtime was about to leave with no tools,
   * the room read that as tool-capable, and the agent went MUTE — no post, no
   * `<room_tools>` block, and nothing on the log saying why. Two readings of one
   * gate is exactly the drift `dorkosToolsPosture` was extracted to prevent, and
   * this caller had quietly reintroduced it.
   *
   * Two residuals remain, and both cost an ANSWER rather than a tidy room — so
   * neither is comfortable, and both are named rather than smoothed over. A mint
   * that fails withholds the entry and this cannot see it (see
   * {@link dorkosToolsPosture}); and a user's own MCP server named `dorkos` is
   * refused rather than shadowed, which `reservedNames` handles at build time
   * and this reports as capable. In both, a room that suppressed the turn's text
   * on the strength of this answer leaves the agent silent. They are rare and
   * both are logged where they happen, which is the honest state of it rather
   * than a claim that they are harmless.
   *
   * @param session.cwd - The session's working directory.
   * @param session.agentPath - The agent a room turn is for, when a room asks;
   *   the same cross-check `sendMessage` applies (DOR-2091).
   * @returns Whether the `dorkos` entry is configured for it.
   */
  async carriesRoomTools(session: { cwd: string; agentPath?: string }): Promise<boolean> {
    return originalCodexDiscovery.discoverCarriesRoomTools(this.#discoveryKey, session);
  }

  /**
   * The directory whose identity a turn standing in `cwd` carries, or
   * `undefined` when it carries none (DOR-2091).
   *
   * One helper for {@link sendMessage} and {@link carriesRoomTools}, so the
   * posture this reports and the injection the turn makes read one answer.
   *
   * @param cwd - Where the turn stands.
   * @param forAgent - The agent a room turn is for, when a room dispatched it.
   */
  private identityPathFor(cwd: string, forAgent: string | undefined): AgentHome | undefined {
    return originalCodexDiscovery.discoverIdentityPathFor(this.#discoveryKey, cwd, forAgent);
  }

  /**
   * Kick a background MCP-status warm when one is warranted: never warmed yet,
   * or last warmed longer than {@link MCP_STATUS_TTL_MS} ago. A warm already in
   * flight ({@link mcpWarmPromise}) dedupes so at most one `codex mcp list`
   * probe runs at a time. Fire-and-forget — callers stay synchronous and read
   * the last-known cache.
   */
  private maybeWarmMcpStatus(): void {
    return originalCodexDiscovery.discoverMaybeWarmMcpStatus(this.#discoveryKey);
  }

  /**
   * Warm {@link mcpStatusCache} from `codex mcp list --json`. A genuine
   * enumeration failure (returns `null`) leaves the cache cold and unstamped so
   * the next `getMcpStatus` retries immediately; success (including an empty
   * list) caches the result and stamps {@link mcpStatusWarmedAt} to start the TTL.
   */
  private async warmMcpStatus(): Promise<void> {
    return originalCodexDiscovery.discoverWarmMcpStatus(this.#discoveryKey);
  }

  // --- Lifecycle ---

  /**
   * No-op: nothing per session is evicted here. On exec each turn is a fresh
   * subprocess; on app-server the process pool reaps idle processes itself.
   */
  checkSessionHealth(): void {}

  /**
   * Always `undefined`: the DorkOS session id IS the canonical id for Codex
   * sessions (the thread map keeps the SDK thread id adapter-internal,
   * ADR-0309). Returning the thread id here would trip trigger-turn's C1
   * rekey and re-key the projector — and the 202's canonical id — to the
   * Codex thread id, orphaning the client's subscription.
   */
  getInternalSessionId(_sessionId: string): string | undefined {
    return undefined;
  }

  /**
   * @inheritdoc
   *
   * The rollout's last `token_count` record, found through the session's bound
   * thread id with the same bounded tail read a finished turn uses. `null` for
   * a session that never started a thread.
   */
  async readContextUsage(
    sessionId: string,
    _cwd: string | undefined
  ): Promise<{ contextTokens: number; contextMaxTokens: number } | null> {
    return originalCodexDiscovery.discoverReadContextUsage(this.#discoveryKey, sessionId, _cwd);
  }

  // --- Dependency injection ---

  /** Inject the core session-settings store for durable hydrate/write-through (ADR-0260). */
  setSessionSettings(port: SessionSettingsPort): void {
    this.settingsPort = port;
  }
}
