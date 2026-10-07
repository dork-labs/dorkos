import { captureTurnLevelOptions } from '../../core/turn-power/turn-levels.js';
import {
  readOriginalRegisteredNativeStream,
  readOriginalRegisteredRuntime,
} from '../../core/runtime-registry.js';
const originalCodexLockedStreams = new WeakMap<
  object,
  { runtime: object; sessionId: string; options: Readonly<MessageOpts>; current(): boolean }
>();
/** Fixed constructor-created stream identity plus the original live acquisition; never a supplied stream matcher. */
export function readCodexOriginalLockedStream(
  runtime: object,
  sessionId: string,
  stream: object
): boolean {
  const own = originalCodexLockedStreams.get(stream);
  return !!own && own.runtime === runtime && own.sessionId === sessionId && own.current();
}
/** Exact original opened turn DATA; a supplied observer cannot replace these options. */
export function readCodexOriginalLockedTurnOptions(
  runtime: object,
  sessionId: string,
  stream: object
) {
  const own = originalCodexLockedStreams.get(stream);
  return own && own.runtime === runtime && own.sessionId === sessionId && own.current()
    ? { options: own.options }
    : undefined;
}
import { isNonFatalErrorCode, isAbsolvingTerminalReason } from '@dorkos/shared/run-outcome';
import { isInterruptedTerminalReason } from '@dorkos/shared/schemas';
const originalCodexRoomStreams = new WeakMap<
  object,
  {
    runtime: object;
    prepared: PreparedRoomResponder;
    operation: object;
    committed: OriginalCommittedRoomResponder;
    emitted: WeakSet<object>;
    close(): Promise<IteratorResult<StreamEvent, void>>;
    reason?: string;
    failed: boolean;
    done: boolean;
  }
>();
/** Retire the original Codex Room responder stream and its captured lifecycle. */
export async function retireCodexOriginalRoomResponderStream(stream: object): Promise<void> {
  const own = originalCodexRoomStreams.get(stream);
  if (!own) return;
  originalCodexRoomStreams.delete(stream);
  let failed = false,
    first: unknown;
  try {
    retireOriginalCommittedRoomResponder(own.committed, own.runtime, own.prepared, own.operation);
  } catch (cause) {
    failed = true;
    first = cause;
  }
  try {
    await own.close();
  } catch (cause) {
    if (!failed) {
      failed = true;
      first = cause;
    }
  }
  if (failed) throw first;
}
/** Read evidence from the original Codex Room responder stream. */
export function readCodexOriginalRoomResponderStream(
  runtime: object | undefined,
  stream: object,
  event?: StreamEvent
) {
  stream = readOriginalRegisteredNativeStream(stream) ?? stream;
  if (runtime) runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;

  const own = originalCodexRoomStreams.get(stream);
  if (!own) return undefined;
  if (
    (runtime !== undefined && own.runtime !== runtime) ||
    readCodexPreparedRoomResponder(own.runtime, own.prepared)?.nativeOperation !== own.operation ||
    (event !== undefined && !own.emitted.has(event))
  )
    throw new Error('Original Room stream retired or changed.');
  return Object.freeze({
    runtime: own.runtime,
    prepared: own.prepared,
    operation: own.operation,
    committed: own.committed,
    outcome: own.done
      ? own.reason === 'error' || (own.failed && !isAbsolvingTerminalReason(own.reason))
        ? ('failed' as const)
        : isInterruptedTerminalReason(own.reason)
          ? ('cancelled' as const)
          : ('turn_done' as const)
      : undefined,
  });
}
import {
  consumeOriginalCommittedRoomResponder,
  retireOriginalCommittedRoomResponder,
  requireOriginalCommittedRoomResponder,
  requireCurrentOriginalCommittedRoomResponder,
} from '../../canvas/doc-channel/operations/room-current-operation.js';
import type { OriginalCommittedRoomResponder } from '../../canvas/doc-channel/current/current-operation-types.js';
import {
  captureOriginalRoomDispatchLifecycle,
  readOriginalRoomDispatchLifecycle,
} from '../../session/trigger-turn.js';
import type { OriginalRoomDispatchCustody } from '../../rooms/service/room-core.js';
import {
  readOriginalFrozenRoomTarget,
  requireOriginalRoomPrincipalService,
} from '../../canvas/doc-channel/operations/room-current-operation.js';
import type {
  OriginalFrozenRoomSource,
  PreparedRoomResponder,
} from '../../canvas/doc-channel/current/current-operation-types.js';
import { openOriginalNativeTurn } from '../../connectors/principal/runtime-principal-service.js';
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
 * DorkOS-owned EventLog. Session discovery comes from the in-memory
 * {@link CodexSessionRegistry}, and restart survival comes from DorkOS itself:
 * display metadata (title/preview/updatedAt) is written through to the
 * `codex_threads` rows alongside the durable sessionId↔threadId binding, and
 * {@link CodexRuntime.hydrateSessions} re-seeds the registry from those rows at
 * startup. Sessions that never bound a thread have no durable row and are not
 * rediscovered. The same boundary applies to writes: a rename issued before
 * the session's first turn lives in memory only until the binding lands (the
 * bind then carries the renamed title with it).
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
import {
  getOrCreateProjector,
  peekProjector,
  streamGenerationOf,
} from '../../session/session-state-projector.js';
import { reconstructHistoryFromEvents } from '../../session/event-log-history.js';
import { readLogBackedHistory } from '../../session/log-backed-history.js';
import {
  SessionLockManager,
  runtimeLockHolder,
  captureNativeSessionAcquisition,
  captureNativeSessionActivity,
  readNativeSessionAcquisition,
  requireOriginalNativeSessionAcquisitionRetired,
  type NativeSessionAcquisition,
} from '../../session/session-lock.js';
import { logger } from '../../../lib/logger.js';
import { DEFAULT_CWD } from '../../../lib/resolve-root.js';
import { buildAgentContextAppend } from '../shared/agent-context.js';
import {
  homeOf,
  resolveAgentTokenEnv,
  resolveAgentHome,
  turnAgentOf,
  type AgentHome,
} from '../../core/agent-identity/index.js';
import {
  checkCodexDependencies,
  codexAppServerVersionNote,
  resolveCodexBinaryPath,
} from './check-dependencies.js';
import { codexAppServerPool } from './app-server/process-pool.js';
import { PINNED_CODEX_APP_SERVER_VERSION } from './app-server/protocol/methods.js';
import { createCodexEventContext } from './event-mapper.js';
import { readCodexTurnContextUsage, readCodexTurnReading } from './turn-context-usage.js';
import { ensureCreditsCodexHome, threadRunsOnCredits } from './credits-launch.js';
import { creditsCodexHome } from './codex-home.js';
import { resolveCreditsLaunch } from '../../core/cloud/credits-inference.js';
import {
  catalogNameFor,
  decideCreditsLaunchModel,
  type CreditsModelDecision,
} from '../../core/cloud/credits-models.js';
import {
  asCreditsStopped,
  creditsRefusalEvent,
  type CreditsLaunch,
} from '../../core/cloud/credits-protocols.js';
import { creditsIsDefaultFor } from '../../core/cloud/credits-defaults.js';
import { captureCodexMedia } from './media-capture.js';
import type { SessionAttachmentStore } from '../../session/attachments/index.js';
import { CodexSessionRegistry } from './session-registry.js';
import {
  CodexThreadMap,
  type CodexThreadMetadataPatch,
  type CodexThreadRecord,
} from './thread-map.js';
import { clampModeToCeiling, tightensDeclaredMode } from '@dorkos/shared/permission-semantics';
import { CODEX_CAPABILITIES } from './runtime-constants.js';
import {
  ExecCodexTransport,
  createAppServerTransport,
  type CodexTransport,
  type CodexTransportKind,
} from './transport/index.js';
import { backgroundDoneEvent, nothingToSummarize } from './transport/app-server-transport.js';
import {
  buildBackgroundUpdate,
  type BackgroundCompletion,
  type BackgroundWake,
} from './app-server/background-work.js';
import type { CreditsRelay } from '../../core/cloud/credits-relay.js';
import { CodexModelCatalog } from './model-catalog.js';
import { dorkosToolsPosture, resolveDorkosMcpInjection } from '../shared/dorkos-mcp-injection.js';
import { CODEX_DORKOS_TOOL_PREFIX } from '../shared/dorkos-tool-names.js';
import { buildRoomToolsBlock } from '../shared/room-tools-context.js';
import {
  renderBlockedAreaLines,
  resolveToolVisibilityFor,
} from '../shared/permission-tool-filter.js';
import { resolveManagedMcpServers } from './mcp-server-config.js';
import { buildCodexPrompt, grantedWritableDirectories } from './turn-input.js';
import { CodexContextGate } from './context-gate.js';
import { enumerateCodexMcpServers } from './enumerate-mcp-servers.js';
import { scanSkillCommands } from './scan-skill-commands.js';
import {
  connectorRuntimeHeaders,
  type ConnectorRuntimeMcpInjection,
  type ConnectorRuntimeTools,
} from '../connector-tools.js';
import type {
  OpenConnectorTurnResult,
  RevokeConnectorTurnReason,
} from '../../connectors/runtime-principal-port.js';
import {
  ConnectorTurnLeaseSupervisor,
  type ConnectorTurnLeaseSupervisorHandle,
} from '../connectors/connector-turn-lease-supervisor.js';

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

/** Constructor dependencies for {@link CodexRuntime} (composition root). */
export interface CodexRuntimeOptions {
  /** Durable sessionId ↔ threadId binding (backed by the `codex_threads` table). */
  threadMap: CodexThreadMap;
  /**
   * How this runtime finds its `codex` binary. Defaults to the shared ladder
   * ({@link resolveCodexBinaryPath}: configured `binaryPath` → SDK-vendored →
   * provisioned → `PATH`), which is the SAME resolution the dependency check
   * reports on, so the status card and the turn can never disagree. Injectable
   * for tests; production passes nothing.
   */
  resolveBinary?: () => Promise<string | null>;
  /** Account-aware model catalog; injectable so runtime tests never spawn app-server. */
  modelCatalog?: Pick<CodexModelCatalog, 'getSupportedModels'>;
  /**
   * Fallback working directory for a turn that arrives with no cwd from any
   * source (send opts, registry, persisted binding) — mirrors the Claude
   * adapter's default. Guarantees every bound thread persists a real cwd, so
   * a `codex_threads` row can never be minted cwd-less (DOR-202). Defaults to
   * the server's resolved workspace root.
   */
  defaultCwd?: string;
  /**
   * Where images this runtime's turns produce are stored (the local store over
   * the resolved data directory in production). Omitted, the runtime declares
   * `mediaOutput: 'none'` and says so per image rather than dropping one
   * quietly — see {@link CodexRuntime.getCapabilities}.
   */
  attachments?: SessionAttachmentStore;
  /**
   * How this runtime talks to Codex (`runtimes.codex.transport`, already
   * resolved — `resolveCodexTransport`), or a ready transport (tests). Fixed
   * for the runtime's life: capabilities are cached by clients, so a change
   * takes effect at the next server start. Required, so no caller can fall
   * back to a transport the product does not default to.
   */
  transport: CodexTransportKind | CodexTransport;
  /**
   * The loopback credits relay, when boot started one. Only the app-server
   * transport uses it: a credits thread's provider points at the relay, so the
   * credits token never enters Codex's process.
   */
  creditsRelay?: () => CreditsRelay | undefined;
}

/**
 * Codex runtime implementing the universal AgentRuntime interface.
 */
const nativeMapGet = Map.prototype.get;
const nativeMapSet = Map.prototype.set;
const nativeSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
type CodexNativeEntry = {
  roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>;
  acquisition?: NativeSessionAcquisition;
  instance: object;
  active: Map<string, AbortController>;
  key: string;
  entry: AbortController;
  signal: AbortSignal;
  retired: boolean;
  runtime: 'codex';
  agentPath: string | undefined;
  cwd: string;
};
const codexLockedRunners = new WeakMap<
  object,
  (
    sessionId: string,
    content: string,
    opts: MessageOpts | undefined,
    holder: SseResponse,
    lockKey: string
  ) => AsyncGenerator<StreamEvent>
>();
/** Original constructor-owned turn entry. A holder selects data; it cannot issue lock/principal authority. */
export function sendCodexOriginalLockedMessage(
  runtime: object,
  sessionId: string,
  content: string,
  opts: MessageOpts | undefined,
  holder: SseResponse,
  lockKey: string
): AsyncGenerator<StreamEvent> | undefined {
  return codexLockedRunners.get(runtime)?.(sessionId, content, opts, holder, lockKey);
}
const codexRoomPreparers = new WeakMap<
  object,
  (
    source: OriginalFrozenRoomSource,
    holder: SseResponse,
    key: string
  ) => Promise<PreparedRoomResponder | undefined>
>();
type CodexPreparedRoomContinuation = {
  prepared: PreparedRoomResponder;
  committed: OriginalCommittedRoomResponder;
  controller: AbortController;
  nativeOperation: object;
  nativeEntry: CodexNativeEntry;
  binding: OpenConnectorTurnResult;
  retire: () => Promise<void>;
};
const codexRoomPrepared = new WeakMap<
  PreparedRoomResponder,
  {
    runtime: object;
    retire: () => Promise<void>;
    source: OriginalFrozenRoomSource;
    nativeOperation: object;
    acquisition: NativeSessionAcquisition;
    start: (committed: OriginalCommittedRoomResponder) => AsyncGenerator<StreamEvent>;
  }
>();
/** Genuine constructor preparation only; no generator pull or model invocation. */
export function prepareCodexOriginalLockedRoomResponder(
  runtime: object,
  holder: SseResponse,
  key: string,
  source: OriginalFrozenRoomSource
): Promise<PreparedRoomResponder | undefined> {
  const prepare = codexRoomPreparers.get(runtime);
  if (!prepare) return Promise.resolve(undefined);
  return prepare(source, holder, key);
}
/** Retire this exact prepared entry before awaited revocation; never selects a successor by key. */
export function retireCodexPreparedRoomResponder(
  runtime: object,
  prepared: PreparedRoomResponder
): Promise<void> {
  const own = codexRoomPrepared.get(prepared);
  if (!own || own.runtime !== runtime)
    throw new Error('Room responder preparation is not original.');
  codexRoomPrepared.delete(prepared);
  return own.retire();
}
/** Fixed lookup of one genuinely constructor-prepared entry; returned identities never register authority. */
export function readCodexPreparedRoomResponder(runtime: object, prepared: PreparedRoomResponder) {
  const own = codexRoomPrepared.get(prepared);
  if (!own || own.runtime !== runtime) return undefined;
  const at = Date.now(),
    activity = captureNativeSessionActivity(own.acquisition, at);
  const native = readCodexNativeOperation(own.nativeOperation);
  if (
    !activity ||
    !native ||
    native.acquisition !== own.acquisition ||
    !readNativeSessionAcquisition(own.acquisition, activity, at, native.canonicalSessionId) ||
    codexRoomPrepared.get(prepared) !== own ||
    !readCodexNativeOperation(own.nativeOperation)
  )
    return undefined;
  return Object.freeze({
    source: own.source,
    nativeOperation: own.nativeOperation,
    acquisition: own.acquisition,
    native,
  });
}

/** The original preparation continues only with genuine native COMMIT/private FIRST custody. */
export function startCodexCommittedRoomResponder(
  runtime: object,
  prepared: PreparedRoomResponder,
  committed?: OriginalCommittedRoomResponder
): AsyncGenerator<StreamEvent> {
  const own = codexRoomPrepared.get(prepared);
  if (!own || own.runtime !== runtime)
    throw new Error('Room responder preparation is not original.');
  requireOriginalCommittedRoomResponder(committed, runtime, prepared, own.nativeOperation);
  if (!committed) throw new Error('Room committed start authority is not available.');
  return own.start(committed);
}
const codexOriginalActiveSlots = new WeakMap<object, Map<string, AbortController>>();
const codexNativeConstructors = new WeakSet<object>();
const codexNativeOperations = new WeakMap<object, CodexNativeEntry>();
const codexNativeControllers = new WeakMap<AbortController, CodexNativeEntry>();
/** Fixed native lifetime read: tokens are installed only by a real runtime turn. */
export function readCodexNativeOperation(token: object) {
  const entry = codexNativeOperations.get(token);
  if (
    entry?.roomOrigin &&
    readOriginalRoomDispatchLifecycle(entry.roomOrigin.holder, entry.instance) !==
      entry.roomOrigin.custody
  ) {
    entry.retired = true;
    return undefined;
  }
  const slot = entry ? Object.getOwnPropertyDescriptor(entry.instance, 'activeTurns') : undefined;
  if (
    entry &&
    (!codexNativeConstructors.has(entry.instance) ||
      !slot ||
      !('value' in slot) ||
      slot.value !== entry.active)
  ) {
    entry.retired = true;
    return undefined;
  }
  if (
    !entry ||
    entry.retired ||
    nativeSignalAborted.call(entry.signal) ||
    nativeMapGet.call(entry.active, entry.key) !== entry.entry
  )
    return undefined;
  return {
    roomCustody: entry.roomOrigin?.custody,
    acquisition: entry.acquisition,
    runtime: entry.runtime,
    canonicalSessionId: entry.key,
    agentPath: entry.agentPath,
    canonicalCwd: entry.cwd,
    signal: entry.signal,
  };
}

/** Run Codex sessions with their original client and native turn lifetimes. */
export class CodexRuntime implements AgentRuntime {
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
    return boundThreadId !== undefined
      ? threadRunsOnCredits(boundThreadId)
      : creditsIsDefaultFor(this.type);
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
    // Seed display metadata from the durable row before the register below,
    // so a touch that lands before startup hydration completes cannot mint a
    // fresh blank entry (see seedFromDurable).
    this.seedDisplayFromDurable(sessionId);
    this.registry.register(sessionId, {
      permissionMode: opts.permissionMode,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      ...(opts.fastMode !== undefined ? { fastMode: opts.fastMode } : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });
    // Pre-warm the MCP-status cache the first time Codex is actually used, so
    // the Agent Profile MCP list is usually populated before the UI's first
    // (synchronous) `getMcpStatus` call instead of empty until a later refetch.
    this.maybeWarmMcpStatus();
  }

  hasSession(sessionId: string): boolean {
    return this.registry.has(sessionId);
  }

  /** @inheritdoc */
  isTurnOpen(sessionId: string): boolean {
    return this.activeTurns.has(sessionId);
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
    await this.seedFromDurable(sessionId);
    // Read BEFORE the register below overwrites it — this is the mode the
    // in-flight turn's sandbox was projected from.
    const prevMode = this.registry.get(sessionId)?.permissionMode ?? CODEX_DEFAULT_MODE;
    await this.settingsPort?.saveSessionSettings(sessionId, opts);
    this.registry.register(sessionId, {
      ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      ...(opts.fastMode !== undefined ? { fastMode: opts.fastMode } : {}),
    });
    const pending =
      opts.permissionMode !== undefined &&
      this.activeTurns.has(sessionId) &&
      tightensDeclaredMode(CODEX_MODES, prevMode, opts.permissionMode);
    return { updated: true, ...(pending ? { permissionModePendingUntilNextTurn: true } : {}) };
  }

  /**
   * Codex has no writable native session store, so the title lives in the
   * tracked-session metadata and is written through to the session's durable
   * `codex_threads` row (when one exists) so it survives a server restart.
   */
  async renameSession(sessionId: string, title: string): Promise<void> {
    // Seed first so the rename lands on top of the durable createdAt/cwd (the
    // user's title is genuinely fresher and overwrites the seeded one).
    await this.seedFromDurable(sessionId);
    this.registry.rename(sessionId, title);
    this.persistSessionMetadata(sessionId);
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
    // The settings joins run concurrently (per-row degradation preserved);
    // Promise.all keeps the records' order for a deterministic hydrate.
    this.registry.hydrate(
      await Promise.all(this.threadMap.listAll().map((record) => this.buildDurableSession(record)))
    );
  }

  /**
   * Project a durable `codex_threads` row into its display-only Session shape
   * (persisted title/timestamps/preview/cwd, default settings). The settings
   * join lives one level up in {@link CodexRuntime.buildDurableSession}; sync
   * seeding paths use this shape directly.
   */
  private toDurableDisplaySession(record: CodexThreadRecord): Session {
    return {
      id: record.sessionId,
      title: record.title ?? '',
      createdAt: record.createdAt,
      updatedAt: record.updatedAt ?? record.createdAt,
      permissionMode: 'default',
      runtime: 'codex',
      ...(record.lastMessagePreview !== undefined
        ? { lastMessagePreview: record.lastMessagePreview }
        : {}),
      ...(record.cwd !== undefined ? { cwd: record.cwd } : {}),
    };
  }

  /**
   * A durable row's full hydration shape: the display session plus the
   * session's persisted settings (permissionMode/model/effort/fastMode)
   * joined from the core settings store (ADR-0260) where available.
   */
  private async buildDurableSession(record: CodexThreadRecord): Promise<Session> {
    let settings: SessionSettings | null = null;
    try {
      settings = (await this.settingsPort?.getSessionSettings(record.sessionId)) ?? null;
    } catch (err) {
      // Degrade to defaults rather than dropping the session: the metadata
      // row alone is enough to put it back on the list.
      logger.warn('[CodexRuntime] settings join failed during hydration; using defaults', {
        sessionId: record.sessionId,
        err,
      });
    }
    return {
      ...this.toDurableDisplaySession(record),
      ...(settings?.permissionMode !== undefined
        ? { permissionMode: settings.permissionMode }
        : {}),
      ...(settings?.model !== undefined ? { model: settings.model } : {}),
      ...(settings?.effort !== undefined ? { effort: settings.effort } : {}),
      ...(settings?.fastMode !== undefined ? { fastMode: settings.fastMode } : {}),
    };
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
    if (this.registry.has(sessionId)) return;
    const record = this.threadMap.getRecord(sessionId);
    if (!record) return;
    this.registry.hydrate([await this.buildDurableSession(record)]);
  }

  /**
   * Sync display-only variant of {@link CodexRuntime.seedFromDurable} for the
   * sync `ensureSession` path, whose settings arrive from the caller's own
   * opts via the `register()` that follows (exactly as before this fix: no
   * persisted-settings join ever existed on that path).
   */
  private seedDisplayFromDurable(sessionId: string): void {
    if (this.registry.has(sessionId)) return;
    const record = this.threadMap.getRecord(sessionId);
    if (!record) return;
    this.registry.hydrate([this.toDurableDisplaySession(record)]);
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
    const lifetime: {
      closed: boolean;
      entered: boolean;
      retire?: () => void;
      acquisition?: NativeSessionAcquisition;
      roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>;
      roomPrepared?: CodexPreparedRoomContinuation;
    } = {
      closed: false,
      entered: false,
      acquisition,
      roomOrigin,
      roomPrepared,
      retire: roomPrepared
        ? () => {
            roomPrepared.nativeEntry.retired = true;
            roomPrepared.controller.abort();
          }
        : undefined,
    };
    const stream = this.#sendOwnedMessage(sessionId, content, opts, lifetime, origin, inherited);
    const close = () => {
      lifetime.closed = true;
      lifetime.retire?.();
      // Cancel the actual prepared native owner before generator return queues
      // behind a pending transport read. Its memo is joined below and in finally.
      if (roomPrepared) void roomPrepared.retire().catch(() => {});
    };
    const joinOriginalClose = async (result: ReturnType<typeof stream.return>) => {
      let failed = false;
      let first: unknown;
      let outcome: Awaited<ReturnType<typeof stream.return>> | undefined;
      try {
        outcome = await result;
      } catch (cause) {
        failed = true;
        first = cause;
      }
      const own = lifetime.roomPrepared!;
      try {
        retireOriginalCommittedRoomResponder(
          own.committed!,
          this,
          own.prepared,
          own.nativeOperation
        );
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
      try {
        await own.retire();
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
      if (failed) throw first;
      return outcome!;
    };
    const capturedReturn = stream.return.bind(stream);
    const returnOriginal: AsyncGenerator<StreamEvent>['return'] = (value) => {
      close();
      const result = capturedReturn(value);
      return roomPrepared ? joinOriginalClose(result) : result;
    };
    const returned: AsyncGenerator<StreamEvent> = {
      next: (value) => {
        if (!roomPrepared) return stream.next(value);
        return stream.next(value).then((result) => {
          const own = originalCodexRoomStreams.get(returned)!;
          if (!result.done && result.value) {
            own.emitted.add(result.value);
            const data = result.value.data;
            if (
              data &&
              typeof data === 'object' &&
              'terminalReason' in data &&
              typeof data.terminalReason === 'string'
            )
              own.reason = data.terminalReason;
            if (
              result.value.type === 'error' &&
              !isNonFatalErrorCode(
                data && typeof data === 'object' && 'code' in data && typeof data.code === 'string'
                  ? data.code
                  : undefined
              )
            )
              own.failed = true;
            if (result.value.type === 'done') own.done = true;
          }
          return result;
        });
      },
      return: returnOriginal,
      [Symbol.asyncDispose]: async () => {
        await returnOriginal(undefined);
      },
      throw: (error) => {
        close();
        const result = stream.throw(error);
        return roomPrepared ? joinOriginalClose(result) : result;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    if (acquisition)
      originalCodexLockedStreams.set(returned, {
        runtime: this,
        sessionId,
        options: captureTurnLevelOptions(opts),
        current: () => {
          if (lifetime.closed) return false;
          const at = Date.now(),
            activity = captureNativeSessionActivity(acquisition, at);
          return !!activity && !!readNativeSessionAcquisition(acquisition, activity, at, sessionId);
        },
      });
    const originalReturn = returned.return.bind(returned);
    if (roomPrepared && roomPrepared.committed)
      originalCodexRoomStreams.set(returned, {
        runtime: this,
        prepared: roomPrepared.prepared,
        operation: roomPrepared.nativeOperation,
        committed: roomPrepared.committed,
        emitted: new WeakSet(),
        close: () => originalReturn(undefined),
        failed: false,
        done: false,
      });
    return returned;
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
    if (
      roomOrigin &&
      readOriginalRoomDispatchLifecycle(roomOrigin.holder, this) !== roomOrigin.custody
    )
      throw new Error('Original Room dispatch lifetime is retired.');
    const active = codexOriginalActiveSlots.get(this),
      slot = Object.getOwnPropertyDescriptor(this, 'activeTurns');
    if (!active || !slot || !('value' in slot) || slot.value !== active)
      throw new Error('Native preparation requires its original active slot.');
    if (refuseExisting && nativeMapGet.call(active, sessionId))
      throw new Error('Native preparation cannot replace a live entry.');
    nativeMapSet.call(active, sessionId, controller);
    const nativeOperation = Object.freeze({});
    if (!codexNativeConstructors.has(this))
      throw new Error('Native runtime operation requires its genuine constructor.');
    const nativeEntry = {
      roomOrigin,
      acquisition: acquisition,
      instance: this,
      active,
      key: sessionId,
      entry: controller,
      signal: controller.signal,
      retired: false,
      runtime: 'codex' as const,
      agentPath,
      cwd,
    };
    codexNativeOperations.set(nativeOperation, nativeEntry);
    codexNativeControllers.set(controller, nativeEntry);

    return { nativeOperation, nativeEntry };
  }
  async #prepareRoomResponder(
    source: OriginalFrozenRoomSource,
    target: Readonly<{ sessionId: string; agentPath: string; agentId: string }>,
    acquisition: NativeSessionAcquisition
  ): Promise<PreparedRoomResponder | undefined> {
    const { sessionId, agentPath } = target;
    const tools = this.connectorRuntimeTools;
    if (!tools || nativeMapGet.call(codexOriginalActiveSlots.get(this)!, sessionId))
      return undefined;
    requireOriginalRoomPrincipalService(source, tools.principals);
    if (
      this.identityPathFor(agentPath, agentPath) !== agentPath ||
      this.meshCore?.getByPath(agentPath)?.id !== target.agentId
    )
      throw new Error('Room responder differs from its approved target.');
    const controller = new AbortController();
    const { nativeOperation, nativeEntry } = this.#installNativeTurn(
      sessionId,
      agentPath,
      agentPath,
      controller,
      acquisition,
      true
    );
    let binding: OpenConnectorTurnResult | undefined;
    let retirement: Promise<void> | undefined;
    const retire = (): Promise<void> => {
      if (retirement) return retirement;
      let resolve!: () => void, reject!: (cause: unknown) => void;
      retirement = new Promise<void>((done, refused) => {
        resolve = done;
        reject = refused;
      });
      // Reserve the original retirement before abort callbacks can reenter.
      void (async () => {
        nativeEntry.retired = true;
        if (this.activeTurns.get(sessionId) === controller) this.activeTurns.delete(sessionId);
        controller.abort();
        this.activeConnectorBindings.delete(controller);
        if (binding) await tools.principals.revoke(binding.bindingId, 'turn_cancelled');
      })().then(resolve, reject);
      return retirement;
    };
    try {
      binding = await openOriginalNativeTurn(
        tools.principals,
        {
          runtime: 'codex',
          canonicalSessionId: sessionId,
          agentPath,
          canonicalCwd: agentPath,
          signal: controller.signal,
        },
        nativeOperation
      );
      this.activeConnectorBindings.set(controller, binding.bindingId);
      controller.signal.throwIfAborted();
      const at = Date.now(),
        activity = captureNativeSessionActivity(acquisition, at);
      if (
        !activity ||
        !readNativeSessionAcquisition(acquisition, activity, at, sessionId) ||
        !readCodexNativeOperation(nativeOperation)
      )
        throw new Error('Room responder retired during preparation.');
      const prepared: PreparedRoomResponder = Object.freeze({ kind: 'prepared-room-responder' });
      codexRoomPrepared.set(prepared, {
        runtime: this,
        retire,
        source,
        nativeOperation,
        acquisition,
        start: (() => {
          let started = false;
          return (committed: OriginalCommittedRoomResponder) => {
            if (started || !binding || !readCodexPreparedRoomResponder(this, prepared))
              throw new Error('Room prepared entry cannot start twice or after retirement.');
            started = true;
            return this.#createMessage(
              sessionId,
              'Document update',
              { cwd: agentPath },
              acquisition,
              undefined,
              { prepared, committed, controller, nativeOperation, nativeEntry, binding, retire }
            );
          };
        })(),
      });
      return prepared;
    } catch (cause) {
      try {
        await retire();
      } catch {}
      throw cause;
    }
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
    let failed = false,
      first: unknown;
    const cleanup = async (work: () => unknown | Promise<unknown>) => {
      try {
        await work();
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
    };
    // Join this scope to its captured cleanup before returning or reporting failure.
    const drainOriginalCleanup = async () => {
      const own = lifetime.roomPrepared;
      if (own) {
        if (failed || lifetime.closed)
          await cleanup(() =>
            retireOriginalCommittedRoomResponder(
              own.committed,
              this,
              own.prepared,
              own.nativeOperation
            )
          );
        await cleanup(() => own.retire());
      }
      if (failed) throw first;
    };
    try {
      lifetime.entered = true;
      if (origin === 'dispatched') {
        for (const listener of this.dispatchedTurnListeners) {
          try {
            listener(sessionId);
          } catch (err) {
            logger.warn('[CodexRuntime] dispatched-turn listener threw', { err });
          }
        }
        this.consecutiveWakes.delete(sessionId);
      }
      // Seed from the durable row before any registry mutation: recordMessage's
      // title-if-blank derivation must see the persisted title, not a fresh
      // blank entry it would fill with an auto-preview (see seedFromDurable).
      await this.seedFromDurable(sessionId);
      let settings = await this.resolveTurnSettings(sessionId, opts);
      const binding = this.threadMap.get(sessionId);
      const boundThreadId = binding?.threadId;
      // Resolution order (post-restart safe): per-send override → in-memory
      // registry → the persisted binding's cwd → the server's default root. The
      // registry is empty after a restart, so the persisted cwd is what keeps
      // `codex exec` in the right dir. The default-root floor guarantees the
      // turn, the registry entry, and the binding row persisted below always
      // carry a real cwd — a cwd-less session belongs to no project list and
      // would be invisible in every sidebar (DOR-202).
      const cwd = opts?.cwd ?? this.registry.get(sessionId)?.cwd ?? binding?.cwd ?? this.defaultCwd;
      // Durably backfill a legacy cwd-less binding row (NULL-guarded, so the
      // first-write-wins binding is never overwritten). Without this the session
      // gains a cwd in memory only and re-hydrates cwd-less — invisible in every
      // list — after each restart. Best-effort like persistSessionMetadata.
      if (binding !== undefined && binding.cwd === undefined) {
        try {
          this.threadMap.backfillCwd(sessionId, cwd);
        } catch (err) {
          logger.warn('[CodexRuntime] failed to backfill binding cwd', { sessionId, err });
        }
      }
      if (origin === 'dispatched') {
        this.registry.recordMessage(sessionId, content, {
          cwd,
          ...(opts?.title !== undefined ? { title: opts.title } : {}),
        });
        // Write the refreshed preview/updatedAt (and first-turn title) through to
        // the durable row. A no-op before the first bind — the setThreadId below
        // carries the first turn's metadata with the row instead.
        this.persistSessionMetadata(sessionId);
      }

      // Which registered agent does this turn act as? Everything below that
      // mints, injects or names a tool is gated on the answer, and the agent's
      // context is read from it. Resolved to a home rather than read off `cwd`
      // (DOR-2091, DOR-2355): a turn may stand in a room worktree, a worktree of
      // the agent's own repo or a managed checkout, none of which is the home —
      // and it is nobody when the turn names a different agent. `cwd` stays where
      // the thread runs; `agentPath` is whose identity it has.
      const agentPath = this.identityPathFor(cwd, turnAgentOf(opts));
      const meshAgent = agentPath ? this.meshCore?.getByPath(agentPath) : undefined;

      // **Who pays** (ADR 261001-000811), decided before anything starts. A
      // thread that already exists stays on whatever paid for it: its rollout
      // lives in exactly one Codex home. A new thread runs on DorkOS credits
      // when that is Codex's recorded default. A credits turn with no live token
      // is REFUSED here, and nothing is spawned.
      let credits: CreditsLaunch | null;
      let creditsSwap: CreditsModelDecision['swap'];
      try {
        credits = await this.creditsLaunchFor(boundThreadId);
        // **Which model a credits turn runs** (DOR-2636), the same decision every
        // runtime on credits makes: once the service says which formats its
        // models are in, a model it does not serve in Codex's format runs on the
        // service's suggestion instead, and a list naming none refuses the turn.
        // While the service says nothing, the session's model stands.
        if (credits) {
          const decided = await decideCreditsLaunchModel({
            capabilities: this.getCapabilities(),
            runtimeLabel: 'Codex',
            sessionId,
            model: settings.model,
            nameOf: async () =>
              settings.model === undefined ? undefined : catalogNameFor(this, settings.model),
            remember: async (model) => {
              await this.updateSession(sessionId, { model });
            },
          });
          if (decided.model !== undefined) settings = { ...settings, model: decided.model };
          creditsSwap = decided.swap;
        }
      } catch (err) {
        const refusal = creditsRefusalEvent(err);
        if (!refusal) throw err;
        const original = lifetime.roomPrepared;
        if (original) {
          // This claimed source did not start a model: retire its genuine
          // native authority before the refusal becomes observable. No retry.
          lifetime.closed = true;
          original.nativeEntry.retired = true;
          retireOriginalCommittedRoomResponder(
            original.committed,
            this,
            original.prepared,
            original.nativeOperation
          );
        }
        yield refusal;
        return;
      }
      // Said before anything is spawned, and saved only once it has been said: a
      // swap's notice and its save are one step (`CreditsModelDecision.swap`).
      if (creditsSwap?.notice) yield creditsSwap.notice;
      await creditsSwap?.commit();

      if (lifetime.closed) return;
      const controller = lifetime.roomPrepared?.controller ?? new AbortController();
      const { nativeOperation, nativeEntry } =
        lifetime.roomPrepared ??
        this.#installNativeTurn(
          sessionId,
          cwd,
          agentPath,
          controller,
          lifetime.acquisition,
          false,
          lifetime.roomOrigin
        );
      lifetime.retire = () => {
        nativeEntry.retired = true;
      };

      if (credits) this.creditsTurns.add(controller);
      let connectorBinding: OpenConnectorTurnResult | undefined;
      let connectorSupervisor: ConnectorTurnLeaseSupervisorHandle | undefined;
      let connectorRevokeReason: RevokeConnectorTurnReason = 'setup_failed';
      let connectorRuntimeFailed = false;
      try {
        let connectorTools: ConnectorRuntimeMcpInjection | null = null;
        if (this.connectorRuntimeTools && meshAgent && agentPath) {
          connectorBinding =
            lifetime.roomPrepared?.binding ??
            (await this.connectorRuntimeTools.principals.openTurn(
              {
                runtime: this.type,
                canonicalSessionId: sessionId,
                agentPath,
                canonicalCwd: cwd,
                signal: controller.signal,
              },
              { isCurrent: () => this.activeTurns.get(sessionId) === controller, nativeOperation }
            ));
          this.activeConnectorBindings.set(controller, connectorBinding.bindingId);
          const createSupervisor =
            this.connectorRuntimeTools.createLeaseSupervisor ??
            ((options) => new ConnectorTurnLeaseSupervisor(options));
          connectorSupervisor = createSupervisor({
            principals: this.connectorRuntimeTools.principals,
            bindingId: connectorBinding.bindingId,
            permit: connectorBinding.renewalPermit,
            runtime: this.type,
            expiresAt: connectorBinding.expiresAt,
            signal: controller.signal,
            onLost: (loss) => logger.warn('[CodexRuntime] Connections lease lost', loss),
          });
          connectorTools = {
            url: this.connectorRuntimeTools.listenerUrl,
            agentToolsUrl: this.connectorRuntimeTools.agentToolsUrl,
            headers: connectorRuntimeHeaders({
              bearer: connectorBinding.bearer,
              runtime: this.type,
              canonicalCwd: cwd,
            }),
          };
        }

        // Mint this session's agent identity token when this cwd hosts a registered
        // agent. It rides the subprocess env, never the prompt, so it stays a
        // credential for the `dorkos` commands the agent runs rather than text in its
        // context and transcript (spec `agent-trust` §3.1). `{}` leaves the turn
        // unattributed, exactly as before.
        //
        // Minted under the name a PERSON reads, never the slug: the token's label
        // is replayed onto the agent's author row by every room tool it calls, so
        // the slug there renames a live agent mid-conversation (DOR-1264).
        const mintAgentToken = () =>
          resolveAgentTokenEnv(
            meshAgent ? agentPath : undefined,
            meshAgent?.displayName ?? meshAgent?.name
          );
        const mintsOnLoad = this.#transport.kind === 'app-server' && meshAgent !== undefined;
        const agentTokenEnv = mintsOnLoad ? {} : await mintAgentToken();

        // The `dorkos` tool server, when the experiment is on and this cwd hosts a
        // registered agent (spec `tool-only-room-replies` §D4). It reuses the
        // already-open connector turn binding on a separate capability route, so
        // it expires and revokes with this exact turn. `null` injects nothing.
        //
        // Scoped to every agent-bound session rather than to room turns: the runtime
        // cannot know why it was called, and these tools are worth having outside a
        // room anyway.
        //
        // Resolved BEFORE the managed servers because it decides whether the name
        // `dorkos` is reserved against them this turn — see below.
        const dorkosTools = await resolveDorkosMcpInjection(
          meshAgent ? agentPath : undefined,
          connectorTools
        );

        // The agent's ENABLED managed MCP servers, injected inline via
        // `config.mcp_servers` (spec `mcp-server-management` §6, DOR-892). Keyed
        // on the agent the turn acts as — its own folder even when it stands in a
        // room worktree (DOR-2091) — and a non-agent session contributes none.
        // No anchored agent — including a refused turn standing in another
        // agent's folder — means no managed servers, never the directory's.
        const managedMcpServers = agentPath
          ? resolveManagedMcpServers(this.managedMcpServers, agentPath, dorkosTools !== null)
          : { servers: {}, env: {} };

        const writableDirectories = grantedWritableDirectories(opts?.additionalDirectories, cwd);
        const binary = await this.resolveTurnBinary();
        if (boundThreadId === undefined) this.contextGate.forget(sessionId);

        // Runtime-neutral DorkOS context (identity, persona, safety boundaries,
        // <dorkos_context>, <env>): the same blocks the Claude adapter injects, so a
        // Codex agent knows who it is and how to reach its capabilities.
        //
        // Codex's only input channel is the prompt, and a prompt lands in the
        // thread's persisted rollout, so re-sending this every turn leaves one copy
        // per turn IN the conversation. {@link CodexContextGate} decides which half
        // this turn owes: the whole append when the thread has not been told (or the
        // agent was edited since), the memory block alone otherwise — memory is
        // outside the gate because it changes while the thread runs.
        const neutralContextSelection = this.contextGate.select(
          sessionId,
          await buildAgentContextAppend(agentPath, cwd)
        );

        // The room verbs, and ONLY when this turn actually carries them — gated on
        // the resolved injection itself, not on a second guess at it, so the prose
        // and the wiring cannot disagree (spec `tool-only-room-replies` §D11).
        // Named under codex's own MCP prefix, never claude-code's: a bare or
        // wrongly-prefixed name is uncallable, which is the DOR-1292 defect.
        //
        // Outside the context gate, and deliberately: whether this session HAS the
        // room tools is answered per turn, so a menu written in the wrong tense must
        // never survive into a turn where it is false.
        //
        // Beside it, one line per Blocked permission area (spec `agent-permissions`
        // D15), resolved per turn like the menu: the runtime listener hides the
        // same area's tools from this turn's list.
        const agentContext = dorkosTools
          ? [
              neutralContextSelection.text,
              buildRoomToolsBlock(CODEX_DORKOS_TOOL_PREFIX),
              // The agent's own Blocked areas, read where its manifest lives —
              // the listener hides the same areas keyed on the same anchor.
              renderBlockedAreaLines((await resolveToolVisibilityFor(agentPath)).blockedAreas),
            ]
              .filter(Boolean)
              .join('\n\n')
          : neutralContextSelection.text;

        const accessContext =
          connectorTools && this.connectorRuntimeTools && meshAgent
            ? await this.accountsAccess.select(
                this.connectorRuntimeTools,
                meshAgent.id,
                sessionId,
                {
                  serviceCatalog: Boolean(dorkosTools),
                }
              )
            : undefined;
        const turnOpts = accessContext
          ? {
              ...opts,
              additionalContext: [...(opts?.additionalContext ?? []), accessContext.entry],
            }
          : opts;
        // No room marker: `control_ui` is a `ui` capability now, and its handler
        // reads the room this turn is answering in from the runtime-neutral turn
        // facts the trigger bound (spec `canvas-agent-seat` §5). The mapper has
        // nothing left to refuse.
        // A credits thread's rollout is in the credits home. Its context reading
        // is read from there, and its rate limits are dropped: they are the
        // credits endpoint's, not the person's Codex account's, and must never
        // be filed under that account's usage.
        const ctx = createCodexEventContext(
          sessionId,
          credits
            ? {
                readTurnContextUsage: async (threadId, turnStartedAtMs, signal) => {
                  const reading = await readCodexTurnReading({
                    threadId,
                    turnStartedAtMs,
                    signal,
                    codexHome: creditsCodexHome(),
                  });
                  return reading ? { ...reading, rateLimits: [] } : null;
                },
              }
            : {}
        );
        connectorRevokeReason = 'runtime_failed';
        if (lifetime.roomPrepared) {
          const prepared = lifetime.roomPrepared;
          consumeOriginalCommittedRoomResponder(
            prepared.committed,
            this,
            prepared.prepared,
            nativeOperation
          );
        }
        const turnEvents = this.#runTransportTurn.call(this.#transport, {
          binary,
          sessionId,
          boundThreadId,
          cwd,
          settings,
          writableDirectories,
          prompt: buildCodexPrompt(content, turnOpts, agentContext),
          // What a wake from this turn's leftover work runs with: the same
          // agent, folder, grants and settings. A wake's own turn passes its
          // context on, so a chain of wakes stays the same agent.
          ...(() => {
            const wakeContext = inherited ?? wakeContextOf(opts, cwd);
            return wakeContext ? { wakeContext } : {};
          })(),
          ...(opts?.messageId !== undefined ? { messageId: opts.messageId } : {}),
          launch: credits ? { home: 'credits', credits } : { home: 'person' },
          tools: {
            agentTokenEnv,
            ...(mintsOnLoad ? { mintAgentToken } : {}),
            managed: managedMcpServers,
            dorkosTools,
            connectorTools,
            ...(connectorBinding ? { connectorBindingId: connectorBinding.bindingId } : {}),
          },
          signal: controller.signal,
          events: ctx,
          // Persisted the moment the transport learns the id — before the
          // terminal done — so even an interrupted or crashed first turn stays
          // resumable. The cwd is persisted with it so a post-restart resume runs
          // in the right dir, and the registry's current display metadata rides
          // along so the first turn's title/preview land with the row.
          // First-write-wins keeps re-binds benign; `replaces` is the one
          // exception (a thread Codex can no longer continue, spec §6).
          onThreadBound: (threadId, replaces) => {
            if (replaces !== undefined) {
              this.threadMap.replaceThreadId(sessionId, replaces, threadId);
              return;
            }
            const tracked = this.registry.get(sessionId);
            this.threadMap.setThreadId(
              sessionId,
              threadId,
              cwd,
              tracked ? this.toMetadataPatch(tracked) : undefined
            );
          },
        });
        let completedTurn = false;
        let sawDone = false;
        let sawCompaction = false;
        for await (const event of turnEvents) {
          if (event.type === 'done') sawDone = true;
          if (event.type === 'compact_boundary') sawCompaction = true;
          if (
            event.type === 'session_status' &&
            'terminalReason' in event.data &&
            event.data.terminalReason === 'completed'
          )
            completedTurn = true;
          // On credits, a refused token is the credits card, never a Codex
          // sign-in error: the person's own sign-in was not used.
          yield credits ? asCreditsStopped(event, 'Codex') : event;
          if (
            event.type === 'session_status' &&
            'terminalReason' in event.data &&
            event.data.terminalReason === 'error'
          ) {
            connectorRuntimeFailed = true;
          }
          // The async half of media mapping. `mapCodexThread` is pure and cannot
          // store bytes, so it records what it saw on `ctx` and this drains it
          // here — after the event it rode in on, so an image lands in the
          // transcript exactly where the tool result that produced it did.
          yield* captureCodexMedia(this.attachments, sessionId, ctx);
        }
        if (!sawDone) {
          logger.error('[CodexRuntime] a turn ended without its done; closing it', { sessionId });
          yield { type: 'done', data: { sessionId } };
        }
        // Successful consumption, not creation of a lazy transport iterator, is delivery.
        // Only acknowledge after successful consumption; failures keep the notice owed.
        if (completedTurn && !connectorRuntimeFailed && !controller.signal.aborted) {
          neutralContextSelection.commit();
          accessContext?.commit();
        }
        // A mid-turn summary may discard identity context; re-anchor the next turn.
        if (sawCompaction) this.contextGate.forget(sessionId);
        connectorRevokeReason = connectorRuntimeFailed ? 'runtime_failed' : 'turn_terminal';
      } catch (cause) {
        failed = true;
        first = cause;
      } finally {
        nativeEntry.retired = true;
        if (controller.signal.aborted) connectorRevokeReason = 'turn_cancelled';
        await cleanup(() => connectorSupervisor?.stop());
        if (!lifetime.roomPrepared)
          await cleanup(async () => {
            if (connectorBinding && this.activeConnectorBindings.has(controller)) {
              this.activeConnectorBindings.delete(controller);
              await this.connectorRuntimeTools?.principals.revoke(
                connectorBinding.bindingId,
                connectorRevokeReason
              );
            }
          });
        this.creditsTurns.delete(controller);
        if (this.activeTurns.get(sessionId) === controller) this.activeTurns.delete(sessionId);
      }
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    } finally {
      await drainOriginalCleanup();
    }
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
    const compact = this.#transport.compact?.bind(this.#transport);
    if (!compact) {
      throw new Error('executeCommandIntent(compact) is not supported by codex on exec');
    }
    await this.seedFromDurable(sessionId);
    const settings = await this.resolveTurnSettings(sessionId, opts);
    const binding = this.threadMap.get(sessionId);
    const boundThreadId = binding?.threadId;
    // No thread, no conversation: said before anything about who would pay.
    if (boundThreadId === undefined) {
      yield* nothingToSummarize(sessionId);
      return;
    }
    const cwd = opts?.cwd ?? this.registry.get(sessionId)?.cwd ?? binding?.cwd ?? this.defaultCwd;
    let credits: CreditsLaunch | null;
    let creditsSwap: CreditsModelDecision['swap'];
    try {
      credits = await this.creditsLaunchFor(boundThreadId);
      // The same model decision a credits turn makes (DOR-2636): a list that
      // names no model Codex can run refuses the summary too. A swap it makes
      // is said and saved here, but takes effect from the next turn:
      // `thread/compact/start` takes no model, so the summary runs on the
      // model the thread already has.
      if (credits) {
        creditsSwap = (
          await decideCreditsLaunchModel({
            capabilities: this.getCapabilities(),
            runtimeLabel: 'Codex',
            sessionId,
            model: settings.model,
            nameOf: async () =>
              settings.model === undefined ? undefined : catalogNameFor(this, settings.model),
            remember: async (model) => {
              await this.updateSession(sessionId, { model });
            },
          })
        ).swap;
      }
    } catch (err) {
      const refusal = creditsRefusalEvent(err);
      if (!refusal) throw err;
      yield refusal;
      yield { type: 'done', data: { sessionId } };
      return;
    }
    if (creditsSwap?.notice) yield creditsSwap.notice;
    await creditsSwap?.commit();
    const controller = new AbortController();
    this.activeTurns.set(sessionId, controller);
    if (credits) this.creditsTurns.add(controller);
    try {
      const events = compact({
        binary: await this.resolveTurnBinary(),
        sessionId,
        boundThreadId,
        cwd,
        settings,
        launch: credits ? { home: 'credits', credits } : { home: 'person' },
        signal: controller.signal,
        events: createCodexEventContext(sessionId),
        onThreadBound: (threadId, replaces) => {
          if (replaces !== undefined) this.threadMap.replaceThreadId(sessionId, replaces, threadId);
        },
      });
      let summarized = false;
      for await (const event of events) {
        if (event.type === 'compact_boundary') summarized = true;
        yield credits ? asCreditsStopped(event, 'Codex') : event;
      }
      // The summary may have dropped the identity this thread was told.
      if (summarized) this.contextGate.forget(sessionId);
    } finally {
      this.creditsTurns.delete(controller);
      if (this.activeTurns.get(sessionId) === controller) this.activeTurns.delete(sessionId);
    }
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
    if (!this.registry.has(sessionId)) {
      const persisted = await this.settingsPort?.getSessionSettings(sessionId);
      this.registry.register(sessionId, {
        permissionMode: opts?.permissionMode ?? persisted?.permissionMode ?? 'default',
        ...(persisted?.model !== undefined ? { model: persisted.model } : {}),
        ...(persisted?.effort !== undefined ? { effort: persisted.effort } : {}),
        ...(persisted?.fastMode !== undefined ? { fastMode: persisted.fastMode } : {}),
        ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
      });
    }
    const tracked = this.registry.get(sessionId)!;
    const model = opts?.model ?? tracked.model;
    const effort = opts?.effort ?? tracked.effort;
    const fastMode = opts?.fastMode ?? tracked.fastMode;
    const chosen = opts?.permissionMode ?? tracked.permissionMode;
    return {
      // Held to the turn's ceiling, for this turn only: a turn another agent's
      // post or a stranger's message started runs no looser than its sender,
      // and the tracked mode is left as the person chose it (spec
      // `trusted-by-default-flip` §4).
      permissionMode:
        opts?.permissionCeiling !== undefined
          ? clampModeToCeiling(
              this.getCapabilities().permissionModes,
              chosen,
              opts.permissionCeiling
            )
          : chosen,
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(fastMode !== undefined ? { fastMode } : {}),
    };
  }

  /**
   * Project a tracked session's display metadata into the thread map's patch
   * shape. An unset title (the registry's `''` default) is omitted so a blank
   * never overwrites a previously persisted title (or lands as `''` in a
   * fresh row — NULL hydrates back to the same blank default).
   */
  private toMetadataPatch(session: Session): CodexThreadMetadataPatch {
    return {
      ...(session.title !== '' ? { title: session.title } : {}),
      updatedAt: session.updatedAt,
      ...(session.lastMessagePreview !== undefined
        ? { lastMessagePreview: session.lastMessagePreview }
        : {}),
    };
  }

  /**
   * Write the registry's current title/updatedAt/preview through to the
   * session's durable `codex_threads` row. A no-op until `thread.started`
   * binds the row. Failures are logged, never thrown — durable metadata is
   * best-effort and the in-memory registry already holds the fresh state.
   */
  private persistSessionMetadata(sessionId: string): void {
    const tracked = this.registry.get(sessionId);
    if (!tracked) return;
    try {
      this.threadMap.updateMetadata(sessionId, this.toMetadataPatch(tracked));
    } catch (err) {
      logger.warn('[CodexRuntime] failed to persist session metadata', { sessionId, err });
    }
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

  async listSessions(projectDir: string): Promise<Session[]> {
    return this.registry.list(projectDir);
  }

  async getSession(_projectDir: string, sessionId: string): Promise<Session | null> {
    return this.registry.get(sessionId);
  }

  /**
   * Completed messages reconstructed from the DorkOS-owned event stream, read
   * DURABLY from the `session_events` store (DOR-189) so history survives a
   * server restart — the SDK has no thread-read API. Needs no live projector:
   * the store is the completed-history source whether or not a projector is up
   * (each turn is flushed on `turn_end`), which fixes the post-restart
   * empty-transcript bug (was `peekProjector` → `[]`).
   *
   * **A failed turn cannot come back as agent speech here, and the reason is
   * structural** (DOR-1666, the parity check against the claude-code gap where
   * the CLI writes API failures into its JSONL as synthetic assistant
   * messages). Every Codex failure has its own typed home in the SDK stream —
   * `turn.failed`, an `ErrorItem`, or a `ThreadErrorEvent`; nothing delivers
   * one as an `AgentMessageItem` — so the mapper classifies it exactly once
   * into a typed `error` event, `turn_end` flushes that event with the rest of
   * its turn, and `reconstructHistoryFromEvents` replays it as an `ErrorPart`
   * carrying the same category. History inherits the live classification
   * rather than re-deriving it, which is why the two can never disagree. Pinned
   * by "reconstructs an auth-failed turn as a typed auth_error part" in
   * `__tests__/codex-runtime.test.ts`.
   */
  async getMessageHistory(_projectDir: string, sessionId: string): Promise<HistoryMessage[]> {
    return readLogBackedHistory(sessionId);
  }

  /**
   * @inheritdoc
   *
   * Built entirely from the DorkOS-owned projection: completed `messages` are
   * reconstructed from the EventLog (durably hydrated on projector creation via
   * `{ persist: 'history' }`), and the live turn/status/pending/cursor come from the
   * same projector — the exact test-mode pattern (ADR-0263).
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
   * the trigger path feeds, so `/events` serves a Codex turn through exactly
   * the code path the Claude adapter uses.
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
   * The registry answers directly here: Codex keys its projectors by the
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
   * Emits the tracked-session inventory then live upserts. Discovery is
   * bounded by what this server observed (the SDK exposes no thread listing);
   * `session_status` liveness fans out runtime-neutrally from the projector
   * via the session-list broadcaster, same as every runtime.
   */
  subscribeSessionList(_ctx: SessionOpts): AsyncIterable<SessionListEvent> {
    return this.registry.subscribe();
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
    return this.modelCatalog.getSupportedModels();
  }

  /** Codex exposes no subagent registry. */
  async getSupportedSubagents(): Promise<SubagentInfo[]> {
    return [];
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
    const overrides = this.#transport.capabilities;
    // `commandIntents` is merged per intent, so a transport that turns one on
    // does not drop the others the base declares.
    const base =
      Object.keys(overrides).length === 0
        ? CODEX_CAPABILITIES
        : {
            ...CODEX_CAPABILITIES,
            ...overrides,
            commandIntents: { ...CODEX_CAPABILITIES.commandIntents, ...overrides.commandIntents },
          };
    if (!this.attachments) return base;
    return { ...base, mediaOutput: 'attachments' };
  }

  async checkDependencies(): Promise<DependencyCheck[]> {
    const checks = await checkCodexDependencies();
    if (this.#transport.kind !== 'app-server') return checks;
    const note = codexAppServerVersionNote(
      codexAppServerPool.lastSeenVersion,
      PINNED_CODEX_APP_SERVER_VERSION
    );
    return note ? [...checks, note] : checks;
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
    const commands = cwd ? scanSkillCommands(cwd) : [];
    return { commands, lastScanned: new Date().toISOString() };
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
    this.maybeWarmMcpStatus();
    return this.mcpStatusCache;
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
    const agentPath = this.identityPathFor(session.cwd, session.agentPath);
    return dorkosToolsPosture(
      agentPath && this.meshCore?.getByPath(agentPath) ? agentPath : undefined,
      this.connectorRuntimeTools !== undefined
    ).wired;
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
    return homeOf(resolveAgentHome(cwd, forAgent));
  }

  /**
   * Kick a background MCP-status warm when one is warranted: never warmed yet,
   * or last warmed longer than {@link MCP_STATUS_TTL_MS} ago. A warm already in
   * flight ({@link mcpWarmPromise}) dedupes so at most one `codex mcp list`
   * probe runs at a time. Fire-and-forget — callers stay synchronous and read
   * the last-known cache.
   */
  private maybeWarmMcpStatus(): void {
    if (this.mcpWarmPromise !== null) return;
    const isFresh =
      this.mcpStatusWarmedAt !== null && Date.now() - this.mcpStatusWarmedAt < MCP_STATUS_TTL_MS;
    if (isFresh) return;
    this.mcpWarmPromise = this.warmMcpStatus();
  }

  /**
   * Warm {@link mcpStatusCache} from `codex mcp list --json`. A genuine
   * enumeration failure (returns `null`) leaves the cache cold and unstamped so
   * the next `getMcpStatus` retries immediately; success (including an empty
   * list) caches the result and stamps {@link mcpStatusWarmedAt} to start the TTL.
   */
  private async warmMcpStatus(): Promise<void> {
    try {
      const servers = await enumerateCodexMcpServers(this.resolveBinary);
      if (servers !== null) {
        this.mcpStatusCache = servers;
        this.mcpStatusWarmedAt = Date.now();
      }
    } finally {
      this.mcpWarmPromise = null;
    }
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
    const threadId = this.threadMap.get(sessionId)?.threadId;
    if (!threadId) return null;
    const codexHome = (await threadRunsOnCredits(threadId)) ? creditsCodexHome() : undefined;
    return readCodexTurnContextUsage({
      threadId,
      timeoutMs: CONTEXT_USAGE_AT_REST_TIMEOUT_MS,
      ...(codexHome ? { codexHome } : {}),
    });
  }

  // --- Dependency injection ---

  /** Inject the core session-settings store for durable hydrate/write-through (ADR-0260). */
  setSessionSettings(port: SessionSettingsPort): void {
    this.settingsPort = port;
  }
}

/**
 * Model turns background work may start in a row with no dispatched turn
 * between them. Each wake is the agent answering its own work; three in a row
 * with nobody's word in between is a loop, not progress, so the fourth
 * finish is shown and the chat waits for a person (spec §12).
 */
export const MAX_CONSECUTIVE_WAKES = 3;

/** What the person reads when the wake budget is spent. */
export const WAKE_BUDGET_SPENT_COPY =
  'Codex woke this chat three times in a row, so it waits for you now.';

/** The options a wake's turn inherits from the turn that left the work running. */
interface CodexWakeContext {
  readonly opts: MessageOpts;
}

/**
 * The part of a dispatched turn's options a wake's turn may carry: who it runs
 * as, where, with which folders and account. Never the message's own id,
 * title, disposition or attached context, which belong to that message.
 *
 * **Never the permission mode, model, effort or fast mode.** Those are the
 * session's, and the person may change them after the starting turn: a
 * scheduled run at Full access must not make a wake run at Full access after
 * the person set Ask first. The wake reads the session's current values.
 *
 * A room turn returns `undefined`: its tools and identity are bound to the
 * room's dispatch (its turn id and author), which a wake cannot reproduce, so
 * its leftover work is shown and the room carries on on its own next turn —
 * which also keeps every wake inside the room's own turn limits.
 */
function wakeContextOf(opts: MessageOpts | undefined, cwd: string): CodexWakeContext | undefined {
  if (opts?.roomTurn !== undefined) return undefined;
  const carried = {
    cwd,
    ...(opts?.forAgent !== undefined ? { forAgent: opts.forAgent } : {}),
    ...(opts?.systemPromptAppend !== undefined
      ? { systemPromptAppend: opts.systemPromptAppend }
      : {}),
    ...(opts?.additionalDirectories !== undefined
      ? { additionalDirectories: opts.additionalDirectories }
      : {}),
    ...(opts?.accountHint !== undefined ? { accountHint: opts.accountHint } : {}),
    ...(opts?.unattended !== undefined ? { unattended: opts.unattended } : {}),
    ...(opts?.unattendedApprovals !== undefined
      ? { unattendedApprovals: opts.unattendedApprovals }
      : {}),
    // The bound travels with the work it bounds: a wake turn after background
    // work an outsider's turn started runs no looser than that turn did.
    ...(opts?.permissionCeiling !== undefined ? { permissionCeiling: opts.permissionCeiling } : {}),
  } as MessageOpts;
  return { opts: carried };
}

/**
 * The one context every waking completion shares, or `undefined` when any
 * lacks one or they came from turns run differently: then the finishes are
 * shown and no model turn starts, rather than one running as the wrong agent.
 */
function sharedWakeContext(
  completions: readonly BackgroundCompletion[]
): CodexWakeContext | undefined {
  const contexts = completions.map(
    (completion) => completion.context as CodexWakeContext | undefined
  );
  const first = contexts[0];
  if (first === undefined) return undefined;
  const key = JSON.stringify(first.opts);
  return contexts.every((context) => context !== undefined && JSON.stringify(context.opts) === key)
    ? first
    : undefined;
}
