import { captureTurnLevelOptions } from '../../core/turn-power/turn-levels.js';
import {
  readOriginalRegisteredNativeStream,
  readOriginalRegisteredRuntime,
} from '../../core/runtime-registry.js';
const originalOpenCodeLockedStreams = new WeakMap<
  object,
  { runtime: object; sessionId: string; options: Readonly<MessageOpts>; current(): boolean }
>();
/** Fixed constructor-created stream identity plus the original live acquisition; never a supplied stream matcher. */
export function readOpenCodeOriginalLockedStream(
  runtime: object,
  sessionId: string,
  stream: object
): boolean {
  const own = originalOpenCodeLockedStreams.get(stream);
  return !!own && own.runtime === runtime && own.sessionId === sessionId && own.current();
}
/** Exact original opened turn DATA; a supplied observer cannot replace these options. */
export function readOpenCodeOriginalLockedTurnOptions(
  runtime: object,
  sessionId: string,
  stream: object
) {
  const own = originalOpenCodeLockedStreams.get(stream);
  return own && own.runtime === runtime && own.sessionId === sessionId && own.current()
    ? { options: own.options }
    : undefined;
}
import { isNonFatalErrorCode, isAbsolvingTerminalReason } from '@dorkos/shared/run-outcome';
import { isInterruptedTerminalReason } from '@dorkos/shared/schemas';
const originalOpenCodeRoomStreams = new WeakMap<
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
/** Retire the original OpenCode Room responder stream and its captured lifecycle. */
export async function retireOpenCodeOriginalRoomResponderStream(stream: object): Promise<void> {
  const own = originalOpenCodeRoomStreams.get(stream);
  if (!own) return;
  originalOpenCodeRoomStreams.delete(stream);
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
/** Read evidence from the original OpenCode Room responder stream. */
export function readOpenCodeOriginalRoomResponderStream(
  runtime: object | undefined,
  stream: object,
  event?: StreamEvent
) {
  stream = readOriginalRegisteredNativeStream(stream) ?? stream;
  if (runtime) runtime = readOriginalRegisteredRuntime(runtime) ?? runtime;

  const own = originalOpenCodeRoomStreams.get(stream);
  if (!own) return undefined;
  if (
    (runtime !== undefined && own.runtime !== runtime) ||
    readOpenCodePreparedRoomResponder(own.runtime, own.prepared)?.nativeOperation !==
      own.operation ||
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
  captureOriginalRoomDispatchLifecycle,
  readOriginalRoomDispatchLifecycle,
} from '../../session/trigger-turn.js';
import type { OriginalRoomDispatchCustody } from '../../rooms/service/room-core.js';
import {
  readOriginalFrozenRoomTarget,
  requireOriginalRoomPrincipalService,
  requireOriginalCommittedRoomResponder,
  consumeOriginalCommittedRoomResponder,
  retireOriginalCommittedRoomResponder,
} from '../../canvas/doc-channel/operations/room-current-operation.js';
import type {
  OriginalFrozenRoomSource,
  PreparedRoomResponder,
  OriginalCommittedRoomResponder,
} from '../../canvas/doc-channel/current/current-operation-types.js';
import { openOriginalNativeTurn } from '../../connectors/principal/runtime-principal-service.js';
import { AccountsAccessContext } from '../shared/accounts-access-context.js';
/**
 * OpenCode Runtime — implements the AgentRuntime interface for OpenCode.
 *
 * One DorkOS session maps to one OpenCode session on the managed
 * `opencode serve` sidecar (ADR-0308), bound by {@link OpenCodeSessionMapper}.
 * A turn is trigger + stream: `session.promptAsync` (204; events ride SSE)
 * starts it, and the ONE per-runtime `client.global.event()` subscription
 * ({@link OpenCodeGlobalEventHub}) supplies raw wire events that are demuxed
 * per session with {@link matchesOpenCodeSession} — keyed on the OPENCODE
 * `ses_*` id and the directory AS STORED BY OPENCODE (`Session.directory`,
 * read back via `session.get`; never the DorkOS cwd, whose trailing-slash or
 * symlink drift would silently drop every event).
 *
 * Live turn state follows the Codex/test-mode pattern: `sendMessage` is a
 * pure StreamEvent producer (the platform's trigger-turn consumes it into the
 * per-session {@link SessionStateProjector}), and `subscribeSession` /
 * `getSessionSnapshot` are served from that projector. Unlike Codex, OpenCode
 * HAS a durable native store — listing and history delegate to the session
 * mapper (SDK reads against the sidecar), with the DorkOS-tracked settings
 * overlaid because OpenCode has no per-session permission mode of its own.
 *
 * Tool approvals are fully supported: the sidecar's ask-ruleset raises
 * `permission.asked` → `approval_required`, `approveTool()` answers through
 * `POST /session/{id}/permissions/{permissionID}` with `once`/`reject` (never
 * `always` — NOTES.md §2), mode enforcement auto-answers under
 * `acceptEdits`/`bypassPermissions`, and every forwarded request carries a
 * server-side auto-deny timer (see `messaging/approvals.ts`).
 *
 * @module services/runtimes/opencode/opencode-runtime
 */
import type { OpencodeClient, ProviderListResponse } from '@opencode-ai/sdk';
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
  AgentRuntime,
  DirectoryGrant,
  RuntimeCapabilities,
  DependencyCheck,
  SessionOpts,
  MessageOpts,
  CommandIntentOpts,
  SseResponse,
  SessionSettingsPort,
  ToolDecisionOptions,
  AgentRegistryPort,
  ManagedMcpServerResolver,
  SessionUpdateResult,
  TurnPermissionCeiling,
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
import { readLogBackedHistory } from '../../session/log-backed-history.js';
import { SessionDiscoveryUnavailableError } from '../../session/resolution/session-lookup-error.js';
import { overlayModelSubstitutions } from '../../session/overlays/model-substitution-overlay.js';
import { overlayAgentCompactions } from '../../session/overlays/agent-compaction-overlay.js';
import {
  SessionLockManager,
  captureNativeSessionAcquisition,
  captureNativeSessionActivity,
  readNativeSessionAcquisition,
  type NativeSessionAcquisition,
} from '../../session/session-lock.js';
import { DEFAULT_CWD } from '../../../lib/resolve-root.js';
import { homeOf, resolveAgentHome, turnAgentOf } from '../../core/agent-identity/index.js';
import { logger, logError } from '../../../lib/logger.js';
import { buildOpenCodeTurnContext } from './messaging/turn-context.js';
import {
  checkOpenCodeDependencies,
  getConnectedOpenCodeProvider,
} from './providers/check-dependencies.js';
import { detectOllama } from './providers/ollama.js';
import { fetchOpenRouterCatalog, type OpenRouterCatalog } from './providers/openrouter.js';
import {
  createOpenCodeEventContext,
  mapOpenCodeTurn,
  matchesOpenCodeSession,
  matchesOpenCodeSubagentSession,
  type OpenCodeWireEvent,
} from './events/event-mapper.js';
import { mapOpenCodeTodos } from './events/session-event-mapper.js';
import {
  OpenCodeSessionMapper,
  isDerivedOpenCodeSessionId,
  unwrap,
  type OpenCodeClientProvider,
  type OpenCodeSessionMapStore,
} from './sessions/session-mapper.js';
import { OpenCodeGlobalEventHub, TurnEventQueue } from './events/global-event-hub.js';
import { OpenCodeSessionRegistry, type OpenCodeSessionPatch } from './sessions/session-registry.js';
import {
  enforceApprovals,
  PendingApprovalStore,
  respondPermission,
  type ApprovalGateDeps,
  type ApprovalRouting,
} from './messaging/approvals.js';
import { OPENCODE_CAPABILITIES, STREAM_LIVE_TIMEOUT_MS } from './runtime-constants.js';
import { awaitAbortAck, awaitStreamLive } from './messaging/bounded-abort.js';
import {
  buildOpenCodeParts,
  buildOpenCodeSystem,
  parseModelSelection,
} from './messaging/turn-input.js';
import { resolveCompactionModel } from './messaging/compaction-model.js';
import { validatedGrants } from './messaging/directory-grants.js';
import { projectModelOptions, projectedProviderIds } from './providers/models.js';
import { OpenCodeContextWindows } from './providers/context-windows.js';
import { OpenCodeMcpManager } from './mcp/mcp-manager.js';
import { canonicalDirectory } from '@dorkos/shared/canonical-directory';
import { captureOpenCodeMedia } from './events/media-capture.js';
import type { SessionAttachmentStore } from '../../session/attachments/index.js';
import {
  connectorRuntimeHeaders,
  type ConnectorRuntimeMcpInjection,
  type ConnectorRuntimeTools,
} from '../connector-tools.js';
import type {
  OpenConnectorTurnResult,
  RevokeConnectorTurnReason,
} from '../../connectors/runtime-principal-port.js';
import { ConnectorTurnLeaseManager, type ConnectorTurnLease } from './mcp/connector-turn-lease.js';
import {
  OPENCODE_CREDITS_PROVIDER_ID,
  OPENCODE_LABEL,
  OPENCODE_OWN_PLAN,
  OpenCodeSwitchPendingError,
  creditsModelFor,
  openCodeRunsOnCredits,
  type OpenCodeSidecarPlan,
} from './credits-sidecar.js';
import {
  CreditsUnavailableError,
  asCreditsStopped,
  creditsRefusalEvent,
} from '../../core/cloud/credits-protocols.js';
import {
  catalogNameFor,
  decideCreditsLaunchModel,
  type CreditsModelDecision,
} from '../../core/cloud/credits-models.js';
import {
  ConnectorTurnLeaseSupervisor,
  type ConnectorTurnLeaseSupervisorHandle,
} from '../connectors/connector-turn-lease-supervisor.js';

/** Constructor dependencies for {@link OpenCodeRuntime} (composition root). */
export interface OpenCodeRuntimeOptions {
  /**
   * Sidecar client source — the `openCodeServerManager` singleton in
   * production, a mock in tests (the `opencode` binary is never required).
   */
  provider: OpenCodeClientProvider;
  /**
   * Durable sessionId <-> OpenCode-session-id store (`OpenCodeSessionMap`
   * over the shared Drizzle handle in production). Keeps DorkOS-facing ids
   * stable across server restarts (DOR-251); tests that don't exercise
   * persistence may omit it.
   */
  sessionMap?: OpenCodeSessionMapStore;
  /**
   * Where images this runtime's turns produce are stored (the local store over
   * the resolved data directory in production). Omitted, the runtime declares
   * `mediaOutput: 'none'` and says so per image rather than dropping one
   * quietly — see {@link OpenCodeRuntime.getCapabilities}.
   */
  attachments?: SessionAttachmentStore;
}

/** One in-flight turn (identity-matched on teardown, like Codex's controllers). */
// Only the original Room reader installs cancellation for its captured sidecar session.
const openCodeOriginalReadStops = new WeakMap<ActiveTurn, () => Promise<void>>();
interface ActiveTurn {
  ocSessionId: string;
  cwd: string;
  controller: AbortController;
  phase: 'waiting' | 'setup' | 'running';
  connectorBinding?: OpenConnectorTurnResult;
  connectorSupervisor?: ConnectorTurnLeaseSupervisorHandle;
  connectorRevocation?: Promise<void>;
}

/** One turn that has started and is not yet tracked as active. Identity-compared. */
interface SettingUpTurn {
  /** The session the turn belongs to. */
  sessionId: string;
}

/**
 * OpenCode runtime implementing the universal AgentRuntime interface.
 */
const nativeMapGet = Map.prototype.get;
const nativeMapSet = Map.prototype.set;
const nativeSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
type OpenCodeNativeEntry = {
  roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>;
  acquisition?: NativeSessionAcquisition;
  instance: object;
  active: Map<string, ActiveTurn>;
  key: string;
  entry: ActiveTurn;
  signal: AbortSignal;
  retired: boolean;
  runtime: 'opencode';
  agentPath: string | undefined;
  cwd: string;
  client: OpencodeClient;
};
const openCodeLockedRunners = new WeakMap<
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
export function sendOpenCodeOriginalLockedMessage(
  runtime: object,
  sessionId: string,
  content: string,
  opts: MessageOpts | undefined,
  holder: SseResponse,
  lockKey: string
): AsyncGenerator<StreamEvent> | undefined {
  return openCodeLockedRunners.get(runtime)?.(sessionId, content, opts, holder, lockKey);
}
const openCodeRoomPreparers = new WeakMap<
  object,
  (
    source: OriginalFrozenRoomSource,
    holder: SseResponse,
    key: string
  ) => Promise<PreparedRoomResponder | undefined>
>();
type OpenCodePreparedRoomContinuation = {
  prepared: PreparedRoomResponder;
  committed: OriginalCommittedRoomResponder;
  turn: ActiveTurn;
  nativeOperation: object;
  nativeEntry: OpenCodeNativeEntry;
  plan: OpenCodeSidecarPlan;
  client: OpencodeClient;
  directory: string;
  retire: () => Promise<void>;
};
const openCodeRoomPrepared = new WeakMap<
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
/** Fixed genuine setup may create a local sidecar session, but never sends a model prompt. */
export function prepareOpenCodeOriginalLockedRoomResponder(
  runtime: object,
  holder: SseResponse,
  key: string,
  source: OriginalFrozenRoomSource
): Promise<PreparedRoomResponder | undefined> {
  const prepare = openCodeRoomPreparers.get(runtime);
  if (!prepare) return Promise.resolve(undefined);
  return prepare(source, holder, key);
}
/** Exact original preparation retirement, before provider/revocation callbacks. */
export function retireOpenCodePreparedRoomResponder(
  runtime: object,
  prepared: PreparedRoomResponder
): Promise<void> {
  const own = openCodeRoomPrepared.get(prepared);
  if (!own || own.runtime !== runtime)
    throw new Error('Room responder preparation is not original.');
  openCodeRoomPrepared.delete(prepared);
  return own.retire();
}
/** Fixed lookup of one genuinely constructor-prepared entry; returned identities never register authority. */
export function readOpenCodePreparedRoomResponder(
  runtime: object,
  prepared: PreparedRoomResponder
) {
  const own = openCodeRoomPrepared.get(prepared);
  if (!own || own.runtime !== runtime) return undefined;
  const at = Date.now(),
    activity = captureNativeSessionActivity(own.acquisition, at);
  const native = readOpenCodeNativeOperation(own.nativeOperation);
  if (
    !activity ||
    !native ||
    native.acquisition !== own.acquisition ||
    !readNativeSessionAcquisition(own.acquisition, activity, at, native.canonicalSessionId) ||
    openCodeRoomPrepared.get(prepared) !== own ||
    !readOpenCodeNativeOperation(own.nativeOperation)
  )
    return undefined;
  return Object.freeze({
    source: own.source,
    nativeOperation: own.nativeOperation,
    acquisition: own.acquisition,
    native,
  });
}

/** Continue the same original setup only after its native COMMIT and private FIRST. */
export function startOpenCodeCommittedRoomResponder(
  runtime: object,
  prepared: PreparedRoomResponder,
  committed?: OriginalCommittedRoomResponder
): AsyncGenerator<StreamEvent> {
  const own = openCodeRoomPrepared.get(prepared);
  if (!own || own.runtime !== runtime)
    throw new Error('Room responder preparation is not original.');
  requireOriginalCommittedRoomResponder(committed, runtime, prepared, own.nativeOperation);
  return own.start(committed!);
}
const openCodeOriginalActiveSlots = new WeakMap<object, Map<string, ActiveTurn>>();
const openCodeNativeConstructors = new WeakSet<object>();
const openCodeNativeOperations = new WeakMap<object, OpenCodeNativeEntry>();
const openCodeNativeTurns = new WeakMap<ActiveTurn, OpenCodeNativeEntry>();
/** Fixed native lifetime read; retired entries cannot regain authority through map reinsertion. */
export function readOpenCodeNativeOperation(token: object) {
  const entry = openCodeNativeOperations.get(token);
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
    (!openCodeNativeConstructors.has(entry.instance) ||
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

/** Run OpenCode sessions with their original client and native turn lifetimes. */
export class OpenCodeRuntime implements AgentRuntime {
  readonly #roomPreparing = new Map<string, { retired: boolean }>();
  readonly type = 'opencode' as const;

  private readonly provider: OpenCodeClientProvider;
  /** Where a turn's images go, or `null` when the composition root wired none. */
  private readonly attachments: SessionAttachmentStore | null;
  private readonly mapper: OpenCodeSessionMapper;
  private readonly hub: OpenCodeGlobalEventHub;
  private readonly registry = new OpenCodeSessionRegistry();
  private readonly locks = new SessionLockManager();
  private readonly approvals = new PendingApprovalStore();
  /** What {@link enforceApprovals} reaches into on every mapped turn event. */
  private readonly approvalGate: ApprovalGateDeps;
  /** Each model's context window from the sidecar's catalog, read once and cached. */
  private readonly contextWindows = new OpenCodeContextWindows();
  /** One record per in-flight turn (interrupt target). */
  private readonly activeTurns = new Map<string, ActiveTurn>();
  /** Turns between their first step and being tracked in {@link activeTurns}. */
  private readonly settingUp = new Set<SettingUpTurn>();
  /** In-flight OpenCode session creations, deduped per DorkOS session id. */
  private readonly binding = new Map<string, Promise<string>>();
  /** OpenCode session id → its `Session.directory` (the demux key half). */
  private readonly directoryByOcId = new Map<string, string>();
  /** MCP status + managed injection, keyed by directory (DOR-893). */
  private readonly mcp: OpenCodeMcpManager;
  /** Per-directory serialization for turns that can reconcile session-bound connector state. */
  private readonly connectorLeases = new ConnectorTurnLeaseManager();
  /** Internal connector tool boundary, installed after boot opens its listener. */
  private connectorRuntimeTools: ConnectorRuntimeTools | undefined;
  private readonly accountsAccess = new AccountsAccessContext();
  private settingsPort: SessionSettingsPort | undefined;
  /**
   * The agent registry, when the composition root injected it. Used only to
   * decide whether a turn's working directory hosts a registered agent — the
   * gate on naming the DorkOS room tools in the prompt. The MCP manager holds
   * its own reference for the injection half; see {@link setMeshCore}.
   */
  private meshCore: AgentRegistryPort | undefined;

  constructor(options: OpenCodeRuntimeOptions) {
    openCodeNativeConstructors.add(this);
    openCodeOriginalActiveSlots.set(this, this.activeTurns);
    const originalLocks = this.locks;
    openCodeRoomPreparers.set(this, (source, holder, key) => {
      const target = readOriginalFrozenRoomTarget(source, 'opencode');
      const acquisition = captureNativeSessionAcquisition(originalLocks, key, holder);
      if (!acquisition || target.sessionId !== key) return Promise.resolve(undefined);
      return this.#prepareRoomResponder(source, target, acquisition);
    });
    openCodeLockedRunners.set(this, (sessionId, content, opts, holder, lockKey) => {
      const acquisition = captureNativeSessionAcquisition(originalLocks, lockKey, holder);
      if (!acquisition)
        throw new Error('Native turn requires its exact original session lock acquisition.');
      const custody = captureOriginalRoomDispatchLifecycle(holder, this);
      const roomOrigin = custody ? Object.freeze({ holder, custody }) : undefined;
      return this.#createMessage(sessionId, content, opts, acquisition, roomOrigin);
    });
    this.provider = options.provider;
    this.attachments = options.attachments ?? null;
    this.mapper = new OpenCodeSessionMapper(options.provider, options.sessionMap, this.attachments);
    this.hub = new OpenCodeGlobalEventHub(options.provider);
    this.mcp = new OpenCodeMcpManager(options.provider);
    this.approvalGate = {
      provider: options.provider,
      approvals: this.approvals,
      registry: this.registry,
    };
    // A switch between own sign-in and DorkOS credits restarts the sidecar,
    // so it waits while any turn here is running (ADR 261002-221210).
    this.provider.setBusyProbe?.(() => this.hasRunningTurns());
  }

  /** Install the internal connector tool boundary after its listener starts. */
  setConnectorRuntimeTools(tools: ConnectorRuntimeTools): void {
    this.connectorRuntimeTools = tools;
  }

  // --- Session lifecycle ---

  /**
   * @inheritdoc
   *
   * Tracks the session's settings and eagerly binds it to a real OpenCode
   * session (fire-and-forget) so it exists in the sidecar's store — and its
   * listing — before the first message. Bind failures are non-fatal here: the
   * first `sendMessage` retries the binding and surfaces real errors.
   */
  ensureSession(sessionId: string, opts: SessionOpts): void {
    this.registry.register(sessionId, {
      permissionMode: opts.permissionMode,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.fastMode !== undefined ? { fastMode: opts.fastMode } : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });
    if (opts.cwd !== undefined) {
      void this.resolveOpenCodeSession(sessionId, opts.cwd).catch((err: unknown) => {
        logger.debug(
          '[OpenCodeRuntime] eager session bind failed (will retry on first message)',
          logError(err)
        );
      });
    }
  }

  hasSession(sessionId: string): boolean {
    return this.registry.has(sessionId);
  }

  /** @inheritdoc A turn still setting up its sidecar counts: it is about to send. */
  isTurnOpen(sessionId: string): boolean {
    return (
      this.activeTurns.has(sessionId) ||
      [...this.settingUp].some((turn) => turn.sessionId === sessionId)
    );
  }

  /**
   * @inheritdoc
   *
   * OpenCode supports branching natively (`POST /session/{id}/fork`) — the
   * mapper forks the bound session and adopts the fork under a fresh derived
   * DorkOS id. Returns null when the source session has no OpenCode binding.
   */
  async forkSession(
    projectDir: string,
    sessionId: string,
    opts?: { upToMessageId?: string; title?: string }
  ): Promise<Session | null> {
    return this.mapper.forkSession(canonicalDirectory(projectDir), sessionId, opts);
  }

  /**
   * Whether a session's next turn runs on DorkOS credits: OpenCode's one
   * sidecar runs on credits or on the person's own providers for every session
   * at once, so this is its recorded default. Read by the model gate (DOR-2636).
   *
   * @param _sessionId - The session; every OpenCode session answers the same.
   */
  async sessionRunsOnCredits(_sessionId: string): Promise<boolean> {
    return openCodeRunsOnCredits();
  }

  /**
   * @inheritdoc
   *
   * Auto-creates untracked sessions (the PATCH-before-first-message path, and
   * every PATCH that follows a restart) through the shared hydration seam
   * {@link OpenCodeRuntime.registerWithPersisted}, so a change to ONE setting
   * keeps the persisted others, then writes the operator's choice through the
   * durable settings store (ADR-0260) so it survives the next restart too. The
   * new mode applies to the very next permission request — enforcement reads
   * the registry live.
   *
   * `effort` is part of the shared signature and is DROPPED here — not tracked,
   * not echoed, and not written to the durable store. OpenCode's prompt API has
   * no effort field, so a persisted value could only ever be read back out at
   * the person as a setting that does nothing; storing it would make "Not
   * supported by OpenCode" false in the one place that matters (spec
   * `execution-defaults` §4).
   */
  async updateSession(sessionId: string, opts: SessionSettings): Promise<SessionUpdateResult> {
    const { effort: _unsupported, ...storable } = opts;
    // Hydrate BEFORE the write-through, so the row this reads is the one that
    // stood before this PATCH: the settings it says nothing about are exactly
    // what has to be recovered, and the ones it names outrank them anyway.
    await this.registerWithPersisted(sessionId, storable);
    await this.settingsPort?.saveSessionSettings(sessionId, storable);
    return { updated: true };
  }

  /**
   * @inheritdoc
   *
   * The title persists in OpenCode's own store (`session.update`); the
   * registry copy keeps the live session list current immediately.
   */
  async renameSession(sessionId: string, title: string, projectDir: string): Promise<void> {
    this.registry.rename(sessionId, title);
    await this.mapper.renameSession(canonicalDirectory(projectDir), sessionId, title);
  }

  // --- Messaging ---

  /**
   * @inheritdoc
   *
   * Resolves the OpenCode session, subscribes a demux tap on the shared
   * global event stream, waits for the stream to be observably live, then
   * triggers the turn with `session.promptAsync` (204 — all delivery rides
   * the SSE stream) and yields the mapped events. {@link mapOpenCodeTurn}
   * guarantees exactly one terminal `done` on every path — completion,
   * failure (`session.error`), interrupt (`MessageAbortedError` → quiet
   * done), and mid-turn sidecar death (the hub fails the turn's queue, which
   * the mapper normalizes to a typed `error` + `done`).
   */
  sendMessage(sessionId: string, content: string, opts?: MessageOpts): AsyncGenerator<StreamEvent> {
    return this.#createMessage(sessionId, content, opts);
  }

  #createMessage(
    sessionId: string,
    content: string,
    opts: MessageOpts | undefined,
    acquisition?: NativeSessionAcquisition,
    roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>,
    roomPrepared?: OpenCodePreparedRoomContinuation
  ): AsyncGenerator<StreamEvent> {
    const lifetime: {
      closed: boolean;
      entered: boolean;
      retire?: () => void;
      acquisition?: NativeSessionAcquisition;
      roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>;
      roomPrepared?: OpenCodePreparedRoomContinuation;
    } = {
      closed: false,
      entered: false,
      acquisition,
      roomOrigin,
      roomPrepared,
      retire: roomPrepared
        ? () => {
            roomPrepared.nativeEntry.retired = true;
            roomPrepared.turn.controller.abort();
          }
        : undefined,
    };
    const stream = this.#sendOwnedMessage(sessionId, content, opts, lifetime);
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
          const own = originalOpenCodeRoomStreams.get(returned)!;
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
      originalOpenCodeLockedStreams.set(returned, {
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
      originalOpenCodeRoomStreams.set(returned, {
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
      roomPrepared?: OpenCodePreparedRoomContinuation;
    }
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
      let settings = await this.resolveTurnSettings(sessionId, opts);
      const cwd = opts?.cwd ?? this.registry.get(sessionId)?.cwd ?? DEFAULT_CWD;
      // Who a room turn is for, which every identity decision below is checked
      // against (DOR-2091). Absent on every turn a room did not trigger.
      const forAgent = turnAgentOf(opts);
      // **Which model a credits turn runs** (DOR-2636), the same decision every
      // runtime on credits makes: once the service says which formats its models
      // are in, a model it does not serve in OpenCode's chat format runs on the
      // service's suggestion, said once and saved only once said, and a list
      // naming none refuses the turn. While the service says nothing, the
      // session's model stands and the sidecar's own fallback applies, as before.
      if (openCodeRunsOnCredits()) {
        let decided: CreditsModelDecision;
        try {
          decided = await decideCreditsLaunchModel({
            capabilities: this.getCapabilities(),
            runtimeLabel: OPENCODE_LABEL,
            sessionId,
            model: creditsModelIdOf(settings.model),
            nameOf: async () =>
              settings.model === undefined ? undefined : catalogNameFor(this, settings.model),
            remember: async (id) => {
              await this.updateSession(sessionId, { model: creditsSelection(id) });
            },
          });
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
        if (decided.model !== undefined && decided.model !== creditsModelIdOf(settings.model)) {
          settings = { ...settings, model: creditsSelection(decided.model) };
        }
        if (decided.swap?.notice) yield decided.swap.notice;
        await decided.swap?.commit();
      }
      this.registry.recordMessage(sessionId, content, {
        cwd,
        ...(opts?.title !== undefined ? { title: opts.title } : {}),
      });

      yield* this.runOpenCodeTurn(
        sessionId,
        cwd,
        opts?.title,
        async (client, ocSessionId, dorkosApplied, connectionsApplied, plan) => {
          // Build the prompt only after the leased MCP reconcile, so the room
          // verbs describe what this exact turn can actually call.
          // The agent this turn acts as — anchored, so a room worktree reads as its
          // agent and a room turn as nobody but the agent it is for (DOR-2091).
          const agentPath = homeOf(resolveAgentHome(cwd, forAgent));
          const agentContext = await buildOpenCodeTurnContext(cwd, dorkosApplied, agentPath);
          // On credits the prompt always names the credits provider: the
          // session's model when it is a credits model, else the default one.
          const model =
            plan.mode === 'credits'
              ? creditsPromptModel(settings.model, plan)
              : parseModelSelection(settings.model);
          const agent = agentPath ? this.meshCore?.getByPath(agentPath) : undefined;
          const accessContext =
            connectionsApplied && this.connectorRuntimeTools && agent
              ? await this.accountsAccess.select(this.connectorRuntimeTools, agent.id, sessionId, {
                  serviceCatalog: dorkosApplied,
                })
              : undefined;
          const turnOpts = accessContext
            ? {
                ...opts,
                additionalContext: [...(opts?.additionalContext ?? []), accessContext.entry],
              }
            : opts;
          const system = buildOpenCodeSystem(turnOpts, agentContext);
          const sessionApi = client.session;
          const promptAsync = sessionApi.promptAsync;
          const promptInput = {
            path: { id: ocSessionId },
            body: {
              parts: buildOpenCodeParts(content, turnOpts),
              ...(system !== undefined ? { system } : {}),
              ...(model !== undefined ? { model } : {}),
            },
          };
          if (lifetime.roomPrepared) {
            const prepared = lifetime.roomPrepared;
            consumeOriginalCommittedRoomResponder(
              prepared.committed,
              this,
              prepared.prepared,
              prepared.nativeOperation
            );
          }
          const prompted = await promptAsync.call(sessionApi, promptInput);
          const promptError = 'error' in prompted ? prompted.error : undefined;
          if (promptError === undefined) accessContext?.commit();
          if (promptError !== undefined) {
            throw new Error(`OpenCode session.promptAsync failed: ${JSON.stringify(promptError)}`);
          }
        },
        {
          connectorTurn: true,
          lifetime,
          ...(forAgent !== undefined ? { forAgent } : {}),
          grants: validatedGrants(opts?.additionalDirectories, cwd),
          ...(opts?.permissionCeiling !== undefined
            ? { permissionCeiling: opts.permissionCeiling }
            : {}),
        }
      );
    } catch (cause) {
      failed = true;
      first = cause;
    } finally {
      await drainOriginalCleanup();
    }
  }

  /**
   * Fulfill the runtime-fulfilled `compact` intent (ADR-0273) by triggering
   * OpenCode's native sidecar compaction — `client.session.summarize` carrying
   * the `{providerID, modelID}` body the sidecar requires (DOR-1668; see
   * {@link resolveCompactionModel} for why the SDK types that body as optional
   * while the server rejects its absence, and for how the model is chosen).
   * OpenCode reports the result out-of-band as `session.compacted`, which the
   * shared per-turn demux tap ({@link runOpenCodeTurn}) maps to
   * `operation_progress` done + `compact_boundary` (event-mapper.ts) and
   * {@link mapOpenCodeTurn} terminates on the trailing `session.idle`. Driving
   * it through the same turn path is REQUIRED, not optional: there is no
   * standing hub→projector subscription outside a turn, so the boundary reaches
   * the durable projector only because this generator yields it. The
   * `@opencode-ai/sdk` import stays confined to this directory (Hard Rule 2).
   * `OPENCODE_CAPABILITIES.commandIntents` gates the route before this is ever
   * called.
   */
  async *executeCommandIntent(
    sessionId: string,
    _intent: RuntimeCommandIntentId,
    opts?: CommandIntentOpts
  ): AsyncGenerator<StreamEvent> {
    // NOTE: `opts.instructions` is deliberately ignored — `session.summarize`
    // takes no instruction parameter, so OpenCode compaction cannot be guided.
    // An honest per-runtime difference (claude-code forwards instructions).
    //
    // Settings are resolved the same way a prompt resolves them (registry →
    // persisted store), because the model DorkOS would run the next TURN on is
    // the first rung of the compaction model ladder.
    const settings = await this.resolveTurnSettings(sessionId, opts);
    const cwd = opts?.cwd ?? this.registry.get(sessionId)?.cwd ?? DEFAULT_CWD;
    yield* this.runOpenCodeTurn(
      sessionId,
      cwd,
      undefined,
      async (client, ocSessionId, _d, _c, plan) => {
        const model =
          plan.mode === 'credits'
            ? creditsPromptModel(settings.model, plan)
            : await resolveCompactionModel(client, {
                ocSessionId,
                cwd,
                trackedModel: settings.model,
              });
        const summarized = await client.session.summarize({
          path: { id: ocSessionId },
          body: model,
        });
        if (summarized.error !== undefined) {
          throw new Error(`OpenCode session.summarize failed: ${JSON.stringify(summarized.error)}`);
        }
      }
    );
  }

  /**
   * Whether any OpenCode turn is running now. Switching OpenCode between its
   * own sign-in and DorkOS credits restarts its one process, so the switch is
   * refused while this is true (ADR 261002-221210).
   */
  hasRunningTurns(): boolean {
    return this.activeTurns.size > 0 || this.settingUp.size > 0;
  }

  /**
   * What the sidecar runs this turn on, made so before anything is sent.
   *
   * @param sessionId - The session about to send.
   * @param own - This turn's own setting-up marker, which is not "another".
   * @throws {CreditsUnavailableError} On credits, when credits cannot pay.
   */
  private async prepareSidecar(
    sessionId: string,
    own: SettingUpTurn
  ): Promise<OpenCodeSidecarPlan> {
    const othersActive =
      [...this.activeTurns.keys()].some((id) => id !== sessionId) ||
      [...this.settingUp].some((other) => other !== own && other.sessionId !== sessionId);
    if (this.provider.prepareTurn) return this.provider.prepareTurn(othersActive);
    // A provider that cannot be made right for credits never runs a turn the
    // person set to credits: refused, not sent on whatever it holds.
    if (openCodeRunsOnCredits()) throw new CreditsUnavailableError('not-supported', OPENCODE_LABEL);
    return OPENCODE_OWN_PLAN;
  }

  /**
   * Drive one OpenCode turn end to end: resolve the session + its demux key,
   * subscribe a per-turn tap on the ONE shared global event stream, wait for it
   * to be observably live, fire `trigger` (a prompt or a compaction), then yield
   * the mapped events with permission enforcement. {@link mapOpenCodeTurn}
   * guarantees exactly one terminal `done`, and teardown is identity-guarded so a
   * stale turn racing a newer one never clears the newer turn's shared state.
   * Shared by {@link sendMessage} (prompt) and {@link executeCommandIntent}
   * (compact) so both ride the identical trigger → demux → map lifecycle.
   *
   * @param sessionId - DorkOS session id.
   * @param cwd - Working directory used to resolve the client and session.
   * @param title - Optional title used only when a new OpenCode session is created.
   * @param trigger - Fires the turn after MCP registration settles, receiving
   *   whether the room-tool server was actually applied.
   * @param opts - Marks a model prompt that receives connector runtime tools,
   *   and names the agent a room turn is for (DOR-2091).
   */
  async #resolveNativeClient(
    sessionId: string,
    cwd: string,
    title?: string,
    pending?: { retired: boolean }
  ) {
    if (pending?.retired) throw new Error('Room responder preparation retired.');
    const ocSessionId = await this.resolveOpenCodeSession(sessionId, cwd, title);
    if (pending?.retired) throw new Error('Room responder preparation retired.');
    const client = await this.provider.getClient(cwd);
    if (pending?.retired) throw new Error('Room responder preparation retired.');
    const directory = await this.resolveSessionDirectory(client, ocSessionId);
    if (pending?.retired) throw new Error('Room responder preparation retired.');
    return { ocSessionId, client, directory };
  }
  #installNativeTurn(
    sessionId: string,
    directory: string,
    client: OpencodeClient,
    turn: ActiveTurn,
    acquisition?: NativeSessionAcquisition,
    refuseExisting = false,
    roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>
  ) {
    if (
      roomOrigin &&
      readOriginalRoomDispatchLifecycle(roomOrigin.holder, this) !== roomOrigin.custody
    )
      throw new Error('Original Room dispatch lifetime is retired.');
    const controller = turn.controller;
    const active = openCodeOriginalActiveSlots.get(this),
      slot = Object.getOwnPropertyDescriptor(this, 'activeTurns');
    if (!active || !slot || !('value' in slot) || slot.value !== active)
      throw new Error('Native preparation requires its original active slot.');
    if (refuseExisting && nativeMapGet.call(active, sessionId))
      throw new Error('Native preparation cannot replace a live entry.');
    nativeMapSet.call(active, sessionId, turn);
    const nativeOperation = Object.freeze({});
    if (!openCodeNativeConstructors.has(this))
      throw new Error('Native runtime operation requires its genuine constructor.');
    const nativeEntry = {
      roomOrigin,
      acquisition: acquisition,
      instance: this,
      active,
      key: sessionId,
      entry: turn,
      signal: controller.signal,
      retired: false,
      runtime: 'opencode' as const,
      cwd: directory,
      client,
      agentPath: undefined as string | undefined,
    };
    openCodeNativeOperations.set(nativeOperation, nativeEntry);
    openCodeNativeTurns.set(turn, nativeEntry);
    return { nativeOperation, nativeEntry };
  }
  async #prepareRoomResponder(
    source: OriginalFrozenRoomSource,
    target: Readonly<{ sessionId: string; agentPath: string; agentId: string }>,
    acquisition: NativeSessionAcquisition
  ): Promise<PreparedRoomResponder | undefined> {
    const { sessionId, agentPath } = target,
      tools = this.connectorRuntimeTools;
    if (
      !tools ||
      nativeMapGet.call(openCodeOriginalActiveSlots.get(this)!, sessionId) ||
      [...this.settingUp].some((value) => value.sessionId === sessionId)
    )
      return undefined;
    requireOriginalRoomPrincipalService(source, tools.principals);
    if (
      homeOf(resolveAgentHome(agentPath, agentPath)) !== agentPath ||
      this.meshCore?.getByPath(agentPath)?.id !== target.agentId
    )
      throw new Error('Room responder differs from its approved target.');
    const pending = { retired: false };
    this.#roomPreparing.set(sessionId, pending);
    const settingUp = { sessionId };
    this.settingUp.add(settingUp);
    let preparedNative: { turn: ActiveTurn; nativeEntry: OpenCodeNativeEntry } | undefined;
    const provider = this.provider;
    let turnSettled: typeof provider.turnSettled | undefined;
    let providerSettlement: Promise<void> | undefined;
    const settleProvider = (): Promise<void> => {
      providerSettlement ??= Promise.resolve().then(() =>
        turnSettled ? Reflect.apply(turnSettled, provider, []) : undefined
      );
      return providerSettlement;
    };
    try {
      turnSettled = provider.turnSettled;
      const plan = await this.prepareSidecar(sessionId, settingUp);
      if (pending.retired) throw new Error('Room responder preparation retired.');
      const { ocSessionId, client, directory } = await this.#resolveNativeClient(
        sessionId,
        agentPath,
        undefined,
        pending
      );
      if (pending.retired) throw new Error('Room responder preparation retired.');
      const controller = new AbortController();
      const turn: ActiveTurn = { ocSessionId, cwd: agentPath, controller, phase: 'setup' };
      const { nativeOperation, nativeEntry } = this.#installNativeTurn(
        sessionId,
        directory,
        client,
        turn,
        acquisition,
        true
      );
      preparedNative = { turn, nativeEntry };
      nativeEntry.agentPath = agentPath;
      this.settingUp.delete(settingUp);
      turn.connectorBinding = await openOriginalNativeTurn(
        tools.principals,
        {
          runtime: 'opencode',
          canonicalSessionId: sessionId,
          agentPath,
          canonicalCwd: directory,
          signal: controller.signal,
        },
        nativeOperation
      );
      controller.signal.throwIfAborted();
      const at = Date.now(),
        activity = captureNativeSessionActivity(acquisition, at);
      if (
        !activity ||
        !readNativeSessionAcquisition(acquisition, activity, at, sessionId) ||
        !readOpenCodeNativeOperation(nativeOperation)
      )
        throw new Error('Room responder retired during preparation.');
      let retirement: Promise<void> | undefined;
      const retire = (): Promise<void> => {
        if (retirement) return retirement;
        let resolve!: () => void, reject!: (cause: unknown) => void;
        retirement = new Promise<void>((done, refused) => {
          resolve = done;
          reject = refused;
        });
        const stopRead = openCodeOriginalReadStops.get(turn);
        nativeEntry.retired = true;
        let failed = false,
          firstCause: unknown;
        const remember = (cause: unknown) => {
          if (!failed) {
            failed = true;
            firstCause = cause;
          }
        };
        try {
          if (this.activeTurns.get(sessionId) === turn) this.activeTurns.delete(sessionId);
        } catch (cause) {
          remember(cause);
        }
        try {
          controller.abort();
        } catch (cause) {
          remember(cause);
        }
        let readDrain: Promise<void> | undefined;
        try {
          readDrain = stopRead?.().catch(remember);
        } catch (cause) {
          remember(cause);
        }
        void (async () => {
          try {
            await this.revokeConnectorTurn(turn, 'turn_cancelled');
          } catch (cause) {
            remember(cause);
          }
          try {
            await readDrain;
          } catch (cause) {
            remember(cause);
          }
          try {
            await settleProvider();
          } catch (cause) {
            remember(cause);
          }
          if (failed) throw firstCause;
        })().then(resolve, reject);
        return retirement;
      };
      const prepared: PreparedRoomResponder = Object.freeze({ kind: 'prepared-room-responder' });
      openCodeRoomPrepared.set(prepared, {
        runtime: this,
        retire,
        source,
        nativeOperation,
        acquisition,
        start: (() => {
          let started = false;
          return (committed: OriginalCommittedRoomResponder) => {
            if (started || !readOpenCodePreparedRoomResponder(this, prepared))
              throw new Error('Room prepared entry cannot start twice or after retirement.');
            started = true;
            return this.#createMessage(
              sessionId,
              'Document update',
              { cwd: agentPath },
              acquisition,
              undefined,
              {
                prepared,
                committed,
                turn,
                nativeOperation,
                nativeEntry,
                plan,
                client,
                directory,
                retire,
              }
            );
          };
        })(),
      });
      if (this.#roomPreparing.get(sessionId) === pending) this.#roomPreparing.delete(sessionId);
      return prepared;
    } catch (cause) {
      pending.retired = true;
      if (this.#roomPreparing.get(sessionId) === pending) this.#roomPreparing.delete(sessionId);
      this.settingUp.delete(settingUp);
      if (preparedNative) {
        const { turn, nativeEntry } = preparedNative;
        nativeEntry.retired = true;
        try {
          if (this.activeTurns.get(sessionId) === turn) this.activeTurns.delete(sessionId);
        } catch {}
        try {
          turn.controller.abort();
        } catch {}
        try {
          await this.revokeConnectorTurn(turn, 'setup_failed');
        } catch {}
      }
      try {
        await settleProvider();
      } catch {}
      throw cause;
    }
  }

  private async *runOpenCodeTurn(
    sessionId: string,
    cwd: string,
    title: string | undefined,
    trigger: (
      client: OpencodeClient,
      ocSessionId: string,
      dorkosApplied: boolean,
      connectionsApplied: boolean,
      plan: OpenCodeSidecarPlan
    ) => Promise<void>,
    opts?: {
      connectorTurn?: boolean;
      forAgent?: string;
      grants?: readonly DirectoryGrant[];
      permissionCeiling?: TurnPermissionCeiling;
      lifetime?: {
        closed: boolean;
        retire?: () => void;
        acquisition?: NativeSessionAcquisition;
        roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>;
        roomPrepared?: OpenCodePreparedRoomContinuation;
      };
    }
  ): AsyncGenerator<StreamEvent> {
    // **Who pays** (ADR 261001-000811), decided before anything is sent: the
    // sidecar is made right for OpenCode's recorded choice, and a credits turn
    // that credits cannot pay for is REFUSED here, with nothing sent.
    // Counted as running from here, before the sidecar is prepared: a switch
    // between own sign-in and credits must not restart the sidecar under a
    // turn that is still setting up. Released once the turn is tracked as
    // active below, or when it ends before that.
    const settingUp: SettingUpTurn = { sessionId };
    this.settingUp.add(settingUp);
    const originalPrepared = opts?.lifetime?.roomPrepared;
    let plan: OpenCodeSidecarPlan;
    let ocSessionId: string;
    let client: OpencodeClient;
    let directory: string;
    if (originalPrepared) {
      plan = originalPrepared.plan;
      ocSessionId = originalPrepared.turn.ocSessionId;
      client = originalPrepared.client;
      directory = originalPrepared.directory;
    } else {
      try {
        plan = await this.prepareSidecar(sessionId, settingUp);
      } catch (err) {
        this.settingUp.delete(settingUp);
        void this.provider.turnSettled?.().catch(() => undefined);
        if (err instanceof OpenCodeSwitchPendingError) {
          yield {
            type: 'error',
            data: { message: err.message, code: err.code, category: 'execution_error' },
          };
          return;
        }
        const refusal = creditsRefusalEvent(err);
        if (!refusal) throw err;
        yield refusal;
        return;
      }
      try {
        ({ ocSessionId, client, directory } = await this.#resolveNativeClient(
          sessionId,
          cwd,
          title
        ));
      } catch (err) {
        this.settingUp.delete(settingUp);
        void this.provider.turnSettled?.().catch(() => undefined);
        throw err;
      }
    }

    if (opts?.lifetime?.closed) {
      this.settingUp.delete(settingUp);
      return;
    }
    const controller = originalPrepared?.turn.controller ?? new AbortController();
    const turn: ActiveTurn = originalPrepared?.turn ?? {
      ocSessionId,
      cwd,
      controller,
      phase: this.connectorRuntimeTools ? 'waiting' : 'setup',
    };
    const { nativeOperation, nativeEntry } =
      originalPrepared ??
      this.#installNativeTurn(
        sessionId,
        directory,
        client,
        turn,
        opts?.lifetime?.acquisition,
        false,
        opts?.lifetime?.roomOrigin
      );
    if (opts?.lifetime)
      opts.lifetime.retire = () => {
        nativeEntry.retired = true;
      };
    this.settingUp.delete(settingUp);
    let lease: ConnectorTurnLease | undefined;
    let connectorInjection: ConnectorRuntimeMcpInjection | undefined;
    let connectorRevokeReason: RevokeConnectorTurnReason = 'setup_failed';
    let subscription: ReturnType<OpenCodeGlobalEventHub['subscribe']> | undefined;
    let stopQueueRead: (() => void) | undefined;

    let sourceFailed = false,
      sourceCause: unknown;

    // Join this scope to its captured cleanup before returning or reporting failure.
    const drainOriginalCleanup = async () => {
      if (stopQueueRead) controller.signal.removeEventListener('abort', stopQueueRead);
      openCodeOriginalReadStops.delete(turn);
      nativeEntry.retired = true;
      if (originalPrepared) {
        const cleanup = async (work: () => unknown | Promise<unknown>) => {
          try {
            await work();
          } catch (cause) {
            if (!sourceFailed) {
              sourceFailed = true;
              sourceCause = cause;
            }
          }
        };
        await cleanup(() => turn.connectorSupervisor?.stop());
        // The outer original prepared owner performs the one genuine durable revoke.
        await cleanup(() => lease?.release());
        await cleanup(() => subscription?.unsubscribe());
        if (this.activeTurns.get(sessionId) === turn) {
          await cleanup(() => this.approvals.clearSession(sessionId));
          this.activeTurns.delete(sessionId);
        }
        // The outer original prepared retirement owns provider settlement once,
        // even when genuine durable revocation rejects before it.
        if (sourceFailed) throw sourceCause;
      } else {
        if (controller.signal.aborted) connectorRevokeReason = 'turn_cancelled';
        turn.connectorSupervisor?.stop();
        try {
          await this.revokeConnectorTurn(turn, connectorRevokeReason);
        } catch (err) {
          // The principal port invalidates the bearer in-process before a durable
          // write can reject. Contain persistence failure here so the terminal
          // stream still settles and the safely tombstoned directory can hand off.
          logger.warn('[OpenCodeRuntime] connector revocation persistence failed at teardown', {
            sessionId,
            ...logError(err),
          });
        } finally {
          lease?.release();
          subscription?.unsubscribe();
          // Identity guard: only the session's ACTIVE turn may tear down shared
          // per-session state. A stale turn racing a newer one must clear neither
          // the newer turn's record nor its pending approvals — unconditionally
          // clearing would disarm the newer turn's auto-deny timers and dead-end
          // its approveTool() calls.
          if (this.activeTurns.get(sessionId) === turn) {
            this.approvals.clearSession(sessionId);
            this.activeTurns.delete(sessionId);
          }
          // A Runs on switch that waited for running turns may happen now.
          void this.provider.turnSettled?.().catch((err) => {
            logger.warn(
              '[OpenCodeRuntime] could not apply the waiting Runs on switch',
              logError(err)
            );
          });
        }
      }
    };
    try {
      // Once connector tools are installed, every path below can reconcile a
      // directory map that contains session-bound connector state. Hold the
      // same canonical-directory lease for the whole turn so an unbound path
      // such as compaction cannot remove or replace another live turn's
      // registration. There is exactly one acquisition per turn, which also
      // keeps waiting visible and cancellable. Installs without connector tools
      // retain the runtime's established same-session overlap behavior.
      if (this.connectorRuntimeTools) {
        lease = await this.connectorLeases.acquire(directory, controller.signal);
        turn.phase = 'setup';
      }

      // Whose identity this turn carries: the directory's own agent, or the one
      // a room worktree was handed to — never by prefix, and never another agent
      // than the room turn names (DOR-2091, `agent-home.ts`). A worktree
      // looked up exactly hosts nobody, which is how opencode agents in a room
      // with files used to get no `dorkos` server at all.
      const agentPath = homeOf(resolveAgentHome(cwd, opts?.forAgent));
      const meshAgent =
        opts?.connectorTurn && agentPath ? this.meshCore?.getByPath(agentPath) : undefined;
      nativeEntry.agentPath = agentPath;
      if (this.connectorRuntimeTools && meshAgent && agentPath) {
        turn.connectorBinding =
          turn.connectorBinding ??
          (await this.connectorRuntimeTools.principals.openTurn(
            {
              runtime: this.type,
              canonicalSessionId: sessionId,
              agentPath,
              canonicalCwd: directory,
              signal: controller.signal,
            },
            { isCurrent: () => this.activeTurns.get(sessionId) === turn, nativeOperation }
          ));
        controller.signal.throwIfAborted();
        connectorInjection = {
          url: this.connectorRuntimeTools.listenerUrl,
          agentToolsUrl: this.connectorRuntimeTools.agentToolsUrl,
          headers: connectorRuntimeHeaders({
            bearer: turn.connectorBinding.bearer,
            runtime: this.type,
            canonicalCwd: directory,
          }),
        };
      }

      // Registration and the lease use the sidecar's canonical directory. The
      // anchored agent path is the agent lookup key — the original cwd when it
      // anchors to itself, which also covers symlinks that differ — and `null`
      // when the turn anchors to nobody, so a refused turn standing in another
      // agent's folder is given none of that agent's servers.
      const mcpResult = await this.mcp.ensureManaged(
        client,
        directory,
        connectorInjection,
        agentPath ?? null
      );
      if (connectorInjection && !mcpResult.connectorApplied) {
        if (originalPrepared) {
          await originalPrepared.retire();
          throw new Error('Original prepared connector setup refused.');
        }
        await this.revokeConnectorTurn(turn, 'setup_failed');
      } else if (turn.connectorBinding && this.connectorRuntimeTools) {
        const createSupervisor =
          this.connectorRuntimeTools.createLeaseSupervisor ??
          ((options) => new ConnectorTurnLeaseSupervisor(options));
        turn.connectorSupervisor = createSupervisor({
          principals: this.connectorRuntimeTools.principals,
          bindingId: turn.connectorBinding.bindingId,
          permit: turn.connectorBinding.renewalPermit,
          runtime: this.type,
          expiresAt: turn.connectorBinding.expiresAt,
          signal: controller.signal,
          onLost: (loss) => logger.warn('[OpenCodeRuntime] Connections lease lost', loss),
        });
      }
      controller.signal.throwIfAborted();

      const ctx = createOpenCodeEventContext(sessionId);
      // Read the model catalog now, so the reply's context reading finds its
      // window ready rather than waiting on it (bounded either way).
      this.contextWindows.prefetch(client, directory);
      const queue = new TurnEventQueue<OpenCodeWireEvent>();
      if (originalPrepared) {
        stopQueueRead = () => queue.fail(controller.signal.reason);
        controller.signal.addEventListener('abort', stopQueueRead, { once: true });
        if (controller.signal.aborted) stopQueueRead();
        openCodeOriginalReadStops.set(turn, async () => {
          const stopped = unwrap(
            await client.session.abort({ path: { id: ocSessionId } }),
            'session.abort'
          );
          if (stopped !== true) throw new Error('Original Room sidecar abort unconfirmed.');
        });
      }
      subscription = this.hub.subscribe({
        cwd,
        onEvent: (event) => {
          // The turn's own session, plus any child session a `task` tool part has
          // revealed — that is how a subagent's activity reaches its parent card.
          const admit =
            matchesOpenCodeSession(event, directory, ocSessionId) ||
            matchesOpenCodeSubagentSession(event, directory, ctx);
          if (admit) queue.push(event.payload as OpenCodeWireEvent);
        },
        onStreamDrop: (error) => queue.fail(error),
      });

      turn.phase = 'running';
      connectorRevokeReason = 'runtime_failed';
      let sawRuntimeError = false;
      // Trigger only once the stream is observably live (or the bounded wait
      // elapses) — a fast turn must not complete before we can see its idle.
      await awaitStreamLive(subscription.live, STREAM_LIVE_TIMEOUT_MS);

      controller.signal.throwIfAborted();
      await trigger(client, ocSessionId, mcpResult.dorkosApplied, mcpResult.connectorApplied, plan);

      const routing: ApprovalRouting = {
        sessionId,
        ocSessionId,
        cwd,
        permissions: ctx,
        ...(opts?.grants ? { grants: opts.grants } : {}),
        ...(opts?.permissionCeiling !== undefined
          ? { permissionCeiling: opts.permissionCeiling }
          : {}),
      };
      for await (const mapped of mapOpenCodeTurn(queue, ctx)) {
        // On credits, a refused token is the credits card, never an OpenCode
        // sign-in error: the person's own sign-in was not used.
        const event = await this.withContextWindow(
          client,
          directory,
          ctx.providerId,
          plan.mode === 'credits' ? asCreditsStopped(mapped, OPENCODE_LABEL) : mapped
        );
        if (event.type === 'error') sawRuntimeError = true;
        yield* enforceApprovals(this.approvalGate, routing, event);
        // The async half of media mapping. `mapOpenCodeTurn` is pure and cannot
        // store bytes, so it records what it saw on `ctx` and this drains it
        // here — after the event it rode in on, so an image lands in the
        // transcript exactly where the tool result that produced it did.
        yield* captureOpenCodeMedia(this.attachments, sessionId, ctx);
      }
      connectorRevokeReason = sawRuntimeError ? 'runtime_failed' : 'turn_terminal';
    } catch (cause) {
      if (!originalPrepared) throw cause;
      sourceFailed = true;
      sourceCause = cause;
    } finally {
      await drainOriginalCleanup();
    }
  }

  /**
   * Add the model's context window to a reply's context reading, so the
   * reading says how full the conversation is (DOR-2732). OpenCode's own
   * usage event names the model but not its window; the sidecar's catalog
   * does ({@link OpenCodeContextWindows}, cached per directory, waited on for
   * at most `CONTEXT_WINDOW_READ_TIMEOUT_MS`). A model the catalog gives no
   * window for, or a catalog that does not answer in time, leaves the reading
   * without one.
   *
   * @param client - The sidecar client the turn runs on.
   * @param directory - The session's directory, for the catalog read.
   * @param providerId - The reply's provider, as the mapper recorded it.
   * @param event - One mapped event; only a context reading is touched.
   */
  private async withContextWindow(
    client: OpencodeClient,
    directory: string,
    providerId: string | undefined,
    event: StreamEvent
  ): Promise<StreamEvent> {
    if (event.type !== 'session_status') return event;
    const data = event.data as Record<string, unknown>;
    if (data.contextTokens === undefined || data.contextMaxTokens !== undefined) return event;
    const window = await this.contextWindows.lookup(
      client,
      directory,
      providerId,
      typeof data.model === 'string' ? data.model : undefined
    );
    return window === undefined
      ? event
      : ({ ...event, data: { ...data, contextMaxTokens: window } } as StreamEvent);
  }

  /**
   * Register a session's settings, hydrating the durable row (ADR-0260) under
   * the caller's own fields when the runtime has no memory of the session.
   * Precedence: explicit → persisted, and for `permissionMode` alone a runtime
   * default beneath both — a session always runs under SOME mode, while an
   * unstated model or fastMode is honestly just absent (the sidecar's own
   * default model, no fast mode) rather than a value this could invent.
   *
   * The ONE hydration seam, shared by the two cold entry points that need it —
   * {@link OpenCodeRuntime.updateSession} and
   * {@link OpenCodeRuntime.resolveTurnSettings} — because a session loses its
   * in-memory state on every restart and EITHER a message or a settings PATCH
   * can be the first thing to arrive afterwards. Registering only the fields a
   * caller happened to name would drop the row's siblings — a PATCH that picks
   * a model would reset an enforced `bypassPermissions` session to `default`
   * while the stored settings (and the app, reading them) kept showing the
   * operator's real choice (DOR-1152; the claude-code twin is DOR-1151).
   *
   * {@link OpenCodeRuntime.ensureSession} is a third cold path and deliberately
   * does NOT come through here: `SessionOpts.permissionMode` is REQUIRED by the
   * shared contract — "callers resolve the effective mode (per-send override →
   * persisted → runtime default) before creating" (`SessionOpts`,
   * `agent-runtime.ts`) — and its real callers do exactly that, the scheduler
   * from the task's own mode and the relay from the binding's, on an id it mints
   * one line earlier that no stored row can describe yet. Reading the store
   * there would re-derive an answer the caller had already given, or invent one
   * for a session that has no history.
   *
   * A session already tracked in memory reads nothing: its registration is the
   * live truth, and only the stated fields change.
   *
   * @param sessionId - DorkOS session id.
   * @param explicit - The fields this caller states, which outrank the stored ones.
   */
  private async registerWithPersisted(
    sessionId: string,
    explicit: OpenCodeSessionPatch = {}
  ): Promise<void> {
    const tracked = this.registry.has(sessionId);
    const persisted = tracked ? null : await this.settingsPort?.getSessionSettings(sessionId);
    // A tracked session keeps the mode it is running under unless this call
    // names one; a cold one is born with the persisted mode, or the default.
    const permissionMode = tracked
      ? explicit.permissionMode
      : (explicit.permissionMode ?? persisted?.permissionMode ?? 'default');
    const model = explicit.model ?? persisted?.model;
    const fastMode = explicit.fastMode ?? persisted?.fastMode;
    this.registry.register(sessionId, {
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(fastMode !== undefined ? { fastMode } : {}),
      ...(explicit.cwd !== undefined ? { cwd: explicit.cwd } : {}),
    });
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
      // Only the mode and cwd are stated here. A per-send `model`/`fastMode` is
      // a transient override for THIS turn (Tasks, relay) — it is applied to
      // the returned settings below and deliberately never tracked, so the
      // session keeps running on the operator's own choice afterwards.
      await this.registerWithPersisted(sessionId, {
        permissionMode: opts?.permissionMode,
        cwd: opts?.cwd,
      });
    }
    const tracked = this.registry.get(sessionId)!;
    const model = opts?.model ?? tracked.model;
    const fastMode = opts?.fastMode ?? tracked.fastMode;
    return {
      permissionMode: opts?.permissionMode ?? tracked.permissionMode,
      ...(model !== undefined ? { model } : {}),
      ...(fastMode !== undefined ? { fastMode } : {}),
    };
  }

  // --- Interactive flows ---

  /**
   * @inheritdoc
   *
   * Resolves the pending request tracked by the turn stream and forwards the
   * decision as `once`/`reject`. `alwaysAllow` is deliberately ignored:
   * OpenCode's `always` would persist a rule in ITS store and diverge from
   * DorkOS's approval model (NOTES.md §2) — the mapper already advertises
   * `hasSuggestions: false` so the client never offers it.
   *
   * The projector is told directly rather than waiting for the sidecar's
   * `permission.replied` echo. The echo is a courtesy, not a guarantee: if it
   * is dropped (a resubscribed stream, a sidecar restart) the operator's card
   * would hang forever and the session would stay `blocked`, which also holds
   * the write-lock probe the next turn runs. When the echo does arrive it maps
   * to a resolve for an id already gone, which the projector no-ops.
   *
   * `denyReason` is dropped for a structural reason, not an oversight: the
   * sidecar's respond endpoint takes `once`/`reject` and carries no free-text
   * channel, so there is nowhere to put the person's words. What matters is
   * that this path therefore never tells the projector a reason was given, so
   * an OpenCode denial's receipt does not claim the agent was told why —
   * silence here is the honest outcome rather than a lost promise.
   */
  approveTool(
    sessionId: string,
    toolCallId: string,
    approved: boolean,
    options?: ToolDecisionOptions
  ): boolean {
    const pending = this.approvals.take(sessionId, toolCallId);
    if (!pending) return false;
    peekProjector(sessionId)?.resolveInteraction(toolCallId, approved ? 'approved' : 'denied', {
      ...(options?.answeredBy ? { answeredBy: options.answeredBy } : {}),
    });
    void respondPermission(this.provider, pending, toolCallId, approved ? 'once' : 'reject').catch(
      (err: unknown) => logger.warn('[OpenCodeRuntime] permission respond failed', logError(err))
    );
    return true;
  }

  /** OpenCode has no AskUserQuestion-equivalent surface on the v1 API. */
  submitAnswers(): boolean {
    return false;
  }

  /** OpenCode has no MCP elicitation surface DorkOS can answer. */
  submitElicitation(): boolean {
    return false;
  }

  /** OpenCode exposes no addressable background tasks — nothing to stop. */
  async stopTask(): Promise<InterruptReceipt> {
    return { outcome: 'not-running', reason: 'no-open-turn', runtime: this.type };
  }

  /**
   * @inheritdoc
   *
   * Aborts the in-flight turn via `POST /session/{id}/abort`, bounded by
   * {@link awaitAbortAck} (DOR-1299): a wedged sidecar drops the request the
   * same way an ended stdin drops claude-code's, and nothing then answers it,
   * ever. Past {@link INTERRUPT_ACK_TIMEOUT_MS} this gives up; see
   * {@link INTERRUPT_ACK_TIMEOUT_MS} for why there is nothing session-scoped to
   * escalate TO here.
   *
   * On the acked path the wire carries `session.error{MessageAbortedError}` +
   * `session.idle`, which the mapper normalizes to a quiet `done` —
   * user-initiated, not an error.
   *
   * **Nothing here is ever `closed`, and DorkOS does not settle a turn it did
   * not observe end** (spec `runtime-interrupt-receipts` §4.2, D6). An abort
   * that answers `false`, or that nothing answers at all, is `unconfirmed`: the
   * DorkOS-side turn stays open, Stop stays pressable, and the person is told
   * the stop was requested but not confirmed. Fabricating an end instead would
   * show a stopped turn that goes on producing text and disagrees with the
   * runtime's own store at the next hydrate — the DOR-1313 shape. Escalating by
   * killing the sidecar is not available either: it is DorkOS-managed and shared
   * by every OpenCode session on the machine (ADR-0308), so stopping one turn
   * that way would stop every other one too.
   */
  async interruptQuery(sessionId: string): Promise<InterruptReceipt> {
    const preparing = this.#roomPreparing.get(sessionId);
    if (preparing) preparing.retired = true;
    const turn = this.activeTurns.get(sessionId);
    if (turn) {
      const operation = openCodeNativeTurns.get(turn);
      if (operation) operation.retired = true;
    }
    if (!turn)
      return preparing
        ? { outcome: 'closed', runtime: this.type }
        : { outcome: 'not-running', reason: 'no-open-turn', runtime: this.type };
    turn.controller.abort();
    try {
      await this.revokeConnectorTurn(turn, 'turn_cancelled');
    } catch (err) {
      // A rejection means durable persistence failed after the port's
      // fail-closed in-process tombstone. The independent sidecar abort still
      // has to run so Stop reaches the agent; terminal teardown retries the
      // durable revoke because the rejected in-flight promise was cleared.
      logger.warn(
        '[OpenCodeRuntime] connector revocation persistence failed during interrupt; continuing with sidecar abort',
        { sessionId, ...logError(err) }
      );
    }
    if (turn.phase !== 'running') {
      logger.debug('[OpenCodeRuntime] cancelled turn before sidecar trigger', {
        sessionId,
      });
      return { outcome: 'closed', runtime: this.type };
    }
    const ack = await awaitAbortAck(async () => {
      const client = await this.provider.getClient(turn.cwd);
      const original = openCodeNativeTurns.get(turn);
      if (
        !original ||
        client !== original.client ||
        nativeMapGet.call(original.active, original.key) !== turn
      )
        return false;
      return (
        unwrap(await client.session.abort({ path: { id: turn.ocSessionId } }), 'session.abort') ===
        true
      );
    });
    // The tri-state is worth telling apart in the log: REFUSED means the
    // sidecar answered and said no (a bug or a race, not a wedge); UNACKED
    // means the bound itself fired, which is the wedge this whole path
    // exists for.
    switch (ack.kind) {
      case 'settled':
        if (ack.aborted) {
          logger.debug('[OpenCodeRuntime] interrupted in-flight turn', { sessionId });
          return { outcome: 'acked', runtime: this.type };
        }
        logger.warn('[OpenCodeRuntime] interrupt returned false', { sessionId });
        return { outcome: 'unconfirmed', reason: 'runtime-declined', runtime: this.type };
      case 'refused':
        // The call itself blew up — the sidecar is down, or the network is. The
        // turn is untouched and nothing DorkOS did ended it, which is `failed`
        // rather than `unconfirmed`: this one reads as an error and asks the
        // person to try again.
        logger.warn('[OpenCodeRuntime] interrupt call failed', { sessionId });
        return { outcome: 'failed', reason: 'delivery-failed', runtime: this.type };
      case 'unacked':
        logger.warn('[OpenCodeRuntime] interrupt timed out waiting for an ack', { sessionId });
        return { outcome: 'unconfirmed', reason: 'ack-timeout', runtime: this.type };
    }
  }

  /**
   * Revoke one connector binding at most once concurrently across interrupt and
   * teardown. A rejected persistence attempt is cleared so terminal teardown can
   * retry; the principal port has already tombstoned the bearer before rejecting.
   *
   * @param turn - Active turn carrying the optional binding.
   * @param reason - First terminal reason observed for that binding.
   */
  private async revokeConnectorTurn(
    turn: ActiveTurn,
    reason: RevokeConnectorTurnReason
  ): Promise<void> {
    if (!turn.connectorBinding || !this.connectorRuntimeTools) return;
    if (turn.connectorRevocation) return turn.connectorRevocation;

    const bindingId = turn.connectorBinding.bindingId;
    const principals = this.connectorRuntimeTools.principals;
    const revocation = Promise.resolve().then(() => principals.revoke(bindingId, reason));
    turn.connectorRevocation = revocation;
    try {
      await revocation;
    } catch (err) {
      if (turn.connectorRevocation === revocation) turn.connectorRevocation = undefined;
      throw err;
    }
  }

  // --- Session queries (storage) ---

  /**
   * @inheritdoc
   *
   * The sidecar's listing (via the mapper — fast `[]` on a cold sidecar) is
   * the source of truth, unioned with tracked-but-unlisted sessions (created
   * while the sidecar was cold, or still binding). Listed sessions hardcode
   * `permissionMode: 'default'` (OpenCode has no per-session mode), so the
   * DorkOS-tracked settings are overlaid; restart-persisted settings are
   * overlaid one layer up from `session_metadata` (ADR-0260).
   *
   * The sidecar is asked in the CANONICAL spelling of the directory, because
   * that is the spelling it stored (DOR-695 — see {@link canonicalDirectory}).
   * The registry is asked in the spelling the caller used, and reconciles the
   * two itself: it holds the cwd whoever created each session used, which is
   * its own third spelling of the same folder.
   */
  async listSessions(projectDir: string): Promise<Session[]> {
    const listed = await this.mapper.listSessions(canonicalDirectory(projectDir));
    const byId = new Map(listed.map((session) => [session.id, session]));
    for (const tracked of this.registry.list(projectDir)) {
      if (!byId.has(tracked.id)) byId.set(tracked.id, tracked);
    }
    const sessions = [...byId.values()];
    for (const session of sessions) this.overlayTrackedSettings(session);
    return sessions;
  }

  /**
   * @inheritdoc
   *
   * The cheap path reads the sidecar listing + tracked registry. On a miss
   * with a KNOWN durable binding (post-restart, cold sidecar — `listSessions`
   * never boots), falls through to the mapper's targeted single-session read,
   * which boots the sidecar: a bookmarked id must resolve after a restart
   * instead of 404ing until something else warms the sidecar (DOR-251).
   */
  async findSession(sessionId: string): Promise<Session | null> {
    return this.mapper.findSession(DEFAULT_CWD, sessionId);
  }

  async getSession(projectDir: string, sessionId: string): Promise<Session | null> {
    const sessions = await this.listSessions(projectDir);
    const listed = sessions.find((session) => session.id === sessionId);
    if (listed) return listed;
    const session = await this.mapper.getSession(canonicalDirectory(projectDir), sessionId);
    if (session) this.overlayTrackedSettings(session);
    return session;
  }

  /**
   * @inheritdoc
   *
   * OpenCode's store is durable — history comes from the sidecar through the
   * mapper (booting it when needed), so revisits survive both DorkOS and
   * sidecar restarts. A known native conversation reports unavailable when
   * its store cannot be read; a partial EventLog cannot stand in for its
   * transcript. Only an unbound draft may use the DorkOS-owned event stream.
   */
  async getMessageHistory(projectDir: string, sessionId: string): Promise<HistoryMessage[]> {
    try {
      // The sidecar's store names the model that ran and never one DorkOS
      // credits put in place of the session's (DOR-2636), so that notice is
      // put back from the durable event record, as for Claude Code.
      // Its store keeps no compaction row at all, so a summary the agent asked
      // for (DOR-2732) is drawn back from the same record.
      return overlayAgentCompactions(
        sessionId,
        overlayModelSubstitutions(
          sessionId,
          await this.mapper.getMessageHistory(canonicalDirectory(projectDir), sessionId)
        )
      );
    } catch (err) {
      if (
        this.mapper.getOpenCodeSessionId(sessionId) !== undefined ||
        isDerivedOpenCodeSessionId(sessionId)
      ) {
        throw new SessionDiscoveryUnavailableError(this.type);
      }
      logger.debug(
        '[OpenCodeRuntime] native history read failed — serving durable EventLog fallback',
        logError(err)
      );
      return readLogBackedHistory(sessionId);
    }
  }

  /**
   * @inheritdoc
   *
   * Completed `messages` load from the durable native store (same source as
   * `getMessageHistory`, with its EventLog fallback); the live turn, status,
   * pending interactions, and cursor come from the projector — the pattern
   * ADR-0263 prescribes for adapters that own a real history source.
   */
  async getSessionSnapshot(ctx: SessionOpts, sessionId: string): Promise<SessionSnapshot> {
    const projector = getOrCreateProjector(sessionId, ctx.cwd, { persist: 'history' });
    return projector.buildSnapshot(() => this.getMessageHistory(ctx.cwd ?? DEFAULT_CWD, sessionId));
  }

  /**
   * @inheritdoc
   *
   * Delegates to the projector's resumable seq'd stream — the SAME projector
   * the trigger path feeds, so `/events` serves an OpenCode turn through
   * exactly the code path the Claude adapter uses.
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
   * The registry answers directly here: OpenCode keys its projectors by the
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
   * Emits the tracked-session inventory then live upserts (create, rename,
   * message activity through DorkOS). Sessions created outside DorkOS (the
   * OpenCode TUI) surface through `listSessions`; watching the sidecar's
   * `session.created/updated` global events for true external discovery is a
   * flagged follow-up. `session_status` liveness fans out runtime-neutrally
   * from the projector via the session-list broadcaster.
   */
  subscribeSessionList(_ctx: SessionOpts): AsyncIterable<SessionListEvent> {
    return this.registry.subscribe();
  }

  /**
   * @inheritdoc
   *
   * Reads the sidecar's own todo store (`GET /session/{id}/todo` — the same
   * Todo shape `todo.updated` streams). Peek-only: a cold sidecar has no live
   * session whose tasks could be non-empty.
   */
  async getSessionTasks(_projectDir: string, sessionId: string): Promise<TaskItem[]> {
    const ocSessionId = this.mapper.getOpenCodeSessionId(sessionId);
    const client = this.provider.peekClient();
    if (!ocSessionId || !client) return [];
    try {
      const todos = unwrap(
        await client.session.todo({ path: { id: ocSessionId } }),
        'session.todo'
      );
      return mapOpenCodeTodos(todos);
    } catch (err) {
      logger.debug('[OpenCodeRuntime] todo read failed', logError(err));
      return [];
    }
  }

  async getSessionETag(): Promise<string | null> {
    return null;
  }

  async getLastMessageIds(): Promise<{ user: string; assistant: string } | null> {
    return null;
  }

  /** No byte-addressable transcript exists — OpenCode's store is opaque (ADR-0308). */
  async readFromOffset(): Promise<{ content: string; newOffset: number }> {
    return { content: '', newOffset: 0 };
  }

  // --- Session locking ---

  acquireLock(sessionId: string, clientId: string, res: SseResponse, token?: symbol): boolean {
    return this.locks.acquireLock(sessionId, clientId, res, token);
  }

  releaseLock(sessionId: string, clientId: string, token?: symbol): void {
    this.locks.releaseLock(sessionId, clientId, token);
  }

  isLocked(sessionId: string, clientId?: string): boolean {
    return this.locks.isLocked(sessionId, clientId);
  }

  getLockInfo(sessionId: string): { clientId: string; acquiredAt: number } | null {
    return this.locks.getLockInfo(sessionId);
  }

  // --- Capabilities ---

  /**
   * @inheritdoc
   *
   * Live from the sidecar's provider catalog — the open-source-model surface
   * (Anthropic/OpenAI/Ollama/OpenAI-compatible endpoints, whatever the user
   * configured). Boots the sidecar when needed; an unreachable sidecar yields
   * an empty picker rather than an error.
   *
   * `query.directory` is load-bearing (NOTES.md §9). `GET /provider` reads
   * `enabled_providers`/`disabled_providers` off the same per-directory config
   * `GET /config` does, and resolves the directory as
   * `query → x-opencode-directory → the SIDECAR's own process.cwd()`. Passing
   * `DEFAULT_CWD` to `getClient` does NOT carry it: that argument is accepted
   * and ignored (one shared sidecar, routed per request), and the client sets
   * no directory header. Without the query the picker is built from whatever
   * project the sidecar process happens to sit in — so a provider declared in
   * THIS project's `opencode.json` would be missing from the menu, and one
   * disabled here would still be offered.
   */
  async getSupportedModels(): Promise<ModelOption[]> {
    try {
      const client = await this.provider.getClient(DEFAULT_CWD);
      const listed = unwrap(
        // Canonical, like every other directory-scoped read (DOR-695):
        // `DORKOS_DEFAULT_CWD` is taken verbatim, and on macOS a `/tmp` or
        // `/var` spelling reaches the sidecar as a directory it never stored.
        await client.provider.list({ query: { directory: canonicalDirectory(DEFAULT_CWD) } }),
        'provider.list'
      );
      const [installedOllamaTags, openRouterCatalog] = await Promise.all([
        this.resolveInstalledOllamaTags(listed),
        this.resolveOpenRouterCatalog(listed),
      ]);
      return projectModelOptions(listed, { installedOllamaTags, openRouterCatalog });
    } catch (err) {
      logger.warn('[OpenCodeRuntime] provider catalog unavailable', logError(err));
      return [];
    }
  }

  /**
   * Installed Ollama tags for the honest-local-availability filter (spec §10),
   * or `null` to skip filtering. Probes Ollama's `/api/tags` only when an
   * ollama model can actually reach the menu ({@link projectedProviderIds} —
   * never `payload.all`, which lists every provider models.dev knows and so
   * gates nothing); an unreachable Ollama
   * (`running: false`) returns `null` so the menu degrades to the full catalog
   * rather than emptying. A reachable Ollama returns its installed tag names
   * (possibly empty — honestly no local models installed yet).
   */
  private async resolveInstalledOllamaTags(
    payload: ProviderListResponse
  ): Promise<string[] | null> {
    const OLLAMA_PROVIDER_ID = 'ollama';
    if (!projectedProviderIds(payload).has(OLLAMA_PROVIDER_ID)) return null;
    const status = await detectOllama();
    if (!status.running) return null;
    return status.models.map((tag) => tag.name);
  }

  /**
   * OpenRouter's live public model catalog for the honest-cloud-availability
   * filter, or `null` to skip it. An unreachable OpenRouter returns `null` so
   * the menu degrades to the sidecar's own (staler) catalog rather than
   * emptying — the same rule as {@link resolveInstalledOllamaTags}, for the
   * same reason.
   *
   * Gated on {@link projectedProviderIds}, NOT on `payload.all`. `all` is the
   * whole models.dev universe — hundreds of providers, openrouter always among
   * them — so a gate written against it never closes, and an Ollama-only user
   * who has never touched OpenRouter would pay a network probe (on the model
   * WRITE path, on a plane) for a provider whose models will not appear in
   * their menu at all. `projectedProviderIds` asks the question that actually
   * matters: will any openrouter model be in the list this projection returns?
   */
  private async resolveOpenRouterCatalog(
    payload: ProviderListResponse
  ): Promise<OpenRouterCatalog | null> {
    const OPENROUTER_PROVIDER_ID = 'openrouter';
    if (!projectedProviderIds(payload).has(OPENROUTER_PROVIDER_ID)) return null;
    return fetchOpenRouterCatalog();
  }

  /**
   * @inheritdoc
   *
   * OpenCode's auth is provider-agnostic — the connected source is DorkOS's
   * persisted `runtimes.opencode.provider`. Surfaced so the client can label a
   * "Change power source" affordance with the current source. `null` when the
   * runtime was authenticated outside DorkOS (e.g. the OpenCode CLI logged in
   * directly), so there is no DorkOS provider to switch.
   */
  getConnectedProvider(): string | null {
    return getConnectedOpenCodeProvider();
  }

  /** OpenCode agents are prompt-scoped, not a DorkOS-dispatchable subagent registry. */
  async getSupportedSubagents(): Promise<SubagentInfo[]> {
    return [];
  }

  /**
   * @inheritdoc
   *
   * `mediaOutput` is resolved per INSTANCE rather than baked into
   * {@link OPENCODE_CAPABILITIES}, because it is the one capability here that
   * depends on how the runtime was wired: with no attachment store there is
   * nowhere to put an image, and claiming otherwise would be exactly the silent
   * promise this field exists to end.
   */
  getCapabilities(): RuntimeCapabilities {
    if (!this.attachments) return OPENCODE_CAPABILITIES;
    return { ...OPENCODE_CAPABILITIES, mediaOutput: 'attachments' };
  }

  async checkDependencies(): Promise<DependencyCheck[]> {
    return checkOpenCodeDependencies();
  }

  // --- Commands ---

  /** OpenCode exposes no DorkOS-invocable slash commands. */
  async getCommands(): Promise<CommandRegistry> {
    return { commands: [], lastScanned: new Date().toISOString() };
  }

  // --- MCP (read-only status + managed injection, delegated to OpenCodeMcpManager) ---

  /**
   * @inheritdoc
   *
   * Surfaces the MCP servers OpenCode loaded for a directory from its OWN config
   * (the merged global + per-project `opencode.json` `mcp` map), read-only:
   * `supportsMcp` stays false, so these render as discovered, non-editable rows
   * in the profile's Tools & MCP roster. Delegated to {@link OpenCodeMcpManager}, which warms
   * a per-cwd cache out-of-band and peek-only (never boots the sidecar just to
   * populate a read-only roster).
   */
  getMcpStatus(cwd: string): McpServerEntry[] | null {
    return this.mcp.getStatus(cwd);
  }

  /**
   * Whether the `dorkos` tool server is registered on this directory's sidecar
   * right now (spec `tool-only-room-replies` §D2).
   *
   * The reconcile's own answer, not a configuration read: OpenCode surfaces a
   * name collision as a `failed` roster entry rather than overwriting a user's
   * server, and an add can simply fail, so "we are configured to inject it" and
   * "it is there" are genuinely different facts here. A room asking whether to
   * suppress a turn's words needs the second one.
   *
   * **That is also why this cannot drift from its injection gate the way codex's
   * did.** `resolveDorkosServer` withholds the entry for a directory hosting no
   * registered agent, so the name never reaches `mcp.add` and never lands in the
   * record this reads — the mesh gate is upstream of the answer rather than
   * restated beside it. There is no second reading of the gate here to keep in
   * step, which is the strongest form of the property.
   *
   * `false` until this directory has reconciled once, which keeps the first turn
   * on text-as-reply rather than betting an answer on a registration that has not
   * happened yet.
   *
   * @param session.cwd - The session's working directory, canonicalized to the
   * key used by MCP reconciliation.
   * @returns Whether the tools are reachable from a turn there.
   */
  async carriesRoomTools(session: { cwd: string }): Promise<boolean> {
    return this.mcp.dorkosApplied(canonicalDirectory(session.cwd));
  }

  // --- Lifecycle ---

  /**
   * No-op: there are no per-session processes to evict — session lifetime
   * belongs to the sidecar, whose process health the server-manager owns.
   */
  checkSessionHealth(): void {}

  /**
   * Always `undefined`: the DorkOS session id IS the canonical id for
   * OpenCode sessions (the mapper keeps the `ses_*` id adapter-internal).
   * Returning the OpenCode id here would trip trigger-turn's C1 rekey and
   * re-key the projector — and the 202's canonical id — to the OpenCode id,
   * orphaning the client's subscription (same reasoning as Codex).
   */
  getInternalSessionId(_sessionId: string): string | undefined {
    return undefined;
  }

  // --- Dependency injection ---

  /** Inject the core session-settings store for durable hydrate/write-through (ADR-0260). */
  setSessionSettings(port: SessionSettingsPort): void {
    this.settingsPort = port;
  }

  /**
   * Accept the managed-MCP-server resolver so a turn can register the agent's
   * enabled managed servers into the live sidecar (DOR-892 seam; the injection
   * runs per turn via {@link OpenCodeMcpManager.ensureManaged}). The composition
   * root calls this on every runtime that implements it; gated by
   * `supportsManagedMcpServers: true`.
   *
   * @param resolver - The managed-server resolver from the composition root.
   */
  setManagedMcpServers(resolver: ManagedMcpServerResolver): void {
    this.mcp.setResolver(resolver);
  }

  /**
   * Accept the agent registry, so a turn can tell whether its working directory
   * hosts a registered agent — the guard on minting the identity the injected
   * `dorkos` tool server presents (spec `tool-only-room-replies` §D4).
   *
   * The composition root calls this on every runtime that implements it. This
   * runtime had no use for it until the DorkOS tools needed a per-agent identity
   * channel; OpenCode's sidecar is one shared process with a fixed environment,
   * so headers on the injected server are the ONLY place that identity can ride.
   *
   * @param meshCore - The agent registry port from the composition root.
   */
  setMeshCore(meshCore: AgentRegistryPort): void {
    this.meshCore = meshCore;
    this.mcp.setMeshCore(meshCore);
  }

  // --- Internals ---

  /**
   * The OpenCode session bound to a DorkOS session, creating one when needed.
   * Concurrent callers (an eager `ensureSession` bind racing the first
   * `sendMessage`) share one in-flight creation, so a session can never bind
   * to two OpenCode sessions.
   */
  private resolveOpenCodeSession(sessionId: string, cwd: string, title?: string): Promise<string> {
    const existing = this.mapper.getOpenCodeSessionId(sessionId);
    if (existing !== undefined) return Promise.resolve(existing);
    const inflight = this.binding.get(sessionId);
    if (inflight) return inflight;
    const creating = this.mapper
      .ensureSession(sessionId, {
        cwd: canonicalDirectory(cwd),
        ...(title !== undefined ? { title } : {}),
      })
      .finally(() => {
        if (this.binding.get(sessionId) === creating) this.binding.delete(sessionId);
      });
    this.binding.set(sessionId, creating);
    return creating;
  }

  /**
   * The directory AS STORED BY OPENCODE for a session — the demux key half
   * that must never be substituted with the DorkOS cwd (strict string
   * equality; trailing-slash or symlink drift would silently drop every
   * event). Read once via `session.get` and cached; failure is loud — a turn
   * without a trustworthy demux key must not run.
   */
  private async resolveSessionDirectory(
    client: OpencodeClient,
    ocSessionId: string
  ): Promise<string> {
    const cached = this.directoryByOcId.get(ocSessionId);
    if (cached !== undefined) return cached;
    const session = unwrap(await client.session.get({ path: { id: ocSessionId } }), 'session.get');
    this.directoryByOcId.set(ocSessionId, session.directory);
    return session.directory;
  }

  /**
   * Overlay DorkOS-tracked settings onto a listed session — OpenCode has no
   * per-session permission mode, so the mapper hardcodes `'default'` and the
   * tracked value (kept current by `updateSession`) wins.
   */
  private overlayTrackedSettings(session: Session): void {
    const tracked = this.registry.get(session.id);
    if (!tracked) return;
    session.permissionMode = tracked.permissionMode;
    if (tracked.model !== undefined) session.model = tracked.model;
    if (tracked.fastMode !== undefined) session.fastMode = tracked.fastMode;
  }
}

/**
 * The credits model id a session's OpenCode selection names: the id after the
 * credits provider's prefix, or the selection as stored when it names another
 * provider (which credits never serve), or `undefined` for none.
 *
 * @param selected - The session's model setting (`provider/model`), if any.
 */
function creditsModelIdOf(selected: string | undefined): string | undefined {
  const prefix = `${OPENCODE_CREDITS_PROVIDER_ID}/`;
  return selected?.startsWith(prefix) ? selected.slice(prefix.length) : selected;
}

/**
 * The OpenCode selection (`provider/model`) for one credits model id.
 *
 * @param id - A credits model id.
 */
function creditsSelection(id: string): string {
  return `${OPENCODE_CREDITS_PROVIDER_ID}/${id}`;
}

/**
 * The `{providerID, modelID}` a credits turn sends: the session's model when it
 * is one of the credits models, else the default one.
 *
 * @param selected - The session's model setting.
 * @param plan - The credits plan the sidecar runs on.
 * @throws {CreditsUnavailableError} When the plan has no model at all.
 */
function creditsPromptModel(
  selected: string | undefined,
  plan: OpenCodeSidecarPlan
): { providerID: string; modelID: string } {
  const modelID = creditsModelFor(selected, plan.models);
  if (modelID === null) throw new CreditsUnavailableError('unreachable', OPENCODE_LABEL);
  return { providerID: OPENCODE_CREDITS_PROVIDER_ID, modelID };
}
