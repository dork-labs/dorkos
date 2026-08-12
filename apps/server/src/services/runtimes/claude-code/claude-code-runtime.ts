/**
 * Claude Code Runtime — implements the AgentRuntime interface for the Claude Agent SDK.
 *
 * Thin facade that coordinates SessionStore, RuntimeCache, TranscriptReader,
 * SessionLockManager, and CommandRegistryService.
 *
 * @module services/runtimes/claude-code/claude-code-runtime
 */
import { renameSession as sdkRenameSession, query } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerEntry } from '@dorkos/shared/transport';
import type {
  StreamEvent,
  PermissionMode,
  EffortLevel,
  ModelOption,
  SubagentInfo,
  Session,
  HistoryMessage,
  TaskItem,
  CommandRegistry,
  ReloadPluginsResult,
  SessionListWarning,
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
  ToolDecisionOptions,
  SessionWarmth,
} from '@dorkos/shared/agent-runtime';
import type {
  SessionSnapshot,
  SessionEvent,
  SessionListEvent,
} from '@dorkos/shared/session-stream';
import type { RuntimeCommandIntentId } from '@dorkos/shared/command-intents';
import { CLAUDE_CODE_CAPABILITIES } from './runtime-constants.js';
import { SessionStore } from './sessions/session-store.js';
import { RuntimeCache } from './messaging/runtime-cache.js';
import { SessionLockManager } from '../../session/session-lock.js';
import type { AgentSession } from './agent-types.js';
import { resolveClaudeCliPath, createIdlePrompt } from './sdk/sdk-utils.js';
import { claudeConfigDirEnv, resolveActiveClaudeRoot } from './claude-config-dir.js';
import { withClaudeConfigDir } from './claude-config-env-lock.js';
import { logger } from '../../../lib/logger.js';
import { DEFAULT_CWD } from '../../../lib/resolve-root.js';
import { TranscriptReader } from './sessions/transcript-reader.js';
import { SessionPumpRegistry } from './sessions/session-pump-registry.js';
import { CommandRegistryService } from './tooling/command-registry.js';
import { executeSdkQuery } from './messaging/message-sender.js';
import type { MessageSenderOpts } from './messaging/message-sender-shared.js';
import { PersistentDispatch } from './sessions/persistent-dispatch.js';
import { watchSessionList } from './sessions/session-list-watcher.js';
import { eventFanOut } from '../../core/event-fan-out.js';
import {
  disposeProjector,
  getOrCreateProjector,
  overlayApprovalReceipts,
  peekProjector,
} from '../../session/index.js';
import { mcpAuthEvidenceFrom } from '../../mesh/mcp-revocation.js';
import type { McpAuthEvidencePort } from '../../mesh/mcp-revocation.js';
import { editBaselineStore } from '../../diff/index.js';
import type { SessionStateProjector } from '../../session/index.js';

export { buildTaskEvent } from './sdk/build-task-event.js';

/**
 * Claude Code runtime implementing the universal AgentRuntime interface.
 *
 * Manages Claude Agent SDK sessions — creation, resumption, streaming, tool approval,
 * and session locking. Delegates to focused collaborators for session state (SessionStore),
 * SDK response caching (RuntimeCache), transcript reading, broadcasting, and locking.
 */
export class ClaudeCodeRuntime implements AgentRuntime {
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
   */
  private readonly pumps = new SessionPumpRegistry();
  /**
   * The path a message takes when its session holds its process open. Reads the
   * opt-in per session and wires the pump, the turn windower and the crash
   * policy together; see `sessions/persistent-dispatch.ts`.
   */
  private readonly persistent = new PersistentDispatch(this.pumps);
  private commandRegistries = new Map<string, CommandRegistryService>();
  private static readonly MAX_COMMAND_REGISTRIES = 50;

  // Configuration
  private readonly cwd: string;
  private readonly claudeCliPath: string | undefined;

  // Injected dependencies
  private mcpServerFactory:
    | ((session: AgentSession, sessionId: string) => Record<string, McpServerConfig>)
    | null = null;
  private meshCore: AgentRegistryPort | null = null;
  private sessionConnectors:
    | import('../../connectors/session-exposure.js').SessionConnectorService
    | null = null;
  private mcpAuthEvidence: McpAuthEvidencePort | undefined;
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
   * (DOR-174), so global installs keep SDK injection for now.
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

  constructor(dorkHome: string, cwd?: string) {
    this.cwd = cwd ?? DEFAULT_CWD;
    this.claudeCliPath = resolveClaudeCliPath();
    this.cache = new RuntimeCache(dorkHome);
    this.cache.setDefaultCwd(this.cwd);
    // Warm-up spawns the SDK too; give it the same resolved binary path so it
    // works in the packaged desktop app (see setClaudeCliPath's doc).
    this.cache.setClaudeCliPath(this.claudeCliPath);
    this.transcriptReader = new TranscriptReader();
  }

  /** Warm up the model cache by fetching models from the SDK. */
  async warmup(): Promise<void> {
    return this.cache.warmup(this.cwd);
  }

  // ---------------------------------------------------------------------------
  // Capabilities
  // ---------------------------------------------------------------------------

  /** Return static Claude Code capability flags. */
  getCapabilities(): RuntimeCapabilities {
    return CLAUDE_CODE_CAPABILITIES;
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

  /**
   * Inject the per-account → session tool-server binder so a session's first
   * turn after process start can hydrate its connector attachments from
   * persisted state (connection-scoping spec `specs/connection-scoping/`
   * §Part 1 Restart semantics) before the MCP factory reads its cache.
   */
  setSessionConnectors(
    sessionConnectors: import('../../connectors/session-exposure.js').SessionConnectorService
  ): void {
    this.sessionConnectors = sessionConnectors;
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
   * Inject the core session-settings store (ADR-0260). Forwards it to the
   * session store along with this runtime's declared default permission mode,
   * so evicted/restarted sessions hydrate the operator's chosen settings.
   */
  setSessionSettings(port: SessionSettingsPort): void {
    this.sessionStore.configureSettings(
      port,
      (CLAUDE_CODE_CAPABILITIES.permissionModes.default ?? 'default') as PermissionMode
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
  setMcpServerFactory(
    factory: (session: AgentSession, sessionId: string) => Record<string, McpServerConfig>
  ): void {
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

  /** @inheritdoc */
  async updateSession(
    sessionId: string,
    opts: {
      permissionMode?: PermissionMode;
      model?: string;
      effort?: EffortLevel;
      fastMode?: boolean;
    }
  ): Promise<boolean> {
    return this.sessionStore.updateSession(sessionId, opts);
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  async *sendMessage(
    sessionId: string,
    content: string,
    opts?: MessageOpts
  ): AsyncGenerator<StreamEvent> {
    const session = await this.sessionStore.ensureForMessage(
      sessionId,
      this.transcriptReader,
      this.cwd,
      opts
    );

    // The `get_ui_state` MCP tool reads `session.uiState`. UI state now arrives
    // as a `ui_state` entry inside the neutral additional-context bag (ADR-0273);
    // lift it onto the session so the tool keeps answering with the latest snapshot.
    const uiStateEntry = opts?.additionalContext?.find((e) => e.kind === 'ui_state');
    if (uiStateEntry?.kind === 'ui_state') session.uiState = uiStateEntry.data;

    const cwdKey = opts?.cwd || session.cwd || this.cwd;

    // Bring this session's connector tool exposure up to date with persisted
    // agent/session attachments before the MCP factory reads its cache
    // (connection-scoping spec §Part 1 Restart semantics). Hydration is
    // idempotent and a no-op after the first call in this process, so it is
    // safe to await unconditionally on every turn. Silently skipped when
    // there is no agent owning this cwd (e.g. an unregistered scratch
    // directory) — there is no standing consent to inherit.
    //
    // `hydrateSession`'s own per-account resolution already catches a
    // rejected provider call (a real risk — it is third-party HTTP) so it
    // does not throw in the ordinary case. This try/catch is the second,
    // defense-in-depth layer for the turn path specifically: a turn must
    // NEVER fail because a connector could not be resolved — connector tools
    // are additive to a turn, never load-bearing for it — so even an
    // unexpected throw out of hydration (a future implementation swap, a bug)
    // is logged and skipped here rather than aborting the message the user
    // actually asked for.
    const agentId = this.meshCore?.getByPath(cwdKey)?.id;
    if (this.sessionConnectors && agentId) {
      try {
        await this.sessionConnectors.hydrateSession(sessionId, agentId);
      } catch (err) {
        logger.warn(`[hydrateSession] failed for session '${sessionId}'; continuing without it`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Resolve the selected model's capabilities once: thinking config + whether it
    // supports auto permission mode (undefined when the model isn't cached yet).
    const modelCapability = this.cache.resolveModelCapability(session.model);
    const cacheCallbacks = this.cache.buildSendCallbacks(cwdKey);

    const senderOpts: MessageSenderOpts = {
      cwd: this.cwd,
      sessionCwd: session.cwd,
      claudeCliPath: this.claudeCliPath,
      meshCore: this.meshCore,
      bindingRouter: this.bindingRouter,
      bindingStore: this.bindingStore,
      adapterManager: this.adapterManager,
      mcpServerFactory: this.mcpServerFactory,
      ...cacheCallbacks,
      // Composed over the cache's own handler rather than replacing it: the
      // per-turn status snapshot is one observation with two readers — the
      // cache, which answers "what is connected?", and the revocation watch,
      // which acts on the single status that means "the token you sent me was
      // refused" (DOR-981). The session id is read when the snapshot ARRIVES,
      // not now, so a session that was assigned its canonical id mid-turn
      // reports the id its projector is keyed by.
      onMcpStatusReceived: (servers) => {
        cacheCallbacks.onMcpStatusReceived?.(servers);
        this.reportMcpAuthFailures(session.sdkSessionId || sessionId, cwdKey, servers);
      },
      // `sessionId` is the id THIS turn was asked with, which is only a hint:
      // after the session's first rename it is an alias, not the key the
      // store holds it under. The store resolves the real key itself.
      onSdkSessionRebind: (previousSdkSessionId, nextSdkSessionId) =>
        this.sessionStore.rebindSdkSession(previousSdkSessionId, nextSdkSessionId, sessionId),
      modelThinkingCapability: modelCapability,
      modelSupportsAutoMode: modelCapability
        ? (modelCapability.supportsAutoMode ?? false)
        : undefined,
      plugins: this.activatedPlugins,
      getKnownCommands: async () => {
        // Cold SDK cache → null: built-ins are unknowable before the first
        // query for this cwd, so the sender passes command-shaped content
        // through unverified (DOR-107).
        if (!this.cache.hasSdkCommands(cwdKey)) return null;
        const { commands } = await this.cache.getCommands(this.getOrCreateRegistry(cwdKey), cwdKey);
        return commands.map((c) => c.fullCommand);
      },
    };

    // The one branch. A session that already holds a process stays on this path
    // whatever the setting says now, and a session that holds none reads the
    // opt-in here — the asymmetry is `persistent-dispatch.ts`'s module doc, and
    // P5's comparison runs depend on knowing it. With the flag off and no
    // process held, the `executeSdkQuery` call below is reached with exactly the
    // arguments it has always been reached with.
    if (this.persistent.shouldDispatch(sessionId)) {
      yield* this.persistent.dispatch({
        sessionId,
        content,
        session,
        opts: senderOpts,
        ...(opts !== undefined ? { messageOpts: opts } : {}),
      });
      return;
    }

    yield* executeSdkQuery(sessionId, content, session, senderOpts, opts);
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
   * Best-effort throughout — filesystem scan or reload failures leave the
   * previous value in place so a single misbehaving plugin never blocks
   * sessions.
   */
  async refreshActivatedPlugins(changedProjectPath?: string): Promise<void> {
    try {
      const { resolveDorkHome } = await import('../../../lib/dork-home.js');
      const { listEnabledPluginNames } = await import('../../marketplace/installed-scanner.js');
      const { buildClaudeAgentSdkPluginsArray } = await import('./messaging/plugin-activation.js');
      const { logger } = await import('../../../lib/logger.js');
      const dorkHome = resolveDorkHome();
      const enabledNames = await listEnabledPluginNames(dorkHome);
      if (enabledNames.length === 0) {
        this.activatedPlugins = [];
      } else {
        this.activatedPlugins = await buildClaudeAgentSdkPluginsArray({
          dorkHome,
          enabledPluginNames: enabledNames,
          logger,
        });
      }
    } catch {
      // Best-effort; leave the previous value in place.
    }

    // Hot-reload every live session so its cached command list reflects the
    // new plugin set instantly, then tell clients to re-fetch. Isolated from
    // the plugin-array swap above so a reload failure never reverts it.
    await this.reloadCommandsForLiveSessions();

    // A PROJECT-scoped install/uninstall changes which commands that project's
    // sessions report, but only sessions launched after the change see the new
    // plugin set — so drop the cwd's cached command list (and any warm-probe
    // cooldown) and let the broadcast below trigger a re-warm with the merged
    // per-cwd plugins. Runs AFTER the live-session reload, which would
    // otherwise repopulate the cache from a session still holding the old set.
    if (changedProjectPath) {
      this.cache.clearSdkCommands(changedProjectPath);
      this.warmFailedAt.delete(changedProjectPath);
    }

    this.broadcastCommandsChanged();
  }

  /**
   * Round-trip `reload_plugins` on every session that still holds a reloadable
   * SDK query, refreshing each session cwd's cached command list in place.
   *
   * Per-session failures are swallowed (logged at debug) so one dead
   * subprocess never blocks the others. Sessions that never ran a query expose
   * no query and are skipped — their commands populate on the next message.
   */
  private async reloadCommandsForLiveSessions(): Promise<void> {
    const reloadable = this.sessionStore.getReloadableSessions();
    if (reloadable.length === 0) return;
    await Promise.all(
      reloadable.map(async ({ sessionId, session }) => {
        const queryObj = session.activeQuery ?? session.lastQuery;
        if (!queryObj) return;
        try {
          const result = await this.cache.reloadPlugins(queryObj, session.cwd, this.cwd);
          logger.debug('[refreshActivatedPlugins] hot-reloaded session commands', {
            sessionId,
            commands: result.commandCount,
            plugins: result.pluginCount,
          });
        } catch (err) {
          logger.debug('[refreshActivatedPlugins] session hot-reload failed', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })
    );
  }

  /**
   * Broadcast a `commands_changed` event on the unified `/api/events` stream so
   * connected clients invalidate their command-registry query and re-fetch.
   * Best-effort: a broadcast failure must never break the install path.
   */
  private broadcastCommandsChanged(): void {
    try {
      eventFanOut.broadcast('commands_changed', { changedAt: new Date().toISOString() });
    } catch (err) {
      // warn, not debug: a failed broadcast means OTHER connected windows never
      // learn to re-fetch, so their command palette stays stale until a manual
      // reload (the initiating window still has its mutation-side invalidation).
      logger.warn('[refreshActivatedPlugins] commands_changed broadcast failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** @inheritdoc */
  async renameSession(sessionId: string, title: string, projectDir: string): Promise<void> {
    // `renameSession` runs IN-PROCESS and its options expose no config dir, so
    // the env lock is the only way to point it at the session's OWN account —
    // without it a rename writes into whichever account is active, where the
    // session does not exist, and the new title silently goes nowhere (spec D8).
    const accountRoot = await this.sessionStore.accountRootFor(
      sessionId,
      this.transcriptReader,
      projectDir
    );
    await withClaudeConfigDir(accountRoot, () =>
      sdkRenameSession(sessionId, title, { dir: projectDir })
    );
    // The SDK persists the title; drop the reader's cache so the next read
    // re-extracts it via getSessionInfo (no in-memory title overlay).
    this.transcriptReader.invalidate(sessionId);
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
    const resolved = this.sessionStore.approveTool(sessionId, toolCallId, approved, options);
    if (resolved) {
      // `reasonGiven` is asserted HERE, one line from the call that actually
      // handed the reason to the model, so the transcript's "agent was told
      // why" can never outrun what was delivered.
      this.notifyInteractionResolved(sessionId, toolCallId, approved ? 'approved' : 'denied', {
        reasonGiven: !approved && (options?.denyReason?.trim() ?? '') !== '',
      });
    }
    return resolved;
  }

  /** @inheritdoc */
  submitAnswers(sessionId: string, toolCallId: string, answers: Record<string, string>): boolean {
    const resolved = this.sessionStore.submitAnswers(sessionId, toolCallId, answers);
    if (resolved) this.notifyInteractionResolved(sessionId, toolCallId, 'answered');
    return resolved;
  }

  /** @inheritdoc */
  submitElicitation(
    sessionId: string,
    interactionId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>
  ): boolean {
    const resolved = this.sessionStore.submitElicitation(sessionId, interactionId, action, content);
    if (resolved) {
      this.notifyInteractionResolved(
        sessionId,
        interactionId,
        action === 'accept' ? 'answered' : 'denied'
      );
    }
    return resolved;
  }

  /**
   * Emit `interaction_resolved` through the projector so every live `/events`
   * subscriber (this window, other windows, a later replay) drops the pending
   * card — without this the resolution was only observable via the next
   * snapshot, leaving ghost Approve/Deny cards and a `blocked` projection.
   * Peeks under the client-facing id first, then the canonical alias (a
   * pre-rekey projector may still be keyed by the request UUID's canonical id).
   */
  private notifyInteractionResolved(
    sessionId: string,
    interactionId: string,
    resolution: 'approved' | 'denied' | 'answered',
    opts?: { reasonGiven?: boolean }
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
  async stopTask(sessionId: string, taskId: string): Promise<boolean> {
    return this.sessionStore.stopTask(sessionId, taskId);
  }

  /** @inheritdoc */
  async interruptQuery(sessionId: string): Promise<boolean> {
    if (await this.sessionStore.interruptQuery(sessionId)) return true;
    // Nothing on the ordinary path — but a persistent session's FIRST turn may
    // still be booting, so the pump holds a live query the `running` edge has
    // not yet armed `session.activeQuery` with (DOR-1191). Reach that turn
    // through the same interrupt→close escalation the running path uses.
    const bootingQuery = this.persistent.bootingQuery(sessionId);
    if (bootingQuery === undefined) return false;
    return this.sessionStore.interruptGivenQuery(sessionId, bootingQuery);
  }

  /** @inheritdoc */
  getSessionWarmth(sessionId: string): SessionWarmth {
    return this.pumps.warmth(sessionId);
  }

  /** @inheritdoc */
  async reapSession(sessionId: string): Promise<void> {
    // A reaped pump is SPENT — the registry drops it, and `SessionPump` refuses
    // everything asked of it afterwards. Forgetting the wiring in the same beat
    // is what makes the next message build a fresh one instead of dispatching
    // into a pump that can only throw.
    if (await this.pumps.reap(sessionId)) this.persistent.forget(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Session queries (delegated to TranscriptReader)
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  async listSessions(projectDir: string): Promise<Session[]> {
    return this.transcriptReader.listSessions(projectDir);
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
    return this.transcriptReader.listSessionsAcrossAccounts(projectDir);
  }

  /** @inheritdoc */
  async getSession(projectDir: string, sessionId: string): Promise<Session | null> {
    return this.transcriptReader.getSession(projectDir, sessionId);
  }

  /**
   * @inheritdoc
   *
   * The transcript is SDK JSONL, which records that a tool ran or did not and
   * nothing about a person having been asked first — so the permission
   * decisions DorkOS recorded for this session are overlaid back on
   * ({@link overlayApprovalReceipts}). This is the seam BOTH history consumers
   * pass through — `GET /:id/messages` and `getSessionSnapshot`'s loader — so
   * reopening a conversation shows the same receipts a live one does. The
   * transcript reader stays a JSONL parser and learns nothing about DorkOS
   * interactions.
   */
  async getMessageHistory(projectDir: string, sessionId: string): Promise<HistoryMessage[]> {
    const messages = await this.transcriptReader.readTranscript(projectDir, sessionId);
    return overlayApprovalReceipts(sessionId, messages);
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
    const projectDir = ctx.cwd ?? this.cwd;
    const historyId = this.getInternalSessionId(sessionId) ?? sessionId;
    const projector =
      this.resolveLiveProjector(sessionId) ?? getOrCreateProjector(sessionId, projectDir);
    return projector.buildSnapshot(() => this.getMessageHistory(projectDir, historyId));
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
    // Alias-aware like getSessionSnapshot: a subscription opened under the
    // pre-remap request UUID after the rekey (or under the canonical id before
    // it) must park on the LIVE projector, not mint a fresh empty one.
    const projector =
      this.resolveLiveProjector(sessionId) ?? getOrCreateProjector(sessionId, ctx.cwd ?? this.cwd);
    return projector.subscribe(sinceCursor, signal);
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
   * "ALL sessions the adapter can observe", not a per-cwd scope. Debounced; no
   * timer poll.
   */
  subscribeSessionList(_ctx: SessionOpts): AsyncIterable<SessionListEvent> {
    return watchSessionList(this.transcriptReader);
  }

  /** @inheritdoc */
  async getSessionTasks(projectDir: string, sessionId: string): Promise<TaskItem[]> {
    return this.transcriptReader.readTasks(projectDir, sessionId);
  }

  /** @inheritdoc */
  async getSessionETag(projectDir: string, sessionId: string): Promise<string | null> {
    return this.transcriptReader.getTranscriptETag(projectDir, sessionId);
  }

  /** @inheritdoc */
  async getLastMessageIds(sessionId: string): Promise<{ user: string; assistant: string } | null> {
    try {
      const session = this.sessionStore.findSession(sessionId);
      const projectDir = session?.cwd ?? this.cwd;
      const messages = await this.transcriptReader.readTranscript(projectDir, sessionId);
      if (!messages.length) return null;

      let lastUser: string | null = null;
      let lastAssistant: string | null = null;

      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (!lastAssistant && m.role === 'assistant') lastAssistant = m.id;
        if (!lastUser && m.role === 'user') lastUser = m.id;
        if (lastUser && lastAssistant) break;
      }

      if (!lastUser || !lastAssistant) return null;
      return { user: lastUser, assistant: lastAssistant };
    } catch (err) {
      logger.warn('[getLastMessageIds] failed to read transcript', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** @inheritdoc */
  async readFromOffset(
    projectDir: string,
    sessionId: string,
    offset: number
  ): Promise<{ content: string; newOffset: number }> {
    return this.transcriptReader.readFromOffset(projectDir, sessionId, offset);
  }

  // ---------------------------------------------------------------------------
  // Session locking (delegated to SessionLockManager)
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  acquireLock(sessionId: string, clientId: string, res: SseResponse, token?: symbol): boolean {
    return this.lockManager.acquireLock(sessionId, clientId, res, token);
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
    return this.cache.getSupportedModels();
  }

  /** @inheritdoc */
  async getSupportedSubagents(): Promise<SubagentInfo[]> {
    return this.cache.getSupportedSubagents();
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  async getCommands(forceRefresh?: boolean, cwd?: string): Promise<CommandRegistry> {
    const root = cwd || this.cwd;
    const registry = this.getOrCreateRegistry(root);
    // Plugin commands (e.g. `/flow:*`) live in the SDK, not on the filesystem,
    // so the cold-cache fallback (`command-registry` scans `.claude/commands/`
    // only) can't surface them. When this cwd has no SDK command list yet, warm
    // it in the background so the palette shows those commands before the
    // session's first message. Whether any plugins actually apply (global OR
    // project-scoped under `<cwd>/.dork/plugins/`) is decided inside
    // `warmCommands` — it exits before booting a probe when none do.
    // Fire-and-forget: the probe broadcasts `commands_changed` on completion,
    // which re-fetches the palette.
    if (!this.cache.hasSdkCommands(root)) {
      void this.warmCommands(root);
    }
    return this.cache.getCommands(registry, root, forceRefresh);
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
    if (this.cache.hasSdkCommands(cwd) || this.warmingCwds.has(cwd)) return;
    const failedAt = this.warmFailedAt.get(cwd);
    if (
      failedAt !== undefined &&
      Date.now() - failedAt < ClaudeCodeRuntime.WARM_FAILURE_COOLDOWN_MS
    ) {
      return;
    }
    this.warmingCwds.add(cwd);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Both hoisted so the `finally` can close whatever was actually created:
    // the plugins check below can exit before either exists, and `query()` can
    // throw with `probe` still undefined. Closing stdin via `idle.close()`
    // alone does NOT tear down the CLI child — `Query.close()` does (see
    // RuntimeCache.warmup, which closes the query even though its input
    // generator completes immediately).
    let idle: ReturnType<typeof createIdlePrompt> | undefined;
    let probe: ReturnType<typeof query> | undefined;
    try {
      // Only GLOBAL plugins are SDK-injected now; a project-scoped plugin's
      // commands reach this cwd as `.claude/commands/<pkg>/` wrappers the FS
      // registry already covers, so no probe is needed for them. When no global
      // plugin applies, skip the probe entirely; built-ins arrive with the
      // first real message.
      const plugins = this.activatedPlugins;
      if (plugins.length === 0) return;
      idle = createIdlePrompt();
      probe = query({
        prompt: idle.prompt,
        options: {
          cwd,
          plugins,
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          settingSources: ['local', 'project', 'user'],
          ...(this.claudeCliPath ? { pathToClaudeCodeExecutable: this.claudeCliPath } : {}),
          env: {
            // eslint-disable-next-line no-restricted-syntax -- full env needed for SDK subprocess inheritance
            ...process.env,
            // The probe gets the same explicit account pin a turn does, for two
            // reasons. `settingSources` includes `'user'`, which resolves under
            // the config dir — an inherited root would warm this cwd's palette
            // from ANOTHER account's user settings, and could boot against an
            // account that is not signed in. And an explicit entry keeps the
            // probe out of reach of the process-global mutation the D8 env lock
            // holds during a rename or fork. There is no session here, so the
            // ACTIVE account is the only account this can mean.
            ...claudeConfigDirEnv(resolveActiveClaudeRoot()),
          },
        },
      });
      const commands = await Promise.race([
        probe.supportedCommands(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('warmCommands: supportedCommands timed out')),
            ClaudeCodeRuntime.WARM_TIMEOUT_MS
          );
        }),
      ]);
      // Provisional: the probe omits `mcpServers` (real sessions inject them),
      // so this list can miss MCP-contributed commands. Marking it provisional
      // lets the first real message re-fetch the authoritative, MCP-inclusive
      // set — the palette still populates immediately in the meantime.
      this.cache.replaceSdkCommands(
        cwd,
        commands.map((c) => ({
          name: c.name,
          description: c.description,
          argumentHint: c.argumentHint,
          aliases: c.aliases,
        })),
        { provisional: true }
      );
      this.broadcastCommandsChanged();
      this.warmFailedAt.delete(cwd);
      logger.debug('[warmCommands] warmed command cache', { cwd, count: commands.length });
    } catch (err) {
      // Record the failure so the cooldown guard suppresses a re-probe storm if
      // the SDK is persistently broken (bad auth, missing binary, boot crash).
      this.recordWarmFailure(cwd);
      logger.debug('[warmCommands] probe failed; cache stays cold until first message', {
        cwd,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (timer) clearTimeout(timer);
      // Close the query (kills the CLI child) AND the held prompt (closes
      // stdin). Either can be undefined: the no-applicable-plugins exit creates
      // neither, and a `query()` throw leaves `probe` unset — hence the guards.
      probe?.close();
      idle?.close();
      this.warmingCwds.delete(cwd);
    }
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
    const now = Date.now();
    for (const [key, at] of this.warmFailedAt) {
      if (now - at >= ClaudeCodeRuntime.WARM_FAILURE_COOLDOWN_MS) {
        this.warmFailedAt.delete(key);
      }
    }
    this.warmFailedAt.set(cwd, now);
  }

  /** Get or create a CommandRegistryService for the given root, with LRU eviction. */
  private getOrCreateRegistry(root: string): CommandRegistryService {
    let registry = this.commandRegistries.get(root);
    if (!registry) {
      if (this.commandRegistries.size >= ClaudeCodeRuntime.MAX_COMMAND_REGISTRIES) {
        const oldest = this.commandRegistries.keys().next().value!;
        this.commandRegistries.delete(oldest);
      }
      registry = new CommandRegistryService(root);
      this.commandRegistries.set(root, registry);
    }
    return registry;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  checkSessionHealth(): void {
    // Drop the projector of every evicted session (I1 fix — the registry Map
    // otherwise grows per session id forever). The store returns each evicted
    // session's request UUID AND its canonical sdkSessionId: rekeyProjector
    // moves a brand-new session's projector to the canonical id mid-first-turn,
    // so disposing by the map key alone would miss every rekeyed projector and
    // leak it (plus its EventLog). A session evicted MID-TURN is first marked
    // `interrupted` so any client still on its `/events` stream sees the turn
    // close (lifecycle `interrupted`) rather than a frozen "Thinking…" before
    // the projector is disposed (ADR-0262/0264 restart/eviction degradation).
    // markInterrupted is a no-op for an idle projector.
    const evictedIds = this.sessionStore.checkSessionHealth(this.lockManager);
    for (const sessionId of evictedIds) {
      // No subprocess may outlive the session record it belongs to. Eviction
      // ALWAYS implies a reap; the idle timer's reap never implies an eviction
      // (spec §4.3). Not awaited, because this sweep is synchronous by contract
      // and a close that takes its grace window must not hold it up — and never
      // bare `void`, because a wedged teardown rejecting would take the server
      // down with it. A no-op for a session that never opted in: nothing warms a
      // pump unless `runtimes.claudeCode.persistentSession` is on.
      //
      // The wiring is forgotten alongside the process, so a session that comes
      // back builds a fresh pump rather than dispatching into a spent one. Done
      // FIRST and synchronously: the teardown below is awaited by nobody, and a
      // message arriving in that window must not find a bundle whose pump is
      // already on its way out.
      this.persistent.forget(sessionId);
      this.pumps.evict(sessionId).catch((err: unknown) => {
        logger.warn('[ClaudeCodeRuntime] evicted session failed to give back its process', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      // Drop the session's captured diff baselines (DOR-212) — they are in-memory
      // and per-session, so an evicted session must not leak them. Idempotent for
      // an id that captured none.
      editBaselineStore.clearSession(sessionId);
      const projector = peekProjector(sessionId);
      if (!projector) continue;
      projector.markInterrupted();
      disposeProjector(sessionId);
    }
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
   * Forward the servers this turn's status snapshot reports as not having come up
   * (DOR-981) — a trigger to LOOK, never a verdict.
   *
   * Which statuses those are belongs to the mesh ({@link mcpAuthEvidenceFrom}),
   * along with the reasons the report cannot be trusted on its own. This runtime
   * reports what it saw and forgets. Silent when everything connected, so the
   * port is only woken by news.
   */
  private reportMcpAuthFailures(sessionId: string, cwd: string, servers: McpServerEntry[]): void {
    const port = this.mcpAuthEvidence;
    if (!port) return;
    const serverNames = mcpAuthEvidenceFrom(servers);
    if (serverNames.length === 0) return;
    port({ sessionId, cwd, serverNames });
  }

  /** @inheritdoc */
  async reloadPlugins(sessionId: string): Promise<ReloadPluginsResult | null> {
    const session = this.sessionStore.findSession(sessionId);
    const queryObj = session?.activeQuery ?? session?.lastQuery;
    if (!queryObj) {
      logger.warn('[reloadPlugins] no query available', { sessionId });
      return null;
    }
    try {
      const result = await this.cache.reloadPlugins(queryObj, session!.cwd, this.cwd);
      logger.info('[reloadPlugins] plugins reloaded', {
        sessionId,
        commands: result.commandCount,
        plugins: result.pluginCount,
        errorCount: result.errorCount,
      });
      return result;
    } catch (err) {
      logger.error('[reloadPlugins] reload failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Tool server
  // ---------------------------------------------------------------------------

  /** Return the MCP tool server config (stub session — used for introspection only). */
  getToolServerConfig(): Record<string, unknown> {
    if (!this.mcpServerFactory) return {};
    const stubSession = {
      eventQueue: [],
      uiState: undefined,
      pendingInteractions: new Map(),
      permissionMode: 'default',
      lastActivity: Date.now(),
      hasStarted: false,
    } as unknown as AgentSession;
    // Empty session id: introspection only, so the DevTools read tools register
    // as their session-less variants (no live preview buffer to bind to).
    return this.mcpServerFactory(stubSession, '');
  }
}
