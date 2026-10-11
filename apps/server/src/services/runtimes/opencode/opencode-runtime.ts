import '../../core/turn-power/turn-levels.js';
import '../../core/runtime-registry.js';
const originalOpenCodeLockedStreams = new WeakMap<object, OriginalOpenCodeLockedStreamData>();
/** Fixed constructor-created stream identity plus the original live acquisition; never a supplied stream matcher. */
export function readOpenCodeOriginalLockedStream(
  runtime: object,
  sessionId: string,
  stream: object
): boolean {
  return openCodeNativePublic.readOpenCodeOriginalLockedStream(
    originalOpenCodeModuleOwner,
    runtime,
    sessionId,
    stream
  );
}
/** Exact original opened turn DATA; a supplied observer cannot replace these options. */
export function readOpenCodeOriginalLockedTurnOptions(
  runtime: object,
  sessionId: string,
  stream: object
) {
  return openCodeNativePublic.readOpenCodeOriginalLockedTurnOptions(
    originalOpenCodeModuleOwner,
    runtime,
    sessionId,
    stream
  );
}
import '@dorkos/shared/run-outcome';
import '@dorkos/shared/schemas';
const originalOpenCodeRoomStreams = new WeakMap<object, OriginalOpenCodeRoomStreamData>();
/** Retire the original OpenCode Room responder stream and its captured lifecycle. */
export function retireOpenCodeOriginalRoomResponderStream(stream: object): Promise<void> {
  return openCodeNativePublic.retireOpenCodeOriginalRoomResponderStream(
    originalOpenCodeModuleOwner,
    stream
  );
}
/** Read evidence from the original OpenCode Room responder stream. */
export function readOpenCodeOriginalRoomResponderStream(
  runtime: object | undefined,
  stream: object,
  event?: StreamEvent
) {
  return openCodeNativePublic.readOpenCodeOriginalRoomResponderStream(
    originalOpenCodeModuleOwner,
    runtime,
    stream,
    event
  );
}
import { captureOriginalRoomDispatchLifecycle } from '../../session/trigger-turn.js';
import type { OriginalRoomDispatchCustody } from '../../rooms/service/room-core.js';
import { readOriginalFrozenRoomTarget } from '../../canvas/doc-channel/operations/room-current-operation.js';
import type {
  OriginalFrozenRoomSource,
  PreparedRoomResponder,
  OriginalCommittedRoomResponder,
} from '../../canvas/doc-channel/current/current-operation-types.js';
import '../../connectors/principal/runtime-principal-service.js';
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
  LiveSessionRef,
} from '@dorkos/shared/agent-runtime';
import { picksSession } from '@dorkos/shared/agent-runtime';
import type {
  SessionSnapshot,
  SessionEvent,
  SessionListEvent,
} from '@dorkos/shared/session-stream';
import type { RuntimeCommandIntentId } from '@dorkos/shared/command-intents';
import type { McpServerEntry } from '@dorkos/shared/transport';
import { peekProjector } from '../../session/session-state-projector.js';
import '../../session/log-backed-history.js';
import '../../session/resolution/session-lookup-error.js';
import '../../session/overlays/model-substitution-overlay.js';
import '../../session/overlays/agent-compaction-overlay.js';
import {
  SessionLockManager,
  captureNativeSessionAcquisition,
  type NativeSessionAcquisition,
} from '../../session/session-lock.js';
import '../../../lib/resolve-root.js';
import '../../core/agent-identity/index.js';
import { logger, logError } from '../../../lib/logger.js';
import './messaging/turn-context.js';
import './providers/check-dependencies.js';
import './providers/ollama.js';
import { type OpenRouterCatalog } from './providers/openrouter.js';
import './events/event-mapper.js';
import './events/session-event-mapper.js';
import { OpenCodeSessionMapper, type OpenCodeClientProvider } from './sessions/session-mapper.js';
import { OpenCodeGlobalEventHub } from './events/global-event-hub.js';
import { OpenCodeSessionRegistry, type OpenCodeSessionPatch } from './sessions/session-registry.js';
import {
  PendingApprovalStore,
  respondPermission,
  type ApprovalGateDeps,
} from './messaging/approvals.js';
import { OPENCODE_CAPABILITIES } from './runtime-constants.js';
import './messaging/bounded-abort.js';
import './messaging/turn-input.js';
import './messaging/compaction-model.js';
import './messaging/directory-grants.js';
import './providers/models.js';
import { OpenCodeContextWindows } from './providers/context-windows.js';
import { OpenCodeMcpManager } from './mcp/mcp-manager.js';
import { canonicalDirectory } from '@dorkos/shared/canonical-directory';
import './events/media-capture.js';
import type { SessionAttachmentStore } from '../../session/attachments/index.js';
import { type ConnectorRuntimeTools } from '../connector-tools.js';
import type { RevokeConnectorTurnReason } from '../../connectors/runtime-principal-port.js';
import { ConnectorTurnLeaseManager } from './mcp/connector-turn-lease.js';
import { openCodeRunsOnCredits, type OpenCodeSidecarPlan } from './credits-sidecar.js';
import '../../core/cloud/credits-protocols.js';
import '../../core/cloud/credits-models.js';

import type {
  OpenCodeRuntimeOptions,
  ActiveTurn,
  SettingUpTurn,
  OpenCodeNativeEntry,
  OpenCodePreparedRoomContinuation,
  OriginalOpenCodeLockedStreamData,
  OriginalOpenCodeRoomStreamData,
  OriginalOpenCodeLockedRunner,
  OriginalOpenCodeRoomPreparer,
  OriginalOpenCodePreparedRoomData,
} from './opencode-runtime-data.js';
export type {
  OpenCodeRuntimeOptions,
  ActiveTurn,
  SettingUpTurn,
  OpenCodeNativeEntry,
  OpenCodePreparedRoomContinuation,
} from './opencode-runtime-data.js';
import * as openCodeNativePublic from './opencode-native-public-lifetimes.js';
import type { OriginalOpenCodeRuntimeView } from './opencode-private-method-contracts.js';
import * as openCodeMessageLifetime from './opencode-message-lifetime.js';
import * as openCodeNativeRoomPreparation from './opencode-native-room-preparation.js';
import * as openCodeNativeTurnExecution from './opencode-native-turn-execution.js';
import * as openCodeSessionQueryStorage from './opencode-session-query-storage.js';
import * as openCodeProviderDiscovery from './opencode-provider-discovery.js';
import * as openCodeAccountTurnLifecycle from './opencode-account-turn-lifecycle.js';

/** One in-flight turn (identity-matched on teardown, like Codex's controllers). */
// Only the original Room reader installs cancellation for its captured sidecar session.
const openCodeOriginalReadStops = new WeakMap<ActiveTurn, () => Promise<void>>();

/**
 * OpenCode runtime implementing the universal AgentRuntime interface.
 */
const nativeMapGet = Map.prototype.get;
const nativeMapSet = Map.prototype.set;
const nativeSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;

const openCodeLockedRunners = new WeakMap<object, OriginalOpenCodeLockedRunner>();
/** Original constructor-owned turn entry. A holder selects data; it cannot issue lock/principal authority. */
export function sendOpenCodeOriginalLockedMessage(
  runtime: object,
  sessionId: string,
  content: string,
  opts: MessageOpts | undefined,
  holder: SseResponse,
  lockKey: string
): AsyncGenerator<StreamEvent> | undefined {
  return openCodeNativePublic.sendOpenCodeOriginalLockedMessage(
    originalOpenCodeModuleOwner,
    runtime,
    sessionId,
    content,
    opts,
    holder,
    lockKey
  );
}
const openCodeRoomPreparers = new WeakMap<object, OriginalOpenCodeRoomPreparer>();

const openCodeRoomPrepared = new WeakMap<PreparedRoomResponder, OriginalOpenCodePreparedRoomData>();
/** Fixed genuine setup may create a local sidecar session, but never sends a model prompt. */
export function prepareOpenCodeOriginalLockedRoomResponder(
  runtime: object,
  holder: SseResponse,
  key: string,
  source: OriginalFrozenRoomSource
): Promise<PreparedRoomResponder | undefined> {
  return openCodeNativePublic.prepareOpenCodeOriginalLockedRoomResponder(
    originalOpenCodeModuleOwner,
    runtime,
    holder,
    key,
    source
  );
}
/** Exact original preparation retirement, before provider/revocation callbacks. */
export function retireOpenCodePreparedRoomResponder(
  runtime: object,
  prepared: PreparedRoomResponder
): Promise<void> {
  return openCodeNativePublic.retireOpenCodePreparedRoomResponder(
    originalOpenCodeModuleOwner,
    runtime,
    prepared
  );
}
/** Fixed lookup of one genuinely constructor-prepared entry; returned identities never register authority. */
export function readOpenCodePreparedRoomResponder(
  runtime: object,
  prepared: PreparedRoomResponder
) {
  return openCodeNativePublic.readOpenCodePreparedRoomResponder(
    originalOpenCodeModuleOwner,
    runtime,
    prepared
  );
}

/** Continue the same original setup only after its native COMMIT and private FIRST. */
export function startOpenCodeCommittedRoomResponder(
  runtime: object,
  prepared: PreparedRoomResponder,
  committed?: OriginalCommittedRoomResponder
): AsyncGenerator<StreamEvent> {
  return openCodeNativePublic.startOpenCodeCommittedRoomResponder(
    originalOpenCodeModuleOwner,
    runtime,
    prepared,
    committed
  );
}
const openCodeOriginalActiveSlots = new WeakMap<object, Map<string, ActiveTurn>>();
const openCodeNativeConstructors = new WeakSet<object>();
const openCodeNativeOperations = new WeakMap<object, OpenCodeNativeEntry>();
const openCodeNativeTurns = new WeakMap<ActiveTurn, OpenCodeNativeEntry>();
/** Fixed native lifetime read; retired entries cannot regain authority through map reinsertion. */
export function readOpenCodeNativeOperation(token: object) {
  return openCodeNativePublic.readOpenCodeNativeOperation(originalOpenCodeModuleOwner, token);
}

/** Exact original private module custody types; this declaration exports no map or registrar. */
export interface OriginalOpenCodeModuleCustody {
  readonly originalOpenCodeLockedStreams: typeof originalOpenCodeLockedStreams;
  readonly originalOpenCodeRoomStreams: typeof originalOpenCodeRoomStreams;
  readonly openCodeOriginalReadStops: typeof openCodeOriginalReadStops;
  readonly openCodeOriginalActiveSlots: typeof openCodeOriginalActiveSlots;
  readonly openCodeNativeConstructors: typeof openCodeNativeConstructors;
  readonly openCodeNativeOperations: typeof openCodeNativeOperations;
  readonly openCodeNativeTurns: typeof openCodeNativeTurns;
  readonly openCodeRoomPrepared: typeof openCodeRoomPrepared;
  readonly nativeMapGet: typeof nativeMapGet;
  readonly nativeMapSet: typeof nativeMapSet;
  readonly openCodeLockedRunners: typeof openCodeLockedRunners;
  readonly openCodeRoomPreparers: typeof openCodeRoomPreparers;
  readonly nativeSignalAborted: typeof nativeSignalAborted;
}

const originalOpenCodeMethodGet = WeakMap.prototype.get;
const originalOpenCodeMethodSet = WeakMap.prototype.set;
const originalOpenCodeMethodApply = Reflect.apply;
const originalOpenCodeMethodFreeze = Object.freeze;
const originalOpenCodeModuleOwner = originalOpenCodeMethodFreeze({});
const originalOpenCodeModuleCustody: Readonly<OriginalOpenCodeModuleCustody> =
  originalOpenCodeMethodFreeze({
    originalOpenCodeLockedStreams,
    originalOpenCodeRoomStreams,
    openCodeOriginalReadStops,
    openCodeOriginalActiveSlots,
    openCodeNativeConstructors,
    openCodeNativeOperations,
    openCodeNativeTurns,
    openCodeRoomPrepared,
    nativeMapGet,
    nativeMapSet,
    nativeSignalAborted,
    openCodeLockedRunners,
    openCodeRoomPreparers,
  });
/** Require the private original module selector before native lifetime operations. */
export function readOriginalOpenCodeModuleCustody(
  moduleOwner: object
): OriginalOpenCodeModuleCustody {
  if (moduleOwner !== originalOpenCodeModuleOwner)
    throw new Error('OpenCode operation requires its original runtime.');
  return originalOpenCodeModuleCustody;
}
const originalOpenCodeMethodViews = new WeakMap<object, OriginalOpenCodeRuntimeView>();
/** Resolve only the actual runtime constructor-private selector before effects. */
export function readOriginalOpenCodeRuntimeView(runtimeOwner: object): OriginalOpenCodeRuntimeView {
  const view: OriginalOpenCodeRuntimeView | undefined = originalOpenCodeMethodApply(
    originalOpenCodeMethodGet,
    originalOpenCodeMethodViews,
    [runtimeOwner]
  );
  if (!view) throw new Error('OpenCode operation requires its original runtime.');
  return view;
}

/** Run OpenCode sessions with their original client and native turn lifetimes. */
export class OpenCodeRuntime implements AgentRuntime {
  readonly #originalMethodOwner = originalOpenCodeMethodFreeze({});
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
    const createOriginalMethodView = (
      runtime: OpenCodeRuntime
    ): Readonly<OriginalOpenCodeRuntimeView> =>
      originalOpenCodeMethodFreeze<OriginalOpenCodeRuntimeView>({
        runtime,
        custody: originalOpenCodeModuleCustody,
        get roomPreparing() {
          return runtime.#roomPreparing;
        },
        get accountsAccess() {
          return runtime.accountsAccess;
        },
        get activeTurns() {
          return runtime.activeTurns;
        },
        get approvalGate() {
          return runtime.approvalGate;
        },
        get approvals() {
          return runtime.approvals;
        },
        get attachments() {
          return runtime.attachments;
        },
        get binding() {
          return runtime.binding;
        },
        get connectorLeases() {
          return runtime.connectorLeases;
        },
        get connectorRuntimeTools() {
          return runtime.connectorRuntimeTools;
        },
        get contextWindows() {
          return runtime.contextWindows;
        },
        get directoryByOcId() {
          return runtime.directoryByOcId;
        },
        get hub() {
          return runtime.hub;
        },
        get mapper() {
          return runtime.mapper;
        },
        get mcp() {
          return runtime.mcp;
        },
        get meshCore() {
          return runtime.meshCore;
        },
        get provider() {
          return runtime.provider;
        },
        get registry() {
          return runtime.registry;
        },
        get settingUp() {
          return runtime.settingUp;
        },
        get settingsPort() {
          return runtime.settingsPort;
        },
        get type() {
          return runtime.type;
        },
        get createMessage() {
          const fn = runtime.#createMessage;
          return (...args: Parameters<typeof fn>) => originalOpenCodeMethodApply(fn, runtime, args);
        },
        get installNativeTurn() {
          const fn = runtime.#installNativeTurn;
          return (...args: Parameters<typeof fn>) => originalOpenCodeMethodApply(fn, runtime, args);
        },
        get resolveNativeClient() {
          const fn = runtime.#resolveNativeClient;
          return (...args: Parameters<typeof fn>) => originalOpenCodeMethodApply(fn, runtime, args);
        },
        get sendOwnedMessage() {
          const fn = runtime.#sendOwnedMessage;
          return (...args: Parameters<typeof fn>) => originalOpenCodeMethodApply(fn, runtime, args);
        },
        get getCapabilities() {
          const fn = runtime.getCapabilities;
          return (...args: Parameters<typeof fn>) => originalOpenCodeMethodApply(fn, runtime, args);
        },
        get getMessageHistory() {
          const fn = runtime.getMessageHistory;
          return (...args: Parameters<typeof fn>) => originalOpenCodeMethodApply(fn, runtime, args);
        },
        get listSessions() {
          const fn = runtime.listSessions;
          return (...args: Parameters<typeof fn>) => originalOpenCodeMethodApply(fn, runtime, args);
        },
        get overlayTrackedSettings() {
          const fn = runtime.overlayTrackedSettings;
          return (...args: Parameters<typeof fn>) => originalOpenCodeMethodApply(fn, runtime, args);
        },
        get prepareSidecar() {
          const fn = runtime.prepareSidecar;
          return (...args: Parameters<typeof fn>) => originalOpenCodeMethodApply(fn, runtime, args);
        },
        get registerWithPersisted() {
          const fn = runtime.registerWithPersisted;
          return (...args: Parameters<typeof fn>) => originalOpenCodeMethodApply(fn, runtime, args);
        },
        get resolveInstalledOllamaTags() {
          const fn = runtime.resolveInstalledOllamaTags;
          return (...args: Parameters<typeof fn>) => originalOpenCodeMethodApply(fn, runtime, args);
        },
        get resolveOpenCodeSession() {
          const fn = runtime.resolveOpenCodeSession;
          return (...args: Parameters<typeof fn>) => originalOpenCodeMethodApply(fn, runtime, args);
        },
        get resolveOpenRouterCatalog() {
          const fn = runtime.resolveOpenRouterCatalog;
          return (...args: Parameters<typeof fn>) => originalOpenCodeMethodApply(fn, runtime, args);
        },
        get resolveSessionDirectory() {
          const fn = runtime.resolveSessionDirectory;
          return (...args: Parameters<typeof fn>) => originalOpenCodeMethodApply(fn, runtime, args);
        },
        get resolveTurnSettings() {
          const fn = runtime.resolveTurnSettings;
          return (...args: Parameters<typeof fn>) => originalOpenCodeMethodApply(fn, runtime, args);
        },
        get revokeConnectorTurn() {
          const fn = runtime.revokeConnectorTurn;
          return (...args: Parameters<typeof fn>) => originalOpenCodeMethodApply(fn, runtime, args);
        },
        get runOpenCodeTurn() {
          const fn = runtime.runOpenCodeTurn;
          return (...args: Parameters<typeof fn>) => originalOpenCodeMethodApply(fn, runtime, args);
        },
        get updateSession() {
          const fn = runtime.updateSession;
          return (...args: Parameters<typeof fn>) => originalOpenCodeMethodApply(fn, runtime, args);
        },
        get withContextWindow() {
          const fn = runtime.withContextWindow;
          return (...args: Parameters<typeof fn>) => originalOpenCodeMethodApply(fn, runtime, args);
        },
      });
    originalOpenCodeMethodApply(originalOpenCodeMethodSet, originalOpenCodeMethodViews, [
      this.#originalMethodOwner,
      createOriginalMethodView(this),
    ]);
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
    return openCodeAccountTurnLifecycle.ensureSession(this.#originalMethodOwner, sessionId, opts);
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
  updateSession(sessionId: string, opts: SessionSettings): Promise<SessionUpdateResult> {
    return openCodeAccountTurnLifecycle.updateSession(this.#originalMethodOwner, sessionId, opts);
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
    return openCodeMessageLifetime.createMessage(
      this.#originalMethodOwner,
      sessionId,
      content,
      opts,
      acquisition,
      roomOrigin,
      roomPrepared
    );
  }

  #sendOwnedMessage(
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
    return openCodeMessageLifetime.sendOwnedMessage(
      this.#originalMethodOwner,
      sessionId,
      content,
      opts,
      lifetime
    );
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
  executeCommandIntent(
    sessionId: string,
    _intent: RuntimeCommandIntentId,
    opts?: CommandIntentOpts
  ): AsyncGenerator<StreamEvent> {
    return openCodeAccountTurnLifecycle.executeCommandIntent(
      this.#originalMethodOwner,
      sessionId,
      _intent,
      opts
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
  private prepareSidecar(sessionId: string, own: SettingUpTurn): Promise<OpenCodeSidecarPlan> {
    return openCodeNativeRoomPreparation.prepareSidecar(this.#originalMethodOwner, sessionId, own);
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
  #resolveNativeClient(
    sessionId: string,
    cwd: string,
    title?: string,
    pending?: { retired: boolean }
  ) {
    return openCodeNativeRoomPreparation.resolveNativeClient(
      this.#originalMethodOwner,
      sessionId,
      cwd,
      title,
      pending
    );
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
    return openCodeNativeRoomPreparation.installNativeTurn(
      this.#originalMethodOwner,
      sessionId,
      directory,
      client,
      turn,
      acquisition,
      refuseExisting,
      roomOrigin
    );
  }
  #prepareRoomResponder(
    source: OriginalFrozenRoomSource,
    target: Readonly<{ sessionId: string; agentPath: string; agentId: string }>,
    acquisition: NativeSessionAcquisition
  ): Promise<PreparedRoomResponder | undefined> {
    return openCodeNativeRoomPreparation.prepareRoomResponder(
      this.#originalMethodOwner,
      source,
      target,
      acquisition
    );
  }

  private runOpenCodeTurn(
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
    return openCodeNativeTurnExecution.runOpenCodeTurn(
      this.#originalMethodOwner,
      sessionId,
      cwd,
      title,
      trigger,
      opts
    );
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
  private withContextWindow(
    client: OpencodeClient,
    directory: string,
    providerId: string | undefined,
    event: StreamEvent
  ): Promise<StreamEvent> {
    return openCodeNativeTurnExecution.withContextWindow(
      this.#originalMethodOwner,
      client,
      directory,
      providerId,
      event
    );
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
  private registerWithPersisted(
    sessionId: string,
    explicit: OpenCodeSessionPatch = {}
  ): Promise<void> {
    return openCodeAccountTurnLifecycle.registerWithPersisted(
      this.#originalMethodOwner,
      sessionId,
      explicit
    );
  }

  /**
   * Effective settings for one turn: per-send override → tracked session →
   * persisted store (hydrated once for untracked sessions, e.g. resume after
   * a server restart) → runtime default.
   */
  private resolveTurnSettings(sessionId: string, opts?: MessageOpts): Promise<SessionSettings> {
    return openCodeAccountTurnLifecycle.resolveTurnSettings(
      this.#originalMethodOwner,
      sessionId,
      opts
    );
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
   * Live here is a turn in flight: the sidecar is shared by every OpenCode
   * session and keeps no background work of a session's own between turns,
   * so stopping the turn ends the session's work.
   */
  async endSessionsWhere(belongs: (session: LiveSessionRef) => boolean): Promise<string[]> {
    readOriginalOpenCodeRuntimeView(this.#originalMethodOwner);
    const ended: string[] = [];
    for (const [sessionId, turn] of [...this.activeTurns]) {
      if (!picksSession(belongs, { sessionId, cwd: turn.cwd })) continue;
      const receipt = await this.interruptQuery(sessionId).catch(() => undefined);
      if (receipt?.outcome === 'acked' || receipt?.outcome === 'closed') ended.push(sessionId);
    }
    return ended;
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
  interruptQuery(sessionId: string): Promise<InterruptReceipt> {
    return openCodeAccountTurnLifecycle.interruptQuery(this.#originalMethodOwner, sessionId);
  }

  /**
   * Revoke one connector binding at most once concurrently across interrupt and
   * teardown. A rejected persistence attempt is cleared so terminal teardown can
   * retry; the principal port has already tombstoned the bearer before rejecting.
   *
   * @param turn - Active turn carrying the optional binding.
   * @param reason - First terminal reason observed for that binding.
   */
  private revokeConnectorTurn(turn: ActiveTurn, reason: RevokeConnectorTurnReason): Promise<void> {
    return openCodeAccountTurnLifecycle.revokeConnectorTurn(
      this.#originalMethodOwner,
      turn,
      reason
    );
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
  listSessions(projectDir: string): Promise<Session[]> {
    return openCodeSessionQueryStorage.listSessions(this.#originalMethodOwner, projectDir);
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
  findSession(sessionId: string): Promise<Session | null> {
    return openCodeSessionQueryStorage.findSession(this.#originalMethodOwner, sessionId);
  }

  getSession(projectDir: string, sessionId: string): Promise<Session | null> {
    return openCodeSessionQueryStorage.getSession(this.#originalMethodOwner, projectDir, sessionId);
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
  getMessageHistory(projectDir: string, sessionId: string): Promise<HistoryMessage[]> {
    return openCodeSessionQueryStorage.getMessageHistory(
      this.#originalMethodOwner,
      projectDir,
      sessionId
    );
  }

  /**
   * @inheritdoc
   *
   * Completed `messages` load from the durable native store (same source as
   * `getMessageHistory`, with its EventLog fallback); the live turn, status,
   * pending interactions, and cursor come from the projector — the pattern
   * ADR-0263 prescribes for adapters that own a real history source.
   */
  getSessionSnapshot(ctx: SessionOpts, sessionId: string): Promise<SessionSnapshot> {
    return openCodeSessionQueryStorage.getSessionSnapshot(
      this.#originalMethodOwner,
      ctx,
      sessionId
    );
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
    return openCodeSessionQueryStorage.subscribeSession(
      this.#originalMethodOwner,
      ctx,
      sessionId,
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
    return openCodeSessionQueryStorage.streamGeneration(this.#originalMethodOwner, _ctx, sessionId);
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
    return openCodeSessionQueryStorage.subscribeSessionList(this.#originalMethodOwner, _ctx);
  }

  /**
   * @inheritdoc
   *
   * Reads the sidecar's own todo store (`GET /session/{id}/todo` — the same
   * Todo shape `todo.updated` streams). Peek-only: a cold sidecar has no live
   * session whose tasks could be non-empty.
   */
  getSessionTasks(_projectDir: string, sessionId: string): Promise<TaskItem[]> {
    return openCodeSessionQueryStorage.getSessionTasks(
      this.#originalMethodOwner,
      _projectDir,
      sessionId
    );
  }

  getSessionETag(): Promise<string | null> {
    return openCodeSessionQueryStorage.getSessionETag(this.#originalMethodOwner);
  }

  getLastMessageIds(): Promise<{ user: string; assistant: string } | null> {
    return openCodeSessionQueryStorage.getLastMessageIds(this.#originalMethodOwner);
  }

  /** No byte-addressable transcript exists — OpenCode's store is opaque (ADR-0308). */
  readFromOffset(): Promise<{ content: string; newOffset: number }> {
    return openCodeSessionQueryStorage.readFromOffset(this.#originalMethodOwner);
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
  getSupportedModels(): Promise<ModelOption[]> {
    return openCodeProviderDiscovery.getSupportedModels(this.#originalMethodOwner);
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
  private resolveInstalledOllamaTags(payload: ProviderListResponse): Promise<string[] | null> {
    return openCodeProviderDiscovery.resolveInstalledOllamaTags(this.#originalMethodOwner, payload);
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
  private resolveOpenRouterCatalog(
    payload: ProviderListResponse
  ): Promise<OpenRouterCatalog | null> {
    return openCodeProviderDiscovery.resolveOpenRouterCatalog(this.#originalMethodOwner, payload);
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
    return openCodeProviderDiscovery.getConnectedProvider(this.#originalMethodOwner);
  }

  /** OpenCode agents are prompt-scoped, not a DorkOS-dispatchable subagent registry. */
  getSupportedSubagents(): Promise<SubagentInfo[]> {
    return openCodeProviderDiscovery.getSupportedSubagents(this.#originalMethodOwner);
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

  checkDependencies(): Promise<DependencyCheck[]> {
    return openCodeProviderDiscovery.checkDependencies(this.#originalMethodOwner);
  }

  // --- Commands ---

  /** OpenCode exposes no DorkOS-invocable slash commands. */
  getCommands(): Promise<CommandRegistry> {
    return openCodeProviderDiscovery.getCommands(this.#originalMethodOwner);
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
    return openCodeProviderDiscovery.getMcpStatus(this.#originalMethodOwner, cwd);
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
  carriesRoomTools(session: { cwd: string }): Promise<boolean> {
    return openCodeProviderDiscovery.carriesRoomTools(this.#originalMethodOwner, session);
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
    return openCodeSessionQueryStorage.resolveOpenCodeSession(
      this.#originalMethodOwner,
      sessionId,
      cwd,
      title
    );
  }

  /**
   * The directory AS STORED BY OPENCODE for a session — the demux key half
   * that must never be substituted with the DorkOS cwd (strict string
   * equality; trailing-slash or symlink drift would silently drop every
   * event). Read once via `session.get` and cached; failure is loud — a turn
   * without a trustworthy demux key must not run.
   */
  private resolveSessionDirectory(client: OpencodeClient, ocSessionId: string): Promise<string> {
    return openCodeSessionQueryStorage.resolveSessionDirectory(
      this.#originalMethodOwner,
      client,
      ocSessionId
    );
  }

  /**
   * Overlay DorkOS-tracked settings onto a listed session — OpenCode has no
   * per-session permission mode, so the mapper hardcodes `'default'` and the
   * tracked value (kept current by `updateSession`) wins.
   */
  private overlayTrackedSettings(session: Session): void {
    return openCodeSessionQueryStorage.overlayTrackedSettings(this.#originalMethodOwner, session);
  }
}
