import {
  createIsolatedClaudePreparationViews,
  createIsolatedClaudeRelayConstructionViews,
} from './custody/claude-private-view-custody.js';
import {
  createIsolatedClaudeCommandCacheCustody,
  type OriginalClaudeCommands,
} from './custody/claude-command-cache-custody.js';
import * as originalClaudeCommandOperations from './custody/claude-command-cache-custody.js';
const originalClaudeCommands = createIsolatedClaudeCommandCacheCustody();
const originalClaudeCommandFreeze = Object.freeze;
/** Read only the original runtime instance's command view using its inaccessible constructor key. */
export function readOriginalClaudeCommandView(key: object): Readonly<OriginalClaudeCommands> {
  return originalClaudeCommands.read(key);
}

import {
  createIsolatedClaudeSessionQueryCustody,
  type OriginalClaudeSessionQueries,
} from './custody/claude-session-query-custody.js';
import * as originalClaudeSessionQueryOperations from './custody/claude-session-query-custody.js';
const originalClaudeSessionQueries = createIsolatedClaudeSessionQueryCustody();
const originalClaudeSessionQueryFreeze = Object.freeze;
/** Read only the original runtime instance's query view using its inaccessible constructor key. */
export function readOriginalClaudeSessionQueryView(
  key: object
): Readonly<OriginalClaudeSessionQueries> {
  return originalClaudeSessionQueries.read(key);
}

import {
  createIsolatedClaudeNativeCustody,
  type ClaudePreparedRoomContinuation,
  type PluginReloadActivityPort,
} from './custody/claude-native-custody.js';
import { createIsolatedClaudeRelayCustody } from './custody/claude-relay-custody.js';
import type { OriginalClaudeRelayClosedTurn } from './custody/claude-relay-custody.js';
import '../../core/turn-power/turn-levels.js';
import '../../session/session-state-projector.js';
import { readOriginalRoomLaunchHolder } from '../../session/trigger-turn.js';
import '../../session/projection/session-event-normalizer.js';
import '../../session/projection/session-event-normalizer.js';

import './messaging/relay/relay-sdk-launch.js';
import '../../canvas/doc-channel/delivery/relay-authority.js';
import type {
  OriginalFrozenRelayDocumentSource,
  PreparedRelayDocumentResponder,
} from '../../canvas/doc-channel/delivery/relay-native-types.js';
const {
  claudeRelayDriverStops,
  claudeRelayDrivers,
  claudeRelayPreparers,
  claudeRelayPrepared,
  originalRelayLaunchPreparations,
  originalClaudeRelayProjectionStreams,
  originalRelayClosedTurns,
  originalRelayClosedTurnReaders,
  stopClaudeOriginalRelayDocumentDrive,
  driveClaudeOriginalRelayDocument,
  readOriginalClaudeRelayProjectionProjector,
  observeOriginalClaudeRelayProjection,
  observeOriginalClaudeRelayTerminalProjection,
  readOriginalClaudeRelayClosedTurn,
  readOriginalClaudeRelayClosedTurnData,
  readOriginalClaudeRelayProjectedTurnStart,
  requireOriginalClaudeRelayQueryStart,
  commitOriginalClaudeRelayQueryStart,
  sendClaudeOriginalRelayDocument,
  prepareClaudeOriginalRelayDocument,
  readClaudePreparedRelayDocument,
  requireClaudeOriginalRelayPreparedTuple,
  claimClaudeOriginalRelayDocument,
  retireClaudePreparedRelayDocument,
} = createIsolatedClaudeRelayCustody((operation) => readClaudeNativeOperation(operation));
export {
  stopClaudeOriginalRelayDocumentDrive,
  driveClaudeOriginalRelayDocument,
  readOriginalClaudeRelayProjectionProjector,
  observeOriginalClaudeRelayProjection,
  observeOriginalClaudeRelayTerminalProjection,
  readOriginalClaudeRelayClosedTurn,
  readOriginalClaudeRelayClosedTurnData,
  readOriginalClaudeRelayProjectedTurnStart,
  requireOriginalClaudeRelayQueryStart,
  commitOriginalClaudeRelayQueryStart,
  sendClaudeOriginalRelayDocument,
  prepareClaudeOriginalRelayDocument,
  readClaudePreparedRelayDocument,
  requireClaudeOriginalRelayPreparedTuple,
  claimClaudeOriginalRelayDocument,
  retireClaudePreparedRelayDocument,
};
export type { OriginalClaudeRelayClosedTurn } from './custody/claude-relay-custody.js';

import { readOriginalRegisteredRuntime } from '../../core/runtime-registry.js';
const {
  originalClaudeLockedStreams,
  originalClaudeRoomStreams,
  claudeLockMoves,
  claudeLockedRunners,
  claudeRoomPreparers,
  claudeRoomQuerySessions,
  claudeRoomPrepared,
  claudeOriginalStores,
  originalClaudePersistentRequests,
  claudeOriginalLaunchAliases,
  claudeNativeConstructors,
  claudeNativeOperations,
  claudeRuntimeEntries,
  claudeOriginalSessionOperations,
  readClaudeOriginalLockedStream,
  readClaudeOriginalLockedTurnOptions,
  retireClaudeOriginalRoomResponderStream,
  readClaudeOriginalRoomResponderStream,
  moveClaudeOriginalLockedAcquisition,
  sendClaudeOriginalLockedMessage,
  requireOriginalClaudeRoomQueryStart,
  prepareClaudeOriginalLockedRoomResponder,
  retireClaudePreparedRoomResponder,
  readClaudePreparedRoomResponder,
  startClaudeCommittedRoomResponder,
  readOriginalClaudeRoomPersistentRequest,
  requireOriginalClaudeRoomPersistentEffect,
  requireOriginalClaudePersistentSession,
  isClaudeOriginalRoomLaunchAlias,
  captureClaudeOriginalQueryCurrent,
  readClaudeNativeOperation,
} = createIsolatedClaudeNativeCustody();
export {
  readClaudeOriginalLockedStream,
  readClaudeOriginalLockedTurnOptions,
  retireClaudeOriginalRoomResponderStream,
  readClaudeOriginalRoomResponderStream,
  moveClaudeOriginalLockedAcquisition,
  sendClaudeOriginalLockedMessage,
  requireOriginalClaudeRoomQueryStart,
  prepareClaudeOriginalLockedRoomResponder,
  retireClaudePreparedRoomResponder,
  readClaudePreparedRoomResponder,
  startClaudeCommittedRoomResponder,
  readOriginalClaudeRoomPersistentRequest,
  requireOriginalClaudeRoomPersistentEffect,
  requireOriginalClaudePersistentSession,
  isClaudeOriginalRoomLaunchAlias,
  captureClaudeOriginalQueryCurrent,
  readClaudeNativeOperation,
};
export type { PluginReloadActivityPort } from './custody/claude-native-custody.js';
export { buildTaskEvent } from './sdk/build-task-event.js';
import '@dorkos/shared/run-outcome';
import './sessions/persistent-dispatch.js';
import '../../session/trigger-turn.js';
import type { OriginalRoomDispatchCustody } from '../../rooms/service/room-core.js';
import '../../canvas/doc-channel/operations/room-current-operation.js';
import type {
  OriginalFrozenRoomSource,
  PreparedRoomResponder,
} from '../../canvas/doc-channel/current/current-operation-types.js';
import './sessions/session-store.js';
import { AccountsAccessContext } from '../shared/accounts-access-context.js';
import { setAccountProbeBinaryResolver } from './accounts/account-probe.js';
import path from 'path';

import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerEntry } from '@dorkos/shared/transport';
import type {
  StreamEvent,
  ModelOption,
  SubagentInfo,
  Session,
  HistoryMessage,
  TaskItem,
  CommandRegistry,
  ReloadPluginsResult,
  SessionListWarning,
  SessionSettings,
} from '@dorkos/shared/types';
import type {
  AgentRuntime,
  RuntimeCapabilities,
  SessionOpts,
  MessageOpts,
  CommandIntentOpts,
  SseResponse,
  AgentRegistryPort,
  RelayPort,
  SessionSettingsPort,
  McpAppServerConnection,
  InteractionAnswerOptions,
  ToolDecisionOptions,
  SessionWarmth,
  DeliverIntoTurnOpts,
  RuntimeDeliveryResult,
  SessionUpdateResult,
  InterruptReceipt,
  LiveSessionRef,
} from '@dorkos/shared/agent-runtime';
import type {
  SessionSnapshot,
  SessionEvent,
  SessionListEvent,
} from '@dorkos/shared/session-stream';
import type { RuntimeCommandIntentId } from '@dorkos/shared/command-intents';
import { CLAUDE_CODE_CAPABILITIES, narrowToClaudeCodeMode } from './runtime-constants.js';
import './sessions/bounded-control.js';
import { SessionStore, isOriginalClaudeSessionAlias } from './sessions/session-store.js';
import { RuntimeCache } from './messaging/runtime-cache.js';
import {
  PluginReloadScheduler,
  type PaidPluginReload,
  type PluginReloadCacheImpact,
} from './messaging/plugin-reload-policy.js';
import {
  SessionLockManager,
  captureNativeSessionAcquisition,
  isOriginalNativeSessionAcquisitionAlias,
  type NativeSessionAcquisition,
} from '../../session/session-lock.js';
import type { AgentSession } from './agent-types.js';
import { resolveClaudeBinaryBeforePath, resolveClaudeCliPath } from './sdk/sdk-utils.js';
import { type LaunchAccountResolution } from './claude-config-dir.js';
import './credits-root.js';
import '@dorkos/shared/runtime-error-classification';
import './messaging/credits-launch.js';
import './claude-config-env-lock.js';
import { endSessionsWhere, type SessionEndingPort } from './end-sessions.js';
import { logger } from '../../../lib/logger.js';
import '../../../config/constants.js';
import { DEFAULT_CWD } from '../../../lib/resolve-root.js';
import { TranscriptReader } from './sessions/transcript-reader.js';
import type { SessionAttachmentStore } from '../../session/attachments/index.js';
import { SessionPumpRegistry } from './sessions/session-pump-registry.js';
import { CommandRegistryService } from './tooling/command-registry.js';
import './messaging/message-sender.js';
import type { McpServerFactory, MessageSenderOpts } from './messaging/message-sender-shared.js';
import { PersistentDispatch } from './sessions/persistent-dispatch.js';
import { BackgroundWorkLedger } from './messaging/background-work-ledger.js';
import './sessions/session-list-watcher.js';
import { homeOf, resolveAgentHome } from '../../core/agent-identity/index.js';
import '../../core/event-fan-out.js';
import '../../core/usage/account-eligibility.js';
import './launch-account-check.js';
import { peekProjector } from '../../session/session-state-projector.js';
import '../../session/overlays/approval-receipt-overlay.js';
import '../../session/overlays/permission-denial-overlay.js';
import '../../mesh/mcp-revocation.js';
import type { McpAuthEvidencePort } from '../../mesh/mcp-revocation.js';
import '../../diff/index.js';
import type { SessionStateProjector } from '../../session/index.js';
import type { ConnectorRuntimeTools } from '../connector-tools.js';

import './connector-turn-context.js';
import {
  refreshActivatedPlugins,
  reloadCommandsForLiveSessions,
  reloadPlugins,
} from './operations/claude-plugin-refresh-operations.js';
import {
  interruptQuery,
  checkSessionHealth,
} from './operations/claude-session-health-operations.js';
import {
  accountRootForSession,
  checkLaunchAccount,
  hasSettledAccount,
  renameSession,
} from './operations/claude-account-session-operations.js';
import {
  approveTool,
  submitAnswers,
  submitElicitation,
} from './operations/claude-interaction-answer-operations.js';
import {
  deliverIntoTurn,
  isHelperWorking,
  stopCreditsSessions,
  reapSession,
} from './operations/claude-live-turn-operations.js';
import { buildSenderOpts } from './operations/claude-sender-options-operations.js';
import {
  reportMcpAuthFailures,
  broadcastCommandsChanged,
  recordPaidPluginReload,
  forgetProjectCommands,
} from './operations/claude-runtime-notification-operations.js';
import { createMessage, sendOwnedMessage } from './operations/claude-owned-message-production.js';
import { installNativeTurn } from './operations/claude-native-turn-installation.js';
import { prepareRelayDocument } from './operations/claude-relay-document-preparation.js';
import { prepareRoomResponder } from './operations/claude-room-responder-preparation.js';
import type {
  OriginalClaudeNativeInstallation,
  OriginalClaudeNativePreparationView,
} from './custody/claude-native-preparation-contracts.js';
import { projectOriginalClaudePreparationView } from './custody/claude-preparation-view-projection.js';
import { projectOriginalClaudeSessionQueryView } from './custody/claude-session-query-view-projection.js';
import { projectOriginalClaudeCommandCacheView } from './custody/claude-command-cache-view-projection.js';
import { projectOriginalClaudeRelayView } from './custody/claude-relay-view-projection.js';
import {
  recheckHeldReload,
  applyHeldReload,
  resolveReloadableSession,
} from './operations/claude-held-plugin-reload-operations.js';
import { createClaudeIntrospectionSession } from './custody/claude-introspection-session-data.js';
const originalClaudePreparationCustody = createIsolatedClaudePreparationViews();
const originalClaudePreparationFreeze = Object.freeze;
/** Resolve only the original runtime's inaccessible native preparation key before any effects. */
export const readOriginalClaudeNativePreparationView = originalClaudePreparationCustody.read;

import { assembleOriginalClaudeRelayConstruction } from './operations/claude-relay-construction.js';
import type { OriginalClaudeRelayConstructionView } from './custody/claude-relay-construction-contracts.js';
const originalClaudeRelayConstructionCustody = createIsolatedClaudeRelayConstructionViews();
const originalClaudeRelayConstructionFreeze = Object.freeze;
/** Read only the actual runtime constructor's private relay assembly view. */
export const readOriginalClaudeRelayConstructionView = originalClaudeRelayConstructionCustody.read;

/** Run Claude Code sessions with their original SDK and native turn lifetimes. */
export class ClaudeCodeRuntime implements AgentRuntime {
  readonly #relayConstructionKey = originalClaudeRelayConstructionFreeze({});
  readonly #nativePreparationKey = originalClaudePreparationFreeze({});
  readonly #commandCacheKey = originalClaudeCommandFreeze({});
  readonly #sessionQueryKey = originalClaudeSessionQueryFreeze({});
  readonly type = 'claude-code' as const;

  // Collaborators
  private readonly sessionStore = new SessionStore();
  private readonly cache: RuntimeCache;
  private readonly transcriptReader: TranscriptReader;
  private readonly lockManager = new SessionLockManager();
  /**
   * The warm SDK processes this runtime holds (spec `persistent-session-runtime`
   * §4). Empty until a session opts in: with
   * `runtimes.claudeCode.persistentSession` off — how it ships — nothing
   * launches a pump, every session reads `cold`, and every reap is a no-op,
   * which is the truth rather than a stub.
   *
   * Keyed through `sessionStore.sessionKeyOf` (below), the ONE resolver that
   * answers "which key is this session's pump filed under" whichever id in
   * its rename chain the caller holds (DOR-1309).
   */
  private readonly pumps = new SessionPumpRegistry((id) => this.sessionStore.sessionKeyOf(id));
  /**
   * The path a message takes when its session holds its process open. Reads the
   * opt-in per session and wires the pump, the turn windower and the crash
   * policy together; see `sessions/persistent-dispatch.ts`. Shares
   * {@link pumps}'s SAME resolver, so the two structures can never learn about
   * a rekey at different times.
   */
  readonly #persistent = new PersistentDispatch(
    this.pumps,
    (id) => this.sessionStore.sessionKeyOf(id),
    (sessionId, impact, contextTokens) =>
      this.notePluginReloadHeld(sessionId, impact, contextTokens),
    // Read on use: the ledger is built in the constructor, after this field.
    () => this.backgroundWork
  );
  /**
   * The durable record of chats whose warm process holds background work, in
   * this runtime's data directory (DOR-2065).
   */
  private readonly backgroundWork: BackgroundWorkLedger;
  /**
   * Plugin reloads this runtime asked for and the CLI held back, waiting for a
   * moment when applying them is free (spec `plugin-reload-cache-cost`).
   *
   * Given the runtime's own session store to read a session's clock from, and
   * this runtime's plain reload to apply with — so a held reload lands through
   * exactly the same call as an unheld one.
   */
  private readonly pluginReloads = new PluginReloadScheduler({
    recheck: (sessionId) => this.recheckHeldPluginReload(sessionId),
    applyNow: (sessionId) => this.applyHeldPluginReload(sessionId),
    recordPaidReload: (entry) => this.recordPaidPluginReload(entry),
  });
  /** What ending a session outright reads (`end-sessions.ts`): a pause, an unlink, an eviction. */
  private readonly ending: SessionEndingPort = {
    sessionStore: this.sessionStore,
    pumps: this.pumps,
    persistent: this.#persistent,
    lockManager: this.lockManager,
    pluginReloads: this.pluginReloads,
    interruptQuery: (id) => this.interruptQuery(id),
    getSessionCwd: (id) => this.getSessionCwd(id),
  };
  private commandRegistries = new Map<string, CommandRegistryService>();
  private static readonly MAX_COMMAND_REGISTRIES = 50;

  // Configuration
  private readonly cwd: string;
  /**
   * The binary every spawn is pointed at, as last resolved. Read through
   * {@link spawnBinaryPath}, never directly — while it is `undefined` the ladder
   * is re-walked, which is what lets a one-click install reach the very next
   * session (DOR-1334).
   */
  private claudeCliPath: string | undefined;

  // Injected dependencies
  private mcpServerFactory: McpServerFactory | null = null;
  private meshCore: AgentRegistryPort | null = null;
  /** Internal connector tool boundary, installed after boot opens its listener. */
  private connectorRuntimeTools: ConnectorRuntimeTools | undefined;
  private readonly accountsAccess = new AccountsAccessContext();
  private mcpAuthEvidence: McpAuthEvidencePort | undefined;
  private pluginReloadActivity: PluginReloadActivityPort | undefined;
  private bindingRouter: import('../../relay/binding-router.js').BindingRouter | undefined;
  private bindingStore: import('../../relay/binding-store.js').BindingStore | undefined;
  private adapterManager: import('../../relay/adapter-manager.js').AdapterManager | undefined;

  /**
   * Cached Claude Agent SDK `options.plugins` array for the current set of
   * GLOBALLY installed marketplace packages. Empty until
   * `refreshActivatedPlugins()` is called; mutated by that method. This is the
   * only plugin set passed to the SDK: PROJECT-scoped installs are no longer
   * SDK-injected; they reach Claude Code as harness-native projected files
   * (command wrappers, skill symlinks, `.claude/settings.local.json` hooks) via
   * `@dorkos/harness`, so external CLI and DorkOS sessions see the same thing
   * (ADR 260706-192819, amending ADR-0239). Global-scope projection is deferred
   * (DOR-174), so global installs keep SDK injection for now. A global package
   * that runs anything on its own is in it only when a person approved exactly
   * what it runs (`marketplace/global-plugin-consent.ts`, DOR-2306).
   */
  private activatedPlugins: Array<{ type: 'local'; path: string }> = [];

  /**
   * cwds with a command-cache warm probe currently in flight. Dedupes
   * concurrent `getCommands` calls so one cold cwd spawns at most one probe.
   */
  private readonly warmingCwds = new Set<string>();

  /**
   * Last warm-probe failure time (epoch ms) per cwd. Bounds re-probing when the
   * SDK is persistently broken: `warmingCwds` only dedupes concurrent probes, so
   * without this a broken runtime would spawn a fresh timeout-length subprocess
   * on every cold `getCommands` (remount, stale-time expiry, each new cwd).
   */
  private readonly warmFailedAt = new Map<string, number>();

  /** Defensive cap on how long a warm probe waits for `supportedCommands()`. */
  private static readonly WARM_TIMEOUT_MS = 8_000;

  /** After a warm failure, skip re-probing the same cwd for this long. */
  private static readonly WARM_FAILURE_COOLDOWN_MS = 60_000;

  /**
   * Where images this runtime's turns produce are stored, or `null` when the
   * composition root wired none. What makes {@link getCapabilities} answer
   * `mediaOutput: 'attachments'`.
   */
  private readonly attachments: SessionAttachmentStore | null;

  /**
   * Build the runtime over a data directory and a default working directory.
   *
   * @param dorkHome - The resolved data directory.
   * @param cwd - The default working directory.
   * @param attachments - Where a turn's images go. Omitted, the runtime
   *   declares `mediaOutput: 'none'` and says so per image rather than dropping
   *   one quietly — see {@link getCapabilities}.
   */
  readonly #roomPreparing = new Map<string, { retired: boolean }>();

  constructor(dorkHome: string, cwd?: string, attachments?: SessionAttachmentStore) {
    claudeNativeConstructors.add(this);
    const originalLocks = this.lockManager;
    claudeOriginalStores.set(this, this.sessionStore);
    const originalStore = this.sessionStore;
    claudeOriginalLaunchAliases.set(this, (request, retiredId) => {
      const launch = readOriginalRoomLaunchHolder(request);
      if (
        !launch ||
        (readOriginalRegisteredRuntime(launch.runtime) ?? launch.runtime) !== this ||
        !isOriginalClaudeSessionAlias(originalStore, retiredId, launch.key)
      )
        return false;
      const acquisition = captureNativeSessionAcquisition(originalLocks, launch.key, launch.holder);
      return (
        !!acquisition &&
        isOriginalNativeSessionAcquisitionAlias(
          originalLocks,
          acquisition,
          launch.holder,
          launch.key,
          retiredId
        ) &&
        readOriginalRoomLaunchHolder(request) === launch &&
        isOriginalClaudeSessionAlias(originalStore, retiredId, launch.key)
      );
    });
    /** Build the fixed relay callback view inside its original runtime constructor. */
    function createOriginalClaudeRelayConstructionView(
      owner: ClaudeCodeRuntime
    ): Readonly<OriginalClaudeRelayConstructionView> {
      return projectOriginalClaudeRelayView({
        runtime: owner,
        originalLocks,
        connectorRuntimeTools: () => owner.connectorRuntimeTools,
        relayPreparing: () => owner.#relayPreparing,
        claudeRelayDriverStops,
        claudeRelayDrivers,
        claudeRelayPreparers,
        claudeRelayPrepared,
        originalRelayClosedTurns,
        originalRelayClosedTurnReaders,
        claudeRoomPreparers,
        claudeLockMoves,
        claudeRuntimeEntries,
        claudeLockedRunners,
        prepareRelayDocument: (source, target, acquisition) =>
          owner.#prepareRelayDocument(source, target, acquisition),
        prepareRoomResponder: (source, target, acquisition) =>
          owner.#prepareRoomResponder(source, target, acquisition),
        createMessage: (sessionId, content, opts, acquisition, roomOrigin, roomPrepared) =>
          owner.#createMessage(sessionId, content, opts, acquisition, roomOrigin, roomPrepared),
      });
    }
    originalClaudeRelayConstructionCustody.register(
      this.#relayConstructionKey,
      createOriginalClaudeRelayConstructionView(this)
    );
    assembleOriginalClaudeRelayConstruction(this.#relayConstructionKey);
    this.attachments = attachments ?? null;
    this.cwd = cwd ?? DEFAULT_CWD;
    this.claudeCliPath = resolveClaudeCliPath();
    this.cache = new RuntimeCache(dorkHome);
    this.backgroundWork = new BackgroundWorkLedger(dorkHome);
    this.cache.setDefaultCwd(this.cwd);
    // Warm-up spawns the SDK too; give it the same resolved binary path so it
    // works in the packaged desktop app (see setClaudeCliPath's doc).
    this.cache.setClaudeCliPath(this.claudeCliPath);
    // The account probe spawns too; it runs the binary a session would.
    setAccountProbeBinaryResolver(() => this.spawnBinaryPath);
    this.transcriptReader = new TranscriptReader();
    /** Build the original fixed query view inside its owning runtime constructor. */
    function createClaudeSessionQueryView(
      owner: ClaudeCodeRuntime
    ): Readonly<OriginalClaudeSessionQueries> {
      return projectOriginalClaudeSessionQueryView({
        owner,
        transcriptReader: () => owner.transcriptReader,
        sessionStore: () => owner.sessionStore,
        cwd: () => owner.cwd,
        attachments: () => owner.attachments,
        getInternalSessionId: () => owner.getInternalSessionId,
        resolveLiveProjector: () => owner.resolveLiveProjector,
        getMessageHistory: () => owner.getMessageHistory,
        streamProjector: () => owner.streamProjector,
      });
    }
    originalClaudeSessionQueries.register(
      this.#sessionQueryKey,
      createClaudeSessionQueryView(this)
    );
    /** Build the original fixed command-cache view inside its owning runtime constructor. */
    function createClaudeCommandCacheView(
      owner: ClaudeCodeRuntime
    ): Readonly<OriginalClaudeCommands> {
      return projectOriginalClaudeCommandCacheView({
        owner,
        cache: () => owner.cache,
        cwd: () => owner.cwd,
        warmingCwds: () => owner.warmingCwds,
        warmFailedAt: () => owner.warmFailedAt,
        activatedPlugins: () => owner.activatedPlugins,
        spawnBinaryPath: () => owner.spawnBinaryPath,
        commandRegistries: () => owner.commandRegistries,
        MAX_COMMAND_REGISTRIES: () => ClaudeCodeRuntime.MAX_COMMAND_REGISTRIES,
        WARM_FAILURE_COOLDOWN_MS: () => ClaudeCodeRuntime.WARM_FAILURE_COOLDOWN_MS,
        WARM_TIMEOUT_MS: () => ClaudeCodeRuntime.WARM_TIMEOUT_MS,
        getOrCreateRegistry: () => owner.getOrCreateRegistry,
        warmCommands: () => owner.warmCommands,
        recordWarmFailure: () => owner.recordWarmFailure,
        broadcastCommandsChanged: () => owner.broadcastCommandsChanged,
      });
    }
    originalClaudeCommands.register(this.#commandCacheKey, createClaudeCommandCacheView(this));
    /** Build the fixed native preparation view inside its original runtime constructor. */
    function createOriginalClaudePreparationView(
      owner: ClaudeCodeRuntime
    ): OriginalClaudeNativePreparationView {
      return projectOriginalClaudePreparationView({
        owner,
        runtime: owner,
        cache: () => owner.cache,
        lockManager: () => owner.lockManager,
        pluginReloads: () => owner.pluginReloads,
        pumps: () => owner.pumps,
        activatedPlugins: () => owner.activatedPlugins,
        writeActivatedPlugins: (value) => {
          owner.activatedPlugins = value;
        },
        broadcastCommandsChanged: () => owner.broadcastCommandsChanged,
        forgetProjectCommands: () => owner.forgetProjectCommands,
        reloadCommandsForLiveSessions: () => owner.reloadCommandsForLiveSessions,
        recordPaidPluginReload: () => owner.recordPaidPluginReload,
        notifyInteractionResolved: () => owner.notifyInteractionResolved,
        interruptQuery: () => owner.interruptQuery,
        attachments: () => owner.attachments,
        adapterManager: () => owner.adapterManager,
        bindingRouter: () => owner.bindingRouter,
        bindingStore: () => owner.bindingStore,
        mcpServerFactory: () => owner.mcpServerFactory,
        spawnBinaryPath: () => owner.spawnBinaryPath,
        mcpAuthEvidence: () => owner.mcpAuthEvidence,
        pluginReloadActivity: () => owner.pluginReloadActivity,
        warmFailedAt: () => owner.warmFailedAt,
        connectorAgentFor: (cwdKey, turnAgent) => owner.#connectorAgentFor(cwdKey, turnAgent),
        reportMcpAuthFailures: () => owner.reportMcpAuthFailures,
        getOrCreateRegistry: () => owner.getOrCreateRegistry,
        sessionStore: () => owner.sessionStore,
        reloadableSession: () => owner.reloadableSession,
        accountsAccess: () => owner.accountsAccess,
        originalClaudeLockedStreams,
        originalClaudeRoomStreams,
        originalClaudePersistentRequests,
        connectorRuntimeTools: () => owner.connectorRuntimeTools,
        meshCore: () => owner.meshCore,
        transcriptReader: () => owner.transcriptReader,
        cwd: () => owner.cwd,
        persistent: () => owner.#persistent,
        ending: () => owner.ending,
        relayPreparing: () => owner.#relayPreparing,
        roomPreparing: () => owner.#roomPreparing,
        claudeRuntimeEntries,
        claudeOriginalStores,
        claudeRoomQuerySessions,
        claudeNativeConstructors,
        claudeNativeOperations,
        claudeOriginalSessionOperations,
        claudeRoomPrepared,
        claudeRelayPrepared,
        originalRelayLaunchPreparations,
        sendOwnedMessage: (sessionId, content, opts, lifetime) =>
          owner.#sendOwnedMessage(sessionId, content, opts, lifetime),
        installNativeTurn: (
          sessionId,
          session,
          cwdKey,
          agentPath,
          meshAgent,
          acquisition,
          refuseExisting,
          roomOrigin,
          relayOwner
        ) =>
          owner.#installNativeTurn(
            sessionId,
            session,
            cwdKey,
            agentPath,
            meshAgent,
            acquisition,
            refuseExisting,
            roomOrigin,
            relayOwner
          ),
        buildSenderOpts: (sessionId, session, cwdKey, turnAgent) =>
          owner.#buildSenderOpts(sessionId, session, cwdKey, turnAgent),
        createMessage: (sessionId, content, opts, acquisition, roomOrigin, roomPrepared) =>
          owner.#createMessage(sessionId, content, opts, acquisition, roomOrigin, roomPrepared),
      });
    }
    originalClaudePreparationCustody.register(
      this.#nativePreparationKey,
      createOriginalClaudePreparationView(this)
    );
  }

  /**
   * The Claude Code binary to spawn, refreshed when there wasn't one.
   *
   * Resolution at construction is the fast path and, once it has succeeded, the
   * answer is kept: a resolved binary does not move underneath a running server.
   * The case that DOES change underneath it is the empty one — a host with no
   * `claude` anywhere is exactly the host where somebody presses "Install
   * Claude", and the provisioner writes a binary the ladder can now see. Without
   * this re-check the requirements payload flipped to Ready while every session
   * started afterwards still spawned with no `pathToClaudeCodeExecutable`, so
   * the SDK self-resolved and threw until the server was restarted (DOR-1334
   * review).
   *
   * The re-check walks only the rungs that touch the filesystem
   * ({@link resolveClaudeBinaryBeforePath}: env override → bundled →
   * provisioned) — a few `existsSync` calls, never the synchronous `which`,
   * which must not run on a spawn path. A newly-installed `claude` on `PATH`
   * therefore still needs the next restart; a provisioned one does not, and
   * provisioning is the path DorkOS itself offers.
   */
  private get spawnBinaryPath(): string | undefined {
    if (this.claudeCliPath) return this.claudeCliPath;
    const refreshed = resolveClaudeBinaryBeforePath() ?? undefined;
    if (refreshed) {
      this.claudeCliPath = refreshed;
      // The warm-up query spawns too, and reads its own copy.
      this.cache.setClaudeCliPath(refreshed);
      logger.info('[ClaudeCode] resolved a Claude Code binary that was missing at startup', {
        binary: refreshed,
      });
    }
    return refreshed;
  }

  /** Warm up the model cache by fetching models from the SDK. */
  async warmup(): Promise<void> {
    return this.cache.warmup(this.cwd);
  }

  // ---------------------------------------------------------------------------
  // Capabilities
  // ---------------------------------------------------------------------------

  /**
   * Return static Claude Code capability flags.
   *
   * `mediaOutput` is resolved per INSTANCE rather than baked into
   * {@link CLAUDE_CODE_CAPABILITIES}, because it is the one capability here that
   * depends on how the runtime was wired: with no attachment store there is
   * nowhere to put an image, and claiming otherwise would be exactly the silent
   * promise this field exists to end. Same arrangement as the OpenCode adapter.
   */
  getCapabilities(): RuntimeCapabilities {
    if (!this.attachments) return CLAUDE_CODE_CAPABILITIES;
    return { ...CLAUDE_CODE_CAPABILITIES, mediaOutput: 'attachments' };
  }

  /** Check whether the Claude Code CLI binary is available and Claude is authenticated. */
  async checkDependencies(): Promise<import('@dorkos/shared/agent-runtime').DependencyCheck[]> {
    const { checkClaudeDependencies } = await import('./tooling/check-dependency.js');
    return checkClaudeDependencies();
  }

  // ---------------------------------------------------------------------------
  // Dependency injection
  // ---------------------------------------------------------------------------

  /** Set the agent registry for agent manifest resolution and peer agent context. */
  setMeshCore(meshCore: AgentRegistryPort): void {
    this.meshCore = meshCore;
  }

  /** Install the internal connector tool boundary after its listener starts. */
  setConnectorRuntimeTools(tools: ConnectorRuntimeTools): void {
    this.connectorRuntimeTools = tools;
  }

  /**
   * Inject the port that reacts to a managed MCP server refusing its credentials
   * mid-session (DOR-981).
   *
   * The SDK reports each MCP server's connection status once per turn, and
   * `needs-auth` there is the one place DorkOS ever learns that the bearer it
   * injected was rejected — the subprocess is what dials the server, so it is the
   * only thing that sees the 401. Everything the answer implies (evict, refresh,
   * draw a sign-in card) is somebody else's business, hence a port: this runtime
   * reports and forgets.
   */
  setMcpAuthEvidence(port: McpAuthEvidencePort | undefined): void {
    this.mcpAuthEvidence = port;
  }

  /**
   * Bound a plugin reload the warm-process pin held on the way into a turn
   * (spec `plugin-reload-cache-cost`).
   *
   * That path holds without an install behind it — a scope change, an agent
   * change, an uninstall all move the `plugins` pin — and its own recovery is
   * only "the next dispatch asks again", which on a session that dispatches all
   * afternoon never ends. Reporting the hold here puts it under the same
   * ceiling as every other one, so it is applied and paid for eventually
   * instead of re-asked for ever.
   *
   * Idempotent, and it never restarts a wait already running: the scheduler
   * folds a repeat hold into the first record.
   *
   * @param sessionId - The session whose pin stayed put
   * @param impact - What the CLI said applying would change
   * @param contextTokens - Size of the conversation at that moment
   */
  private notePluginReloadHeld(
    sessionId: string,
    impact: PluginReloadCacheImpact,
    contextTokens: number | undefined
  ): void {
    this.pluginReloads.hold({ sessionId, impact, contextTokens });
  }

  /**
   * Inject the port that writes a paid plugin reload to the activity feed.
   *
   * A port rather than a direct dependency for the same reason as the one above:
   * this runtime knows what a reload disturbed and what it waited for, and
   * nothing about where such a fact is kept. Without the port the reloads still
   * happen and still reach the debug log; only the feed entry is missing, which
   * is the right degradation for a record nothing depends on.
   */
  setPluginReloadActivity(port: PluginReloadActivityPort | undefined): void {
    this.pluginReloadActivity = port;
  }

  /**
   * Inject the core session-settings store (ADR-0260). Forwards it to the
   * session store along with this runtime's declared default permission mode,
   * so evicted/restarted sessions hydrate the operator's chosen settings.
   */
  setSessionSettings(port: SessionSettingsPort): void {
    this.sessionStore.configureSettings(
      port,
      // A descriptor's `id` is a plain string — a runtime names its own modes —
      // so the declared default is CHECKED into this adapter's narrower union
      // rather than asserted into it (DOR-885). `'default'` is the same answer
      // either way; the fallback exists because `permissionModes.default` is
      // optional on the capability shape.
      narrowToClaudeCodeMode(CLAUDE_CODE_CAPABILITIES.permissionModes.default, 'default')
    );
  }

  /** Inject relay binding context for outbound awareness. */
  setRelayBindingContext(
    bindingRouter: import('../../relay/binding-router.js').BindingRouter,
    bindingStore: import('../../relay/binding-store.js').BindingStore,
    adapterManager: import('../../relay/adapter-manager.js').AdapterManager
  ): void {
    this.bindingRouter = bindingRouter;
    this.bindingStore = bindingStore;
    this.adapterManager = adapterManager;
  }

  /** Inject a Relay core instance for Relay-aware context building. */
  setRelay(_relay: RelayPort): void {
    // No-op: broadcaster no longer needs relay.
    // Method retained to satisfy AgentRuntime interface.
  }

  /** Register a factory that creates fresh MCP tool server configs per query() call. */
  setMcpServerFactory(factory: McpServerFactory): void {
    this.mcpServerFactory = factory;
  }

  // ---------------------------------------------------------------------------
  // Internal service accessors
  // ---------------------------------------------------------------------------

  /** Expose the internal TranscriptReader for routes that need direct access. */
  getTranscriptReader(): TranscriptReader {
    return this.transcriptReader;
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle (delegated to SessionStore)
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  ensureSession(sessionId: string, opts: SessionOpts): void {
    this.sessionStore.ensureSession(sessionId, opts);
  }

  /** @inheritdoc */
  async forkSession(
    projectDir: string,
    sessionId: string,
    opts?: { upToMessageId?: string; title?: string }
  ): Promise<Session | null> {
    return this.sessionStore.forkSession(projectDir, sessionId, this.transcriptReader, opts);
  }

  /** @inheritdoc */
  hasSession(sessionId: string): boolean {
    return this.sessionStore.hasSession(sessionId);
  }

  /**
   * @inheritdoc
   *
   * The same three places {@link interruptQuery} looks for something to stop:
   * a dispatched turn's query, a persistent session's first turn still booting,
   * and a turn the agent started itself. A Relay delivery calls `sendMessage`
   * directly and arms the first, so it is seen here though the server never
   * dispatched it.
   */
  isTurnOpen(sessionId: string): boolean {
    return (
      this.sessionStore.findSession(sessionId)?.activeQuery !== undefined ||
      this.#persistent.bootingQuery(sessionId) !== undefined ||
      this.#persistent.runtimeTurnQuery(sessionId) !== undefined
    );
  }

  /** @inheritdoc */
  async updateSession(sessionId: string, opts: SessionSettings): Promise<SessionUpdateResult> {
    return this.sessionStore.updateSession(sessionId, opts);
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  /**
   * The registered agent a session's connector tools act for, when this
   * runtime has the connector boundary at all (DOR-2685).
   *
   * One answer for the per-turn connector context in {@link sendMessage} and
   * for whether the in-session server lists the connector tools, so the two
   * cannot disagree, and a stage that warms a process builds the same list as
   * the turn after it.
   *
   * @param cwdKey - The folder the turn or stage runs in
   * @param turnAgent - The agent a turn is dispatched as, when it names one
   * @returns The agent's home and its registry entry, or `undefined`
   */
  #connectorAgentFor(
    cwdKey: string,
    turnAgent?: string
  ):
    | { agentPath: string; meshAgent: NonNullable<ReturnType<AgentRegistryPort['getByPath']>> }
    | undefined {
    if (!this.connectorRuntimeTools) return undefined;
    const agentPath = homeOf(resolveAgentHome(cwdKey, turnAgent));
    const meshAgent = agentPath ? this.meshCore?.getByPath(agentPath) : undefined;
    return agentPath && meshAgent ? { agentPath, meshAgent } : undefined;
  }

  /**
   * Assemble the runtime ports one turn (or one staged warm-up) launches with.
   *
   * Extracted from {@link sendMessage} so {@link deliverIntoTurn}'s `stage` path
   * can boot a cold session with the SAME options a turn would — a stage that
   * warms a process must not build it differently from the message that follows
   * it, or the two would disagree about model, plugins and connectors.
   *
   * @param sessionId - The id this call was asked with (a hint the store resolves)
   * @param session - The resolved session record
   * @param cwdKey - The working directory the caches and command list key on
   * @param turnAgent - The agent a turn is dispatched as, when it names one
   */
  #buildSenderOpts(
    sessionId: string,
    session: AgentSession,
    cwdKey: string,
    turnAgent?: string
  ): MessageSenderOpts {
    return buildSenderOpts(this.#nativePreparationKey, sessionId, session, cwdKey, turnAgent);
  }

  /** @inheritdoc */
  sendMessage(sessionId: string, content: string, opts?: MessageOpts): AsyncGenerator<StreamEvent> {
    return this.#createMessage(sessionId, content, opts);
  }

  #createMessage(
    sessionId: string,
    content: string,
    opts: MessageOpts | undefined,
    acquisition?: NativeSessionAcquisition,
    roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>,
    roomPrepared?: ClaudePreparedRoomContinuation
  ): AsyncGenerator<StreamEvent> {
    return createMessage(
      this.#nativePreparationKey,
      sessionId,
      content,
      opts,
      acquisition,
      roomOrigin,
      roomPrepared
    );
  }

  #installNativeTurn(
    sessionId: string,
    session: AgentSession,
    cwdKey: string,
    agentPath: string | undefined,
    meshAgent: { id: string } | undefined,
    acquisition?: NativeSessionAcquisition,
    refuseExisting = false,
    roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>,
    relayOwner?: { retired: boolean; cleanupFailed?: boolean; cleanupCause?: unknown }
  ): OriginalClaudeNativeInstallation {
    return installNativeTurn(
      this.#nativePreparationKey,
      sessionId,
      session,
      cwdKey,
      agentPath,
      meshAgent,
      acquisition,
      refuseExisting,
      roomOrigin,
      relayOwner
    );
  }

  readonly #relayPreparing = new Map<
    string,
    { retired: boolean; cleanupFailed?: boolean; cleanupCause?: unknown }
  >();
  #prepareRelayDocument(
    source: OriginalFrozenRelayDocumentSource,
    target: Readonly<{ sessionId: string; agentPath: string; agentId: string }>,
    acquisition: NativeSessionAcquisition
  ): Promise<PreparedRelayDocumentResponder | undefined> {
    return prepareRelayDocument(this.#nativePreparationKey, source, target, acquisition);
  }

  #prepareRoomResponder(
    source: OriginalFrozenRoomSource,
    target: Readonly<{ sessionId: string; agentPath: string; agentId: string }>,
    acquisition: NativeSessionAcquisition
  ): Promise<PreparedRoomResponder | undefined> {
    return prepareRoomResponder(this.#nativePreparationKey, source, target, acquisition);
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
      roomPrepared?: ClaudePreparedRoomContinuation;
    }
  ): AsyncGenerator<StreamEvent> {
    return sendOwnedMessage(this.#nativePreparationKey, sessionId, content, opts, lifetime);
  }

  /**
   * Fulfill the runtime-fulfilled `compact` intent (ADR-0273) by sending the
   * `/compact` prompt through the SAME SDK send path a normal turn uses,
   * appending any trailing instructions the user typed (e.g.
   * `/compact focus on the API changes`) so they reach the CLI verbatim —
   * exactly what typing the command pre-DOR-109 did. This reuses DOR-107's
   * bare-passthrough: the command-skip guard (`getKnownCommands`, wired in
   * {@link sendMessage}) suppresses the neutral additional-context prepend on
   * the command turn, so `/compact` reaches Claude's CLI as a first-class slash
   * command and the turn's StreamEvents (including the `compact_boundary`) flow
   * back for the durable projector to drive — exactly like a turn. No new
   * Claude-SDK surface; it wraps the shipped `/compact` mechanism.
   * `CLAUDE_CODE_CAPABILITIES.commandIntents` gates the route before this is
   * ever called.
   *
   * DEFENSIVE NOTE: the bare passthrough is correct today because this path
   * never supplies `additionalContext` — with an empty context bag the sender
   * has nothing to prepend, so `/compact` reaches the CLI bare even on a COLD
   * `getKnownCommands` cache (which returns null before the first query for a
   * cwd). If this method ever starts passing `additionalContext`, the
   * warm-cache membership of `/compact` in `getKnownCommands` becomes
   * load-bearing for the prepend-suppression — a cold cache would then let
   * context leak onto the command turn. Revisit the guard before adding
   * context here.
   */
  async *executeCommandIntent(
    sessionId: string,
    _intent: RuntimeCommandIntentId,
    opts?: CommandIntentOpts
  ): AsyncGenerator<StreamEvent> {
    const instructions = opts?.instructions?.trim();
    const prompt = instructions ? `/compact ${instructions}` : '/compact';
    yield* this.sendMessage(sessionId, prompt, opts);
  }

  /**
   * Refresh the cached marketplace plugins array (marketplace-05,
   * ADR-0239) AND propagate the new command list so the chat command palette
   * catches up after an install/uninstall (UX-12). Should be called once at
   * server startup and whenever the install/uninstall/update pipeline mutates
   * the set of installed packages.
   *
   * Two layers of propagation, because the Claude Agent SDK's
   * `supportedCommands()` is captured ONCE at session init and never reflects
   * mid-session changes — a cold re-fetch returns the stale init-time list:
   *
   * 1. **Next query** — swap `activatedPlugins` so any session that starts (or
   *    resumes into) its next `sendMessage` launches with the new plugin set
   *    and reports the new commands at init.
   * 2. **Live sessions (instant)** — round-trip the SDK's `reload_plugins`
   *    control request on every session that still holds a reloadable query.
   *    The SDK reloads plugins from disk and returns the authoritative refreshed
   *    command list, which we write into the per-cwd cache so `GET /api/commands`
   *    reflects the change with no restart and no extra turn.
   *
   * After (2) it broadcasts a `commands_changed` event on the unified
   * `/api/events` stream so connected clients re-fetch the command registry
   * immediately. Sessions with no live query (never sent a message) cannot be
   * hot-reloaded — their commands appear on the next message instead. The
   * broadcast fires unconditionally so a freshly-loaded palette (cold cache)
   * still re-fetches and the install's effect is visible.
   *
   * A reload can add a plugin but never take one away, so a warm process that
   * loaded a plugin the new set drops is relaunched before its next turn
   * instead (`sessions/launch-fingerprint.ts`, DOR-2306); for the same reason a
   * reload after the set SHRANK is never held for what it costs the prompt
   * cache.
   *
   * Fails closed: a scan that cannot say which global packages a person
   * approved leaves every global plugin out. Reload failures are per session
   * and never block the others.
   */
  refreshActivatedPlugins(changedProjectPath?: string): Promise<void> {
    return refreshActivatedPlugins(this.#nativePreparationKey, changedProjectPath);
  }

  /**
   * Tell the command palette a project's commands changed, without touching
   * any session's plugins: drop that cwd's cached command list (and any
   * warm-probe cooldown) so the next fetch re-warms it, then broadcast
   * `commands_changed`.
   *
   * For a change that reaches a project as projected files (a project dev
   * link's edit, DOR-2696). A project package is not an SDK plugin, so live
   * sessions have nothing to reload; only the cached list is stale, and it
   * would otherwise stay stale until a restart.
   *
   * @param projectPath - The project whose commands changed.
   */
  refreshProjectCommands(projectPath: string): void {
    this.forgetProjectCommands(projectPath);
    this.broadcastCommandsChanged();
  }

  /** Drop a cwd's cached command list and its warm-probe cooldown. */
  private forgetProjectCommands(projectPath: string): void {
    return forgetProjectCommands(this.#nativePreparationKey, projectPath);
  }

  /**
   * Round-trip `reload_plugins` on every session that still holds a reloadable
   * SDK query, refreshing each session cwd's cached command list in place.
   *
   * Per-session failures are swallowed (logged at debug) so one dead
   * subprocess never blocks the others. Sessions that never ran a query expose
   * no query and are skipped — their commands populate on the next message.
   *
   * **This is the install fan-out, and it asks before it spends** (spec
   * `plugin-reload-cache-cost`). Nobody asked for this reload — somebody
   * installed a plugin, and one click reaches every open session at once — so
   * each session's reload goes through the cost check rather than paying a
   * cache rebuild on all of them at the same moment. A reload the person
   * triggered by hand does not come through here; see {@link reloadPlugins}.
   *
   * @param options.mayHold - False when the new set dropped a plugin: nothing
   *   waits on the cache then (the process itself is relaunched before its
   *   next turn, since a reload cannot unload a plugin).
   */
  private reloadCommandsForLiveSessions({ mayHold }: { mayHold: boolean }): Promise<void> {
    return reloadCommandsForLiveSessions(this.#nativePreparationKey, { mayHold });
  }

  /**
   * Ask again whether a held reload has become free, letting the runtime apply
   * it if it has.
   *
   * The SAME asking call that held it. DorkOS cannot work out when a prompt
   * cache goes cold — the lifetime is an hour on a Claude subscription and five
   * minutes on an API key, and DorkOS chooses neither
   * (`messaging/plugin-reload-policy.ts`) — so the runtime is asked rather than
   * second-guessed, and `held: false` means it has already applied the reload
   * for nothing.
   *
   * @param sessionId - The session to ask about
   * @returns True when the runtime applied the reload
   * @throws PluginReloadSessionGoneError When the session or its query is gone,
   *   which the scheduler reads as "no longer worth applying". A control request
   *   that goes unanswered throws something else, and keeps the wait alive.
   */
  private recheckHeldPluginReload(sessionId: string): Promise<boolean> {
    return recheckHeldReload(this.#nativePreparationKey, sessionId);
  }

  /**
   * Apply a held reload unconditionally, paying for the cache rebuild.
   *
   * The plain reload with no options, for the ceiling: the wait has gone on
   * long enough that running a plugin set the disk no longer matches costs more
   * than the rebuild does.
   *
   * @param sessionId - The session whose reload is being paid for
   * @throws PluginReloadSessionGoneError When the session or its query is gone
   */
  private applyHeldPluginReload(sessionId: string): Promise<void> {
    return applyHeldReload(this.#nativePreparationKey, sessionId);
  }

  /**
   * The session and the query a held reload has to be spoken to through.
   *
   * @param sessionId - The session to resolve
   * @returns The session record and its live or last query
   * @throws PluginReloadSessionGoneError When either is gone — the reload is
   *   moot, because the next launch reads the plugin set off disk
   */
  private reloadableSession(sessionId: string): { session: AgentSession; queryObj: Query } {
    return resolveReloadableSession(this.#nativePreparationKey, sessionId);
  }

  /**
   * Write one reload that changed a live session's tool list to the activity
   * feed.
   *
   * Only reloads that cost something get an entry: a reload the CLI waved
   * through disturbed no cached conversation and is nobody's business. The
   * estimate the session is never shown — how big the conversation was, and what
   * the reload disturbed — lives here and in the debug log, which is where
   * somebody auditing a day's spend would go looking.
   *
   * @param entry - What was paid, and whether it waited first
   */
  private recordPaidPluginReload(entry: PaidPluginReload): void {
    return recordPaidPluginReload(this.#nativePreparationKey, entry);
  }

  /**
   * Broadcast a `commands_changed` event on the unified `/api/events` stream so
   * connected clients invalidate their command-registry query and re-fetch.
   * Best-effort: a broadcast failure must never break the install path.
   */
  private broadcastCommandsChanged(): void {
    return broadcastCommandsChanged(this.#nativePreparationKey);
  }

  /**
   * Which Claude account this session runs and bills on — the same answer
   * `resolveLaunch` computes for a turn, for callers outside one.
   *
   * The ladder in full: the account disk has already bound to the session, else
   * the launch ladder (agent manifest pin → configured default → inherited
   * root). Running the launch half matters most for a session whose FIRST turn
   * failed: it has no transcript, so nothing has bound it yet, and an agent
   * pinned to a second account would otherwise resolve to the active one —
   * which is the wrong-account bug one rung down from DOR-1652.
   *
   * Not on the `AgentRuntime` port: accounts are a Claude-Code-only concept, and
   * widening the port for one runtime would oblige every other to answer a
   * question it has no notion of.
   *
   * @param sessionId - DorkOS or SDK session id.
   * @param projectDir - The session's working directory. Keys the transcript
   *   probe; the account pin is read from the home it resolves to, never from a
   *   `.dork/` the folder carries (spec `agent-home-desk` I1).
   * @returns An absolute Claude config directory, or `null` when no account may
   *   work in the folder's project.
   */
  accountRootForSession(sessionId: string, projectDir: string): Promise<string | null> {
    return accountRootForSession(this.#nativePreparationKey, sessionId, projectDir);
  }

  /**
   * Whether a send to this session may launch, as far as accounts go: the
   * account disk has already bound it to (always allowed; the rule applies
   * when an account is picked, never mid-conversation), else the launch
   * ladder for `hintId` in `projectDir`'s project (spec `flow-multiproject`
   * §8.4). Asked before a session starts, so a refused launch starts nothing.
   *
   * Not on the `AgentRuntime` port, for the reason `accountRootForSession`
   * gives.
   *
   * @param sessionId - DorkOS or SDK session id.
   * @param projectDir - The folder the session runs in.
   * @param hintId - The account a person picked for this session, if any.
   * @returns The account the launch would use, or the refusal.
   */
  checkLaunchAccount(
    sessionId: string,
    projectDir: string,
    hintId?: string
  ): Promise<LaunchAccountResolution> {
    return checkLaunchAccount(this.#nativePreparationKey, sessionId, projectDir, hintId);
  }

  /**
   * Whether this session has already settled on an account (it launched, and
   * disk says which account holds it). A session that has not, such as one
   * whose first turn was refused because DorkOS credits were unreachable, may
   * still take the person's pick of account on its next send.
   *
   * @param sessionId - DorkOS or SDK session id.
   * @param projectDir - The folder the session runs in.
   */
  hasSettledAccount(sessionId: string, projectDir: string): Promise<boolean> {
    return hasSettledAccount(this.#nativePreparationKey, sessionId, projectDir);
  }

  /** @inheritdoc */
  renameSession(sessionId: string, title: string, projectDir: string): Promise<void> {
    return renameSession(this.#nativePreparationKey, sessionId, title, projectDir);
  }

  // ---------------------------------------------------------------------------
  // Interactive flows (delegated to SessionStore)
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  approveTool(
    sessionId: string,
    toolCallId: string,
    approved: boolean,
    options?: ToolDecisionOptions
  ): boolean {
    return approveTool(this.#nativePreparationKey, sessionId, toolCallId, approved, options);
  }

  /** @inheritdoc */
  submitAnswers(
    sessionId: string,
    toolCallId: string,
    answers: Record<string, string>,
    options?: InteractionAnswerOptions
  ): boolean {
    return submitAnswers(this.#nativePreparationKey, sessionId, toolCallId, answers, options);
  }

  /** @inheritdoc */
  submitElicitation(
    sessionId: string,
    interactionId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>,
    options?: InteractionAnswerOptions
  ): boolean {
    return submitElicitation(
      this.#nativePreparationKey,
      sessionId,
      interactionId,
      action,
      content,
      options
    );
  }

  /**
   * Emit `interaction_resolved` through the projector so every live `/events`
   * subscriber (this window, other windows, a later replay) drops the pending
   * card — without this the resolution was only observable via the next
   * snapshot, leaving ghost Approve/Deny cards and a `blocked` projection.
   * Peeks under the client-facing id first, then the canonical alias (a
   * pre-rekey projector may still be keyed by the request UUID's canonical id).
   *
   * `opts.answeredBy` rides along untouched. This adapter never resolves a name
   * of its own: whoever called in is the only thing that knows who answered, so
   * an answer that arrived with nobody named stays unnamed all the way to the
   * receipt.
   */
  private notifyInteractionResolved(
    sessionId: string,
    interactionId: string,
    resolution: 'approved' | 'denied' | 'answered',
    opts?: { reasonGiven?: boolean; answeredBy?: string }
  ): void {
    this.resolveLiveProjector(sessionId)?.resolveInteraction(interactionId, resolution, opts);
  }

  /**
   * Resolve the LIVE projector for a session id through the id alias, in either
   * direction: the registry is single-keyed (ADR-0267) and `rekeyProjector`
   * moves a brand-new session's entry from the request UUID to the canonical id
   * mid-first-turn, so a caller may legitimately hold EITHER id while the other
   * one owns the registry entry (acceptance run 20260610-173202, F2: the
   * sidebar navigates by canonical id while the first turn streams under the
   * request UUID — and a pre-remap client URL holds the request UUID after the
   * rekey lands). Returns `undefined` when neither key has a projector.
   */
  private resolveLiveProjector(sessionId: string): SessionStateProjector | undefined {
    return (
      peekProjector(sessionId) ?? peekProjector(this.getInternalSessionId(sessionId) ?? sessionId)
    );
  }

  /** @inheritdoc */
  async stopTask(sessionId: string, taskId: string): Promise<InterruptReceipt> {
    return this.sessionStore.stopTask(sessionId, taskId);
  }

  /** @inheritdoc */
  interruptQuery(sessionId: string): Promise<InterruptReceipt> {
    return interruptQuery(this.#nativePreparationKey, sessionId);
  }

  /** @inheritdoc */
  deliverIntoTurn(
    sessionId: string,
    content: string,
    opts: DeliverIntoTurnOpts
  ): Promise<RuntimeDeliveryResult> {
    return deliverIntoTurn(this.#nativePreparationKey, sessionId, content, opts);
  }

  /**
   * @inheritdoc
   *
   * Steering here rides the persistent pump's held input stream, so the honest
   * answer is the same question `dispatch` asks before every message: will this
   * session's next turn run on a held process? A session already holding one is
   * steerable whatever the setting says now (turning the opt-in OFF does not
   * take a warm session back), and a session holding none is steerable only if
   * the opt-in would give it one. On the resume path — how a default install
   * ships — the answer is `false`, and `deliverIntoTurn` reports `no-open-turn`
   * for a turn that is plainly running (DOR-1268).
   *
   * Deliberately NOT {@link getSessionWarmth}: warmth is about the process this
   * instant (`warm` vs `running`), and a steer offered only while a turn is
   * already open would flicker with the turn rather than describe the session.
   */
  canSteerSession(sessionId: string): boolean {
    return this.#persistent.shouldDispatch(sessionId);
  }

  /**
   * @inheritdoc
   *
   * The same question as {@link canSteerSession}, and for this runtime the same
   * answer — because both rides are the same ride. A native stage appends to the
   * pump's held input stream (`shouldQuery: false`), so a session that will not
   * run its next turn on a held process has no transcript to append to.
   *
   * They stay two methods because they are two claims about two mechanisms, and a
   * runtime can honestly hold one without the other: test-mode declares both while
   * holding no process at all, and a backend with a transcript API but no mid-turn
   * injection would be stageable and not steerable. That claude-code answers them
   * identically is a fact about claude-code, not about the contract.
   *
   * The `false` here is not a refusal. It routes the words to the server's
   * fold-into-next fallback, which is why the composer keeps offering Add context
   * on both paths — and why answering honestly costs the person nothing, while
   * answering `true` cost them a subprocess they never asked for (DOR-1307).
   */
  canStageSession(sessionId: string): boolean {
    return this.#persistent.shouldDispatch(sessionId);
  }

  /**
   * @inheritdoc
   *
   * Only the pump path can strand a turn: on the resume path a turn IS its
   * stream, so a session with nothing held answers `false` without touching
   * anything. Asked with the same id `sendMessage` is asked with, because that
   * is the id the pump's wiring is filed under.
   */
  settleOpenTurn(sessionId: string): Promise<boolean> {
    return Promise.resolve(this.#persistent.settleOpenTurn(sessionId));
  }

  /**
   * @inheritdoc
   *
   * Only the pump path produces these: a turn on the resume path IS the stream
   * the caller asked for, so a session with no held process can never speak
   * between turns. The dispatcher holds the warm process's own bookkeeping, so
   * the subscription rides it rather than being kept here.
   */
  onRuntimeTurn(
    listener: (sessionId: string, events: AsyncIterable<StreamEvent>) => void
  ): () => void {
    return this.#persistent.onRuntimeTurn(listener);
  }

  /** @inheritdoc */
  isSegmentPending(sessionId: string): boolean {
    return this.#persistent.isSegmentPending(sessionId);
  }

  /** @inheritdoc */
  onDispatchGateChange(listener: (sessionId: string) => void): () => void {
    return this.#persistent.onDispatchGateChange(listener);
  }

  /** @inheritdoc */
  switchWhenReady(sessionId: string): boolean {
    return this.#persistent.switchWhenReady(sessionId);
  }

  /** @inheritdoc */
  onDispatchedTurn(listener: (sessionId: string) => void): () => void {
    return this.#persistent.onDispatchedTurn(listener);
  }

  /** @inheritdoc */
  holdsBackgroundWork(sessionId: string): boolean {
    // The warm path only. A resumed turn's process ends with its turn, and the
    // CLI ends its own background work with it, so nothing can follow.
    return this.#persistent.holdsBackgroundWork(sessionId);
  }

  /** @inheritdoc */
  isHelperWorking(sessionId: string): boolean {
    return isHelperWorking(this.#nativePreparationKey, sessionId);
  }

  /** @inheritdoc */
  getSessionWarmth(sessionId: string): SessionWarmth {
    return this.pumps.warmth(sessionId);
  }

  /**
   * Stop every session running on DorkOS credits: interrupt a turn in flight
   * and give back a warm process. Called when this computer is unlinked, so no
   * process keeps a credits token after the link it was minted under is gone
   * (ADR 261001-000811). The sessions themselves stay; their next turn is
   * refused until credits can be had again.
   */
  stopCreditsSessions(): Promise<void> {
    return stopCreditsSessions(this.#nativePreparationKey);
  }

  /**
   * @inheritdoc
   *
   * Asks the session store, which holds every session this process has run,
   * and skips the cold ones with nothing running. Each live one is ended, all
   * at once, as an unlink ends a credits session: its turn interrupted, its
   * process evicted (`end-sessions.ts`).
   */
  async endSessionsWhere(belongs: (session: LiveSessionRef) => boolean): Promise<string[]> {
    return endSessionsWhere(this.#nativePreparationKey, belongs);
  }

  /** @inheritdoc */
  reapSession(sessionId: string): Promise<void> {
    return reapSession(this.#nativePreparationKey, sessionId);
  }

  // ---------------------------------------------------------------------------
  // Session queries (delegated to TranscriptReader)
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  async listSessions(projectDir: string): Promise<Session[]> {
    return originalClaudeSessionQueryOperations.listSessions(this.#sessionQueryKey, projectDir);
  }

  /**
   * @inheritdoc
   *
   * One store per Claude account: an account DorkOS cannot read costs that
   * account's sessions and nothing else, so the accounts that read still list
   * (spec `claude-code-accounts` AC6).
   */
  async listSessionsWithWarnings(
    projectDir: string
  ): Promise<{ sessions: Session[]; warnings: SessionListWarning[] }> {
    return originalClaudeSessionQueryOperations.listSessionsWithWarnings(
      this.#sessionQueryKey,
      projectDir
    );
  }

  /** @inheritdoc */
  async findSession(sessionId: string): Promise<Session | null> {
    return originalClaudeSessionQueryOperations.findSession(this.#sessionQueryKey, sessionId);
  }

  async getSession(projectDir: string, sessionId: string): Promise<Session | null> {
    return originalClaudeSessionQueryOperations.getSession(
      this.#sessionQueryKey,
      projectDir,
      sessionId
    );
  }

  /**
   * Whether this session bills per token rather than against its account's
   * subscription (spec `claude-account-fleet` §6 U): what its last launch here
   * did, else whether it has had a subscription reading of its own, else what
   * its next launch would do, read off the environment a launch would get (a
   * stored key, credits, or one inherited from the server's own environment),
   * and per token when that cannot be told. A per-token session's `usage` stays
   * its own cost.
   *
   * Not on the `AgentRuntime` port, for the reason `accountRootForSession`
   * is not: accounts are a Claude-Code-only concept.
   *
   * @param sessionId - DorkOS or SDK session id.
   */
  async sessionBillsPerToken(sessionId: string): Promise<boolean> {
    return originalClaudeSessionQueryOperations.sessionBillsPerToken(
      this.#sessionQueryKey,
      sessionId
    );
  }

  /**
   * @inheritdoc
   *
   * The transcript tail's last assistant usage: the same bounded 64 KB read
   * the session list's `contextTokens` comes from (`readTailStatus`), cached
   * under the file's mtime. The transcript records no context window and the
   * SDK's model list carries none either (`runtime-cache.ts`), so the window is
   * `0`, which every reader shows as an unknown percentage until a turn reports
   * the real one.
   */
  async readContextUsage(
    sessionId: string,
    cwd: string | undefined
  ): Promise<{ contextTokens: number; contextMaxTokens: number } | null> {
    return originalClaudeSessionQueryOperations.readContextUsage(
      this.#sessionQueryKey,
      sessionId,
      cwd
    );
  }

  /**
   * @inheritdoc
   *
   * The transcript is SDK JSONL, which records that a tool ran or did not and
   * nothing about a person having been asked first — so the permission
   * decisions DorkOS recorded for this session are overlaid back on
   * ({@link overlayApprovalReceipts}), and so are the tool calls it refused
   * before anyone could be asked ({@link overlayPermissionDenials}). This is the
   * seam BOTH history consumers
   * pass through — `GET /:id/messages` and `getSessionSnapshot`'s loader — so
   * reopening a conversation shows the same receipts a live one does. The
   * transcript reader stays a JSONL parser and learns nothing about DorkOS
   * interactions.
   */
  async getMessageHistory(projectDir: string, sessionId: string): Promise<HistoryMessage[]> {
    return originalClaudeSessionQueryOperations.getMessageHistory(
      this.#sessionQueryKey,
      projectDir,
      sessionId
    );
  }

  /**
   * @inheritdoc
   *
   * Completed `messages` come from the JSONL transcript via `getMessageHistory`
   * (injected as the projector's `loadHistory` loader — "own the boundary, not
   * the bytes", ADR-0263); the live in-progress turn, status, pending
   * interactions, and `cursor` come from the per-session projector's in-memory
   * projection.
   *
   * Both halves resolve through the id alias (acceptance run 20260610-173202,
   * F1/F2): the transcript on disk is named by the CANONICAL id, so a
   * client-facing request UUID must be translated for the history loader (the
   * same translation `GET /:id/messages` does) — without it the snapshot
   * hydrates with empty history mid-first-turn. The projector lookup goes
   * through {@link resolveLiveProjector} so whichever id currently owns the
   * registry entry serves the live turn.
   */
  async getSessionSnapshot(ctx: SessionOpts, sessionId: string): Promise<SessionSnapshot> {
    return originalClaudeSessionQueryOperations.getSessionSnapshot(
      this.#sessionQueryKey,
      ctx,
      sessionId
    );
  }

  /**
   * @inheritdoc
   *
   * Delegates to the per-session projector's resumable stream: if `sinceCursor`
   * is supplied it replays buffered events with a greater seq before going
   * live. The projector is fed normalized {@link SessionEvent}s by the
   * `session-event-normalizer` — for DorkOS-triggered turns via `feedProjector`
   * (wired in task #6, the message-POST decouple) and, in a later task, for
   * externally-appended JSONL via the file-watch path. This method itself is
   * source-agnostic: it only reads the projector.
   */
  subscribeSession(
    ctx: SessionOpts,
    sessionId: string,
    sinceCursor?: number,
    signal?: AbortSignal
  ): AsyncIterable<SessionEvent> {
    return originalClaudeSessionQueryOperations.subscribeSession(
      this.#sessionQueryKey,
      ctx,
      sessionId,
      sinceCursor,
      signal
    );
  }

  /**
   * @inheritdoc
   *
   * Answered off {@link resolveLiveProjector} — the SAME resolution
   * {@link subscribeSession} binds through, and the reason this is a runtime
   * method at all. This adapter reaches a session's projector through the SDK id
   * alias as well as the registry, so a generation read off the bare session id
   * would report "unowned" for a session an alias-resolved projector is actively
   * streaming, and the mismatch check downstream would then wave every stale
   * cursor through (DOR-1704).
   *
   * Peek-only, unlike {@link streamProjector}: the caller asks this BEFORE it
   * commits to a resume, and a question must not mint the counter it is asking
   * about. A session with no projector reads as unowned, and the fresh projector
   * the subsequent subscribe mints refuses every cursor above 0 on its own.
   */
  streamGeneration(_ctx: SessionOpts, sessionId: string): string {
    return originalClaudeSessionQueryOperations.streamGeneration(
      this.#sessionQueryKey,
      _ctx,
      sessionId
    );
  }

  /**
   * The projector this adapter's durable stream binds a session to.
   *
   * Alias-aware like getSessionSnapshot: a subscription opened under the
   * pre-remap request UUID after the rekey (or under the canonical id before
   * it) must park on the LIVE projector, not mint a fresh empty one.
   *
   * @param ctx - Session context; supplies the cwd a freshly minted projector takes.
   * @param sessionId - Target session ID, canonical or retired.
   */
  private streamProjector(ctx: SessionOpts, sessionId: string): SessionStateProjector {
    return originalClaudeSessionQueryOperations.streamProjector(
      this.#sessionQueryKey,
      ctx,
      sessionId
    );
  }

  /**
   * @inheritdoc
   *
   * Wraps {@link watchSessionList}: emits one `session_upserted` per session
   * already on disk — fleet-wide, across every project slug directory under every
   * Claude ACCOUNT's `projects/` — then upserts/removals as transcripts change in
   * any of them, including sessions created or appended by the Claude Code CLI
   * outside DorkOS (ADR-0263). Each session carries its true `cwd` from the
   * JSONL head, so multi-project clients route events to the right list
   * (SRV-I4), and the account it belongs to. `ctx` is unused: the contract is
   * "ALL sessions the adapter can observe", not a per-cwd scope. Debounced, and
   * emitted only on a real transition — a reconcile sweep re-reads the projects
   * directories on a timer, but it is a source of rescans, not of events, and
   * exists because chokidar drops what happens while it is attaching (DOR-577).
   */
  subscribeSessionList(_ctx: SessionOpts): AsyncIterable<SessionListEvent> {
    return originalClaudeSessionQueryOperations.subscribeSessionList(this.#sessionQueryKey, _ctx);
  }

  /** @inheritdoc */
  async getSessionTasks(projectDir: string, sessionId: string): Promise<TaskItem[]> {
    return originalClaudeSessionQueryOperations.getSessionTasks(
      this.#sessionQueryKey,
      projectDir,
      sessionId
    );
  }

  /** @inheritdoc */
  async getSessionETag(projectDir: string, sessionId: string): Promise<string | null> {
    return originalClaudeSessionQueryOperations.getSessionETag(
      this.#sessionQueryKey,
      projectDir,
      sessionId
    );
  }

  /** @inheritdoc */
  getSessionCwd(sessionId: string): string | undefined {
    return originalClaudeSessionQueryOperations.getSessionCwd(this.#sessionQueryKey, sessionId);
  }

  /**
   * @inheritdoc
   *
   * The account this session's turns run and bill on, as the absolute Claude
   * config directory (`~/.claude`, `~/.claude2`, …) — the directory that IS a
   * Claude Code account, because it carries that account's own sign-in
   * (`claude-config-dir.ts`).
   *
   * The last LAUNCH's account first, then the transcript's. They agree whenever
   * both exist — a launch resolves `session.accountRoot ?? ladder` — and the
   * launch is the more precise answer on the one turn where they differ: a
   * brand-new session has no transcript yet, so disk knows nothing while the
   * ladder has already decided which credential the turn is using. Asking the
   * transcript alone would leave the first turn of every new session
   * unattributed, which is exactly the turn a dead credential fails on.
   *
   * `undefined` means no launch in this process and no transcript on disk. Never
   * a guess: resolving the ladder here instead would answer with the account a
   * launch WOULD pick, which is wrong for any session started from a per-send
   * hint or an agent manifest, and wrong in both directions at once.
   *
   * **`path.resolve` is load-bearing, not tidiness.** The contract is that two
   * sessions on one account answer the same string, and the roots reaching this
   * method are spelled by whoever typed them: `resolveLaunchAccountRoot` returns
   * a registry row's `path` verbatim (`claude-config-dir.ts`), the
   * `defaultAccount` rung returns that field verbatim, and the config schema
   * constrains neither to be absolute or slash-free. So one session launched
   * from a hint naming `/x/.claude2/` and another from the default naming
   * `/x/.claude2` are the SAME account with two spellings — and the watch
   * compares with `===`. Left raw, a sign-in fixed on one spelling could never
   * resolve an episode raised under the other, and the notice would stand for
   * the life of the install. Every sibling comparison in this subsystem
   * normalizes the same way (`samePath` in `launch-fingerprint.ts`,
   * `claudeConfigDirEnv` in `claude-config-dir.ts`); this is not the place to be
   * the exception.
   */
  getSessionAccount(sessionId: string): string | undefined {
    return originalClaudeSessionQueryOperations.getSessionAccount(this.#sessionQueryKey, sessionId);
  }

  /** @inheritdoc */
  async getLastMessageIds(sessionId: string): Promise<{ user: string; assistant: string } | null> {
    return originalClaudeSessionQueryOperations.getLastMessageIds(this.#sessionQueryKey, sessionId);
  }

  /** @inheritdoc */
  async readFromOffset(
    projectDir: string,
    sessionId: string,
    offset: number
  ): Promise<{ content: string; newOffset: number }> {
    return originalClaudeSessionQueryOperations.readFromOffset(
      this.#sessionQueryKey,
      projectDir,
      sessionId,
      offset
    );
  }

  // ---------------------------------------------------------------------------
  // Session locking (delegated to SessionLockManager)
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  acquireLock(sessionId: string, clientId: string, res: SseResponse, token?: symbol): boolean {
    return this.lockManager.acquireLock(sessionId, clientId, res, token);
  }

  /** @inheritdoc */
  acquireRuntimeLock(sessionKey: string, res: SseResponse, token?: symbol): boolean {
    return this.lockManager.acquireRuntimeLock(sessionKey, res, token);
  }

  /** @inheritdoc */
  releaseLock(sessionId: string, clientId: string, token?: symbol): void {
    this.lockManager.releaseLock(sessionId, clientId, token);
  }

  /** @inheritdoc */
  isLocked(sessionId: string, clientId?: string): boolean {
    return this.lockManager.isLocked(sessionId, clientId);
  }

  /** @inheritdoc */
  getLockInfo(sessionId: string): { clientId: string; acquiredAt: number } | null {
    return this.lockManager.getLockInfo(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Models & subagents (delegated to RuntimeCache)
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  async getSupportedModels(): Promise<ModelOption[]> {
    return originalClaudeCommandOperations.getSupportedModels(this.#commandCacheKey);
  }

  /** @inheritdoc */
  async getSupportedSubagents(): Promise<SubagentInfo[]> {
    return originalClaudeCommandOperations.getSupportedSubagents(this.#commandCacheKey);
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  async getCommands(forceRefresh?: boolean, cwd?: string): Promise<CommandRegistry> {
    return originalClaudeCommandOperations.getCommands(this.#commandCacheKey, forceRefresh, cwd);
  }

  /**
   * Warm a cwd's SDK command cache without running a turn. Boots an idle
   * streaming-input probe ({@link createIdlePrompt}), reads the authoritative
   * command list the SDK reports at initialize (built-ins plus activated plugin
   * commands), writes it into the per-cwd cache, and broadcasts
   * `commands_changed` so a connected palette re-fetches. No user message is
   * sent, so no turn runs and no tokens are spent.
   *
   * Best-effort: no-ops when the cache is already warm, a probe is in flight,
   * or no plugins (global or project-scoped) apply to this cwd; times out
   * defensively; swallows failures (the post-first-message path still
   * populates the cache); and always closes the subprocess.
   *
   * @param cwd - Project directory whose command cache to warm.
   */
  private async warmCommands(cwd: string): Promise<void> {
    return originalClaudeCommandOperations.warmCommands(this.#commandCacheKey, cwd);
  }

  /**
   * Record a warm-probe failure for `cwd` and prune stale entries.
   *
   * Entries older than {@link WARM_FAILURE_COOLDOWN_MS} are past their cooldown,
   * so they no longer suppress a re-probe and only leak memory — prune them on
   * write so {@link warmFailedAt} stays bounded by the number of cwds that
   * failed within the last cooldown window, not every cwd that ever failed.
   *
   * @param cwd - Project directory whose warm probe just failed.
   */
  private recordWarmFailure(cwd: string): void {
    return originalClaudeCommandOperations.recordWarmFailure(this.#commandCacheKey, cwd);
  }

  /** Get or create a CommandRegistryService for the given root, with LRU eviction. */
  private getOrCreateRegistry(root: string): CommandRegistryService {
    return originalClaudeCommandOperations.getOrCreateRegistry(this.#commandCacheKey, root);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  checkSessionHealth(): void {
    checkSessionHealth(this.#nativePreparationKey);
  }

  /** @inheritdoc */
  getInternalSessionId(sessionId: string): string | undefined {
    return this.sessionStore.getInternalSessionId(sessionId);
  }

  /**
   * Backward-compatible alias for `getInternalSessionId`.
   *
   * @deprecated Use `getInternalSessionId()` instead.
   */
  getSdkSessionId(sessionId: string): string | undefined {
    return this.sessionStore.getSdkSessionId(sessionId);
  }

  // ---------------------------------------------------------------------------
  // MCP status (delegated to RuntimeCache)
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  getMcpStatus(cwd: string): McpServerEntry[] | null {
    return this.cache.getMcpStatus(cwd);
  }

  /** @inheritdoc */
  getMcpServerConfig(cwd: string, serverName: string): McpAppServerConnection | null {
    return this.cache.getMcpServerConfig(cwd, serverName);
  }

  /**
   * Always `true` (spec `tool-only-room-replies` §D2).
   *
   * The `dorkos` server runs INSIDE a claude-code session rather than over a
   * wire, so there is no configuration to be wrong: all four room verbs sit in
   * `ALWAYS_LOADED_TOOLS` (`mcp-tools/tool-exposure.ts`) and reach the registry
   * in-process. Nothing an operator can switch off takes them away.
   *
   * @returns `true`.
   */
  async carriesRoomTools(): Promise<boolean> {
    return true;
  }

  /**
   * Forward the servers this turn's status snapshot reports as not having come up
   * (DOR-981) — a trigger to LOOK, never a verdict.
   *
   * Which statuses those are belongs to the mesh ({@link mcpAuthEvidenceFrom}),
   * along with the reasons the report cannot be trusted on its own. This runtime
   * reports what it saw and forgets. Silent when everything connected, so the
   * port is only woken by news.
   */
  private reportMcpAuthFailures(sessionId: string, cwd: string, servers: McpServerEntry[]): void {
    return reportMcpAuthFailures(this.#nativePreparationKey, sessionId, cwd, servers);
  }

  /**
   * @inheritdoc
   *
   * **Never held, whatever it costs** (spec `plugin-reload-cache-cost`). This is
   * the reload somebody asked for — `POST /api/sessions/:id/reload-plugins`, a
   * person who wants the new plugin in this session now — and a request answered
   * with "in a few minutes" is not an answer. The cost check exists to keep
   * reloads NOBODY asked for from spending quietly; it has no business
   * overruling one somebody did.
   *
   * It also ends any wait already running on this session: the plugins are live
   * either way, so the held reload has been paid, and the activity feed records
   * it as such.
   */
  reloadPlugins(sessionId: string): Promise<ReloadPluginsResult | null> {
    return reloadPlugins(this.#nativePreparationKey, sessionId);
  }

  // ---------------------------------------------------------------------------
  // Tool server
  // ---------------------------------------------------------------------------

  /** Return the MCP tool server config (stub session — used for introspection only). */
  getToolServerConfig(): Record<string, unknown> {
    if (!this.mcpServerFactory) return {};
    const stubSession = createClaudeIntrospectionSession();
    // Empty session id: introspection only, so the DevTools read tools register
    // as their session-less variants (no live preview buffer to bind to).
    return this.mcpServerFactory(stubSession, '');
  }
}
