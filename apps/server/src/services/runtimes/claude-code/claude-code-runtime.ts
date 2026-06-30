/**
 * Claude Code Runtime — implements the AgentRuntime interface for the Claude Agent SDK.
 *
 * Thin facade that coordinates SessionStore, RuntimeCache, TranscriptReader,
 * SessionLockManager, and CommandRegistryService.
 *
 * @module services/runtimes/claude-code/claude-code-runtime
 */
import { renameSession as sdkRenameSession } from '@anthropic-ai/claude-agent-sdk';
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
} from '@dorkos/shared/types';
import type {
  AgentRuntime,
  RuntimeCapabilities,
  SessionOpts,
  MessageOpts,
  SseResponse,
  AgentRegistryPort,
  RelayPort,
  SessionSettingsPort,
} from '@dorkos/shared/agent-runtime';
import type {
  SessionSnapshot,
  SessionEvent,
  SessionListEvent,
} from '@dorkos/shared/session-stream';
import { CLAUDE_CODE_CAPABILITIES } from './runtime-constants.js';
import { SessionStore } from './sessions/session-store.js';
import { RuntimeCache } from './messaging/runtime-cache.js';
import { SessionLockManager } from './sessions/session-lock.js';
import type { AgentSession } from './agent-types.js';
import { resolveClaudeCliPath } from './sdk/sdk-utils.js';
import { logger } from '../../../lib/logger.js';
import { DEFAULT_CWD } from '../../../lib/resolve-root.js';
import { TranscriptReader } from './sessions/transcript-reader.js';
import { CommandRegistryService } from './tooling/command-registry.js';
import { executeSdkQuery } from './messaging/message-sender.js';
import { watchSessionList } from './sessions/session-list-watcher.js';
import { eventFanOut } from '../../core/event-fan-out.js';
import { disposeProjector, getOrCreateProjector, peekProjector } from '../../session/index.js';
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
  private commandRegistries = new Map<string, CommandRegistryService>();
  private static readonly MAX_COMMAND_REGISTRIES = 50;

  // Configuration
  private readonly cwd: string;
  private readonly claudeCliPath: string | undefined;

  // Injected dependencies
  private mcpServerFactory: ((session: AgentSession) => Record<string, McpServerConfig>) | null =
    null;
  private meshCore: AgentRegistryPort | null = null;
  private bindingRouter: import('../../relay/binding-router.js').BindingRouter | undefined;
  private bindingStore: import('../../relay/binding-store.js').BindingStore | undefined;
  private adapterManager: import('../../relay/adapter-manager.js').AdapterManager | undefined;

  /**
   * Cached Claude Agent SDK `options.plugins` array for the current set
   * of installed marketplace packages. Empty until `refreshActivatedPlugins()`
   * is called; mutated by that method and consumed by `sendMessage`.
   */
  private activatedPlugins: Array<{ type: 'local'; path: string }> = [];

  constructor(dorkHome: string, cwd?: string) {
    this.cwd = cwd ?? DEFAULT_CWD;
    this.cache = new RuntimeCache(dorkHome);
    this.cache.setDefaultCwd(this.cwd);
    this.claudeCliPath = resolveClaudeCliPath();
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

  /** Check whether the Claude Code CLI binary is available. */
  async checkDependencies(): Promise<import('@dorkos/shared/agent-runtime').DependencyCheck[]> {
    const { checkClaudeDependency } = await import('./tooling/check-dependency.js');
    return [checkClaudeDependency()];
  }

  // ---------------------------------------------------------------------------
  // Dependency injection
  // ---------------------------------------------------------------------------

  /** Set the agent registry for agent manifest resolution and peer agent context. */
  setMeshCore(meshCore: AgentRegistryPort): void {
    this.meshCore = meshCore;
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
  setMcpServerFactory(factory: (session: AgentSession) => Record<string, McpServerConfig>): void {
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

    // Resolve the selected model's capabilities once: thinking config + whether it
    // supports auto permission mode (undefined when the model isn't cached yet).
    const modelCapability = this.cache.resolveModelCapability(session.model);

    yield* executeSdkQuery(
      sessionId,
      content,
      session,
      {
        cwd: this.cwd,
        sessionCwd: session.cwd,
        claudeCliPath: this.claudeCliPath,
        meshCore: this.meshCore,
        bindingRouter: this.bindingRouter,
        bindingStore: this.bindingStore,
        adapterManager: this.adapterManager,
        mcpServerFactory: this.mcpServerFactory,
        ...this.cache.buildSendCallbacks(cwdKey),
        sdkSessionIndex: this.sessionStore.getSdkSessionIndex(),
        sessionMapKey: sessionId,
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
          const { commands } = await this.cache.getCommands(
            this.getOrCreateRegistry(cwdKey),
            cwdKey
          );
          return commands.map((c) => c.fullCommand);
        },
      },
      opts
    );
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
  async refreshActivatedPlugins(): Promise<void> {
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
      logger.debug('[refreshActivatedPlugins] commands_changed broadcast failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** @inheritdoc */
  async renameSession(sessionId: string, title: string, projectDir: string): Promise<void> {
    await sdkRenameSession(sessionId, title, { dir: projectDir });
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
    alwaysAllow?: boolean
  ): boolean {
    const resolved = this.sessionStore.approveTool(sessionId, toolCallId, approved, alwaysAllow);
    if (resolved) {
      this.notifyInteractionResolved(sessionId, toolCallId, approved ? 'approved' : 'denied');
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
    resolution: 'approved' | 'denied' | 'answered'
  ): void {
    this.resolveLiveProjector(sessionId)?.resolveInteraction(interactionId, resolution);
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
    return this.sessionStore.interruptQuery(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Session queries (delegated to TranscriptReader)
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  async listSessions(projectDir: string): Promise<Session[]> {
    return this.transcriptReader.listSessions(projectDir);
  }

  /** @inheritdoc */
  async getSession(projectDir: string, sessionId: string): Promise<Session | null> {
    return this.transcriptReader.getSession(projectDir, sessionId);
  }

  /** @inheritdoc */
  async getMessageHistory(projectDir: string, sessionId: string): Promise<HistoryMessage[]> {
    return this.transcriptReader.readTranscript(projectDir, sessionId);
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
   * already on disk — fleet-wide, across every project slug directory under
   * `~/.claude/projects/` — then upserts/removals as transcripts change in any
   * of them, including sessions created or appended by the Claude Code CLI
   * outside DorkOS (ADR-0263). Each session carries its true `cwd` from the
   * JSONL head, so multi-project clients route events to the right list
   * (SRV-I4). `ctx` is unused: the contract is "ALL sessions the adapter can
   * observe", not a per-cwd scope. Debounced; no timer poll.
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
    return this.cache.getCommands(registry, root, forceRefresh);
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
    return this.mcpServerFactory(stubSession);
  }
}
