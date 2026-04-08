/**
 * Claude Code Runtime — implements the AgentRuntime interface for the Claude Agent SDK.
 *
 * Thin facade that coordinates SessionStore, RuntimeCache, TranscriptReader,
 * SessionBroadcaster, SessionLockManager, and CommandRegistryService.
 *
 * @module services/runtimes/claude-code/claude-code-runtime
 */
import { renameSession as sdkRenameSession } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerEntry } from '@dorkos/shared/transport';
import type {
  StreamEvent,
  PermissionMode,
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
} from '@dorkos/shared/agent-runtime';
import { CLAUDE_CODE_CAPABILITIES } from './runtime-constants.js';
import { SessionStore } from './session-store.js';
import { RuntimeCache } from './runtime-cache.js';
import { SessionLockManager } from './session-lock.js';
import type { AgentSession } from './agent-types.js';
import { resolveClaudeCliPath } from './sdk-utils.js';
import { logger } from '../../../lib/logger.js';
import { DEFAULT_CWD } from '../../../lib/resolve-root.js';
import { TranscriptReader } from './transcript-reader.js';
import { SessionBroadcaster } from './session-broadcaster.js';
import { CommandRegistryService } from './command-registry.js';
import { executeSdkQuery } from './message-sender.js';

export { buildTaskEvent } from './build-task-event.js';

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
  private readonly cache = new RuntimeCache();
  private readonly transcriptReader: TranscriptReader;
  private readonly broadcaster: SessionBroadcaster;
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

  constructor(cwd?: string) {
    this.cwd = cwd ?? DEFAULT_CWD;
    this.claudeCliPath = resolveClaudeCliPath();
    this.transcriptReader = new TranscriptReader();
    this.broadcaster = new SessionBroadcaster(this.transcriptReader, this.lockManager);
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
    const { checkClaudeDependency } = await import('./check-dependency.js');
    return [checkClaudeDependency()];
  }

  // ---------------------------------------------------------------------------
  // Dependency injection
  // ---------------------------------------------------------------------------

  /** Set the agent registry for agent manifest resolution and peer agent context. */
  setMeshCore(meshCore: AgentRegistryPort): void {
    this.meshCore = meshCore;
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

  /** Expose the internal SessionBroadcaster for routes that need direct access. */
  getSessionBroadcaster(): SessionBroadcaster {
    return this.broadcaster;
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
  updateSession(
    sessionId: string,
    opts: {
      permissionMode?: PermissionMode;
      model?: string;
      effort?: 'low' | 'medium' | 'high' | 'max';
    }
  ): boolean {
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

    if (opts?.uiState) session.uiState = opts.uiState;

    const cwdKey = opts?.cwd || session.cwd || this.cwd;

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
        plugins: this.activatedPlugins,
      },
      opts
    );
  }

  /**
   * Refresh the cached marketplace plugins array (marketplace-05,
   * ADR-0239). Should be called once at server startup and whenever the
   * install/uninstall/update pipeline mutates the set of installed
   * packages so the next `sendMessage` picks up the new list.
   *
   * Best-effort — filesystem scan failures leave `activatedPlugins`
   * unchanged so a single misbehaving plugin never blocks sessions.
   */
  async refreshActivatedPlugins(): Promise<void> {
    try {
      const { resolveDorkHome } = await import('../../../lib/dork-home.js');
      const { listEnabledPluginNames } = await import('../../marketplace/installed-scanner.js');
      const { buildClaudeAgentSdkPluginsArray } = await import('./plugin-activation.js');
      const { logger } = await import('../../../lib/logger.js');
      const dorkHome = resolveDorkHome();
      const enabledNames = await listEnabledPluginNames(dorkHome);
      if (enabledNames.length === 0) {
        this.activatedPlugins = [];
        return;
      }
      this.activatedPlugins = await buildClaudeAgentSdkPluginsArray({
        dorkHome,
        enabledPluginNames: enabledNames,
        logger,
      });
    } catch {
      // Best-effort; leave the previous value in place.
    }
  }

  /** @inheritdoc */
  async renameSession(sessionId: string, title: string, projectDir: string): Promise<void> {
    await sdkRenameSession(sessionId, title, { dir: projectDir });
    this.transcriptReader.setCustomTitle(sessionId, title);
  }

  // ---------------------------------------------------------------------------
  // Interactive flows (delegated to SessionStore)
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  approveTool(sessionId: string, toolCallId: string, approved: boolean): boolean {
    return this.sessionStore.approveTool(sessionId, toolCallId, approved);
  }

  /** @inheritdoc */
  submitAnswers(sessionId: string, toolCallId: string, answers: Record<string, string>): boolean {
    return this.sessionStore.submitAnswers(sessionId, toolCallId, answers);
  }

  /** @inheritdoc */
  submitElicitation(
    sessionId: string,
    interactionId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>
  ): boolean {
    return this.sessionStore.submitElicitation(sessionId, interactionId, action, content);
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
  // Session sync (delegated to SessionBroadcaster)
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  watchSession(
    sessionId: string,
    projectDir: string,
    callback: (event: StreamEvent) => void,
    clientId?: string
  ): () => void {
    return this.broadcaster.registerCallback(sessionId, projectDir, callback, clientId);
  }

  // ---------------------------------------------------------------------------
  // Session locking (delegated to SessionLockManager)
  // ---------------------------------------------------------------------------

  /** @inheritdoc */
  acquireLock(sessionId: string, clientId: string, res: SseResponse): boolean {
    return this.lockManager.acquireLock(sessionId, clientId, res);
  }

  /** @inheritdoc */
  releaseLock(sessionId: string, clientId: string): void {
    this.lockManager.releaseLock(sessionId, clientId);
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
    this.sessionStore.checkSessionHealth(this.lockManager);
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
