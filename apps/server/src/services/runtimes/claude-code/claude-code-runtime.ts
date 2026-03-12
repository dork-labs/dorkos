/**
 * Claude Code Runtime — implements the AgentRuntime interface for the Claude Agent SDK.
 *
 * Encapsulates all Claude-specific session management, messaging, transcript reading,
 * file watching, tool approval, command registry, and session locking. Replaces the
 * former standalone AgentManager class with an implementation of the universal interface.
 *
 * @module services/runtimes/claude-code/claude-code-runtime
 */
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerEntry } from '@dorkos/shared/transport';
import type {
  StreamEvent,
  PermissionMode,
  ModelOption,
  Session,
  HistoryMessage,
  TaskItem,
  CommandRegistry,
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
import { SESSIONS } from '../../../config/constants.js';
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

const DEFAULT_MODELS: ModelOption[] = [
  {
    value: 'claude-sonnet-4-5-20250929',
    displayName: 'Sonnet 4.5',
    description: 'Fast, intelligent model for everyday tasks',
  },
  {
    value: 'claude-haiku-4-5-20251001',
    displayName: 'Haiku 4.5',
    description: 'Fastest, most compact model',
  },
  {
    value: 'claude-opus-4-6',
    displayName: 'Opus 4.6',
    description: 'Most capable model for complex tasks',
  },
];

/** Static Claude Code capabilities — all features are supported. */
const CLAUDE_CODE_CAPABILITIES: RuntimeCapabilities = {
  type: 'claude-code',
  supportsPermissionModes: true,
  supportedPermissionModes: ['default', 'plan', 'acceptEdits', 'bypassPermissions'],
  supportsToolApproval: true,
  supportsCostTracking: true,
  supportsResume: true,
  supportsMcp: true,
  supportsQuestionPrompt: true,
};

/**
 * Claude Code runtime implementing the universal AgentRuntime interface.
 *
 * Manages Claude Agent SDK sessions — creation, resumption, streaming, tool approval,
 * and session locking. Internally owns a TranscriptReader, SessionBroadcaster, and
 * CommandRegistryService. Calls the SDK's `query()` function and maps streaming events
 * to DorkOS `StreamEvent` types. Tracks active sessions in-memory with 30-minute timeout.
 */
export class ClaudeCodeRuntime implements AgentRuntime {
  readonly type = 'claude-code' as const;

  // Internal services (previously standalone singletons)
  private readonly transcriptReader: TranscriptReader;
  private readonly broadcaster: SessionBroadcaster;
  private commandRegistries = new Map<string, CommandRegistryService>();
  private static readonly MAX_COMMAND_REGISTRIES = 50;

  // Session management
  private sessions = new Map<string, AgentSession>();
  /** Reverse index: SDK session ID -> our session map key, for O(1) lookup. */
  private sdkSessionIndex = new Map<string, string>();
  private lockManager = new SessionLockManager();
  private readonly SESSION_TIMEOUT_MS = SESSIONS.TIMEOUT_MS;
  private readonly cwd: string;
  private readonly claudeCliPath: string | undefined;
  private mcpServerFactory: (() => Record<string, McpServerConfig>) | null = null;
  private cachedModels: ModelOption[] | null = null;
  private cachedMcpStatus = new Map<string, McpServerEntry[]>();
  private meshCore: AgentRegistryPort | null = null;

  constructor(cwd?: string) {
    this.cwd = cwd ?? DEFAULT_CWD;
    this.claudeCliPath = resolveClaudeCliPath();
    this.transcriptReader = new TranscriptReader();
    this.broadcaster = new SessionBroadcaster(this.transcriptReader);
  }

  // ---------------------------------------------------------------------------
  // Capabilities
  // ---------------------------------------------------------------------------

  /** Return static Claude Code capability flags. */
  getCapabilities(): RuntimeCapabilities {
    return CLAUDE_CODE_CAPABILITIES;
  }

  // ---------------------------------------------------------------------------
  // Dependency injection
  // ---------------------------------------------------------------------------

  /**
   * Set the agent registry for agent manifest resolution and peer agent context.
   *
   * @param meshCore - An AgentRegistryPort implementation (e.g. MeshCore)
   */
  setMeshCore(meshCore: AgentRegistryPort): void {
    this.meshCore = meshCore;
  }

  /** Inject a Relay core instance for Relay-aware context building. */
  setRelay(relay: RelayPort): void {
    // SessionBroadcaster uses RelayCore for relay subscription fan-in
    if (relay && typeof relay === 'object') {
      this.broadcaster.setRelay(relay as Parameters<SessionBroadcaster['setRelay']>[0]);
    }
  }

  /**
   * Register a factory that creates fresh MCP tool server configs per query() call.
   *
   * Each SDK query() call needs its own McpServer instance because the SDK's
   * internal Protocol can only be connected to one transport at a time. Reusing
   * the same instance across concurrent queries causes "Already connected to a
   * transport" errors.
   *
   * @param factory - A function that returns a fresh McpServerConfig record
   */
  setMcpServerFactory(factory: () => Record<string, McpServerConfig>): void {
    this.mcpServerFactory = factory;
  }

  // ---------------------------------------------------------------------------
  // Internal service accessors (for routes that need direct access during migration)
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
  // Session lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start or resume an agent session.
   * For new sessions, sdkSessionId is assigned after the first query() init message.
   * For resumed sessions, the sessionId IS the sdkSessionId.
   */
  ensureSession(sessionId: string, opts: SessionOpts): void {
    if (!this.sessions.has(sessionId)) {
      if (this.sessions.size >= SESSIONS.MAX_SESSIONS) {
        throw new Error(
          `Maximum session limit reached (${SESSIONS.MAX_SESSIONS}). ` +
            'Wait for existing sessions to expire or restart the server.'
        );
      }
      logger.debug('[ensureSession] creating new session', {
        session: sessionId,
        cwd: opts.cwd || '(empty)',
        permissionMode: opts.permissionMode,
        hasStarted: opts.hasStarted ?? false,
      });
      this.sessions.set(sessionId, {
        sdkSessionId: sessionId,
        lastActivity: Date.now(),
        permissionMode: opts.permissionMode,
        cwd: opts.cwd,
        hasStarted: opts.hasStarted ?? false,
        pendingInteractions: new Map(),
        eventQueue: [],
      });
      // Initial reverse index entry (sdkSessionId === sessionId at creation)
      this.sdkSessionIndex.set(sessionId, sessionId);
    }
  }

  /** Return true if the session is currently tracked in memory. */
  hasSession(sessionId: string): boolean {
    return !!this.findSession(sessionId);
  }

  /** Update mutable session fields. Returns false if the session does not exist. */
  updateSession(
    sessionId: string,
    opts: { permissionMode?: PermissionMode; model?: string }
  ): boolean {
    let session = this.findSession(sessionId);
    if (!session) {
      this.ensureSession(sessionId, {
        permissionMode: opts.permissionMode ?? 'default',
        hasStarted: true,
      });
      session = this.sessions.get(sessionId)!;
    }
    if (opts.permissionMode) {
      logger.debug('[updateSession] permissionMode change', {
        sessionId,
        from: session.permissionMode,
        to: opts.permissionMode,
      });
      session.permissionMode = opts.permissionMode;
      if (session.activeQuery) {
        session.activeQuery.setPermissionMode(opts.permissionMode).catch((err) => {
          logger.error('[updateSession] setPermissionMode failed', { sessionId, err });
        });
      }
    }
    if (opts.model) {
      session.model = opts.model;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  async *sendMessage(
    sessionId: string,
    content: string,
    opts?: MessageOpts
  ): AsyncGenerator<StreamEvent> {
    // Auto-create session if it doesn't exist (for resuming SDK sessions).
    if (!this.sessions.has(sessionId)) {
      this.ensureSession(sessionId, {
        permissionMode: opts?.permissionMode ?? 'default',
        cwd: opts?.cwd,
        hasStarted: true,
      });
    }

    const session = this.sessions.get(sessionId)!;

    yield* executeSdkQuery(sessionId, content, session, {
      cwd: this.cwd,
      sessionCwd: session.cwd,
      claudeCliPath: this.claudeCliPath,
      meshCore: this.meshCore,
      mcpServerFactory: this.mcpServerFactory,
      onModelsReceived: !this.cachedModels
        ? (models) => {
            this.cachedModels = models;
            logger.debug('[sendMessage] cached supported models', {
              count: models.length,
            });
          }
        : undefined,
      onMcpStatusReceived: (servers) => {
        // Mirror effectiveCwd resolution in executeSdkQuery so the key matches the queried dir
        const key = opts?.cwd || session.cwd || this.cwd;
        this.cachedMcpStatus.set(key, servers);
        logger.debug('[sendMessage] cached MCP server status', { cwd: key, count: servers.length });
      },
      sdkSessionIndex: this.sdkSessionIndex,
      sessionMapKey: sessionId,
    }, opts);
  }

  // ---------------------------------------------------------------------------
  // Interactive flows
  // ---------------------------------------------------------------------------

  /** Approve or deny a pending tool call. */
  approveTool(sessionId: string, toolCallId: string, approved: boolean): boolean {
    const session = this.findSession(sessionId);
    const pending = session?.pendingInteractions.get(toolCallId);
    if (!pending || pending.type !== 'approval') return false;
    pending.resolve(approved);
    return true;
  }

  /** Submit answers to a pending AskUserQuestion interaction. */
  submitAnswers(
    sessionId: string,
    toolCallId: string,
    answers: Record<string, string>
  ): boolean {
    const session = this.findSession(sessionId);
    const pending = session?.pendingInteractions.get(toolCallId);
    if (!pending || pending.type !== 'question') return false;
    pending.resolve(answers);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Session queries — delegated to TranscriptReader
  // ---------------------------------------------------------------------------

  /** List all sessions for a project directory. */
  async listSessions(projectDir: string): Promise<Session[]> {
    return this.transcriptReader.listSessions(projectDir);
  }

  /** Get metadata for a single session, or null if not found. */
  async getSession(projectDir: string, sessionId: string): Promise<Session | null> {
    return this.transcriptReader.getSession(projectDir, sessionId);
  }

  /** Read the full message history for a session. */
  async getMessageHistory(projectDir: string, sessionId: string): Promise<HistoryMessage[]> {
    return this.transcriptReader.readTranscript(projectDir, sessionId);
  }

  /** Read task items from a session transcript. */
  async getSessionTasks(projectDir: string, sessionId: string): Promise<TaskItem[]> {
    return this.transcriptReader.readTasks(projectDir, sessionId);
  }

  /** Get the ETag for a session's transcript. */
  async getSessionETag(projectDir: string, sessionId: string): Promise<string | null> {
    return this.transcriptReader.getTranscriptETag(projectDir, sessionId);
  }

  /** Read new content from a session transcript starting at a byte offset. */
  async readFromOffset(
    projectDir: string,
    sessionId: string,
    offset: number
  ): Promise<{ content: string; newOffset: number }> {
    return this.transcriptReader.readFromOffset(projectDir, sessionId, offset);
  }

  // ---------------------------------------------------------------------------
  // Session sync — delegated to SessionBroadcaster
  // ---------------------------------------------------------------------------

  /**
   * Watch a session for new content and invoke the callback on each event.
   *
   * Delegates to SessionBroadcaster.registerCallback() which starts a file watcher,
   * optionally subscribes to relay messages, and invokes the callback on sync_update events.
   *
   * @param sessionId - Session UUID to watch
   * @param projectDir - Project directory for transcript lookup
   * @param callback - Called with each new stream event
   * @param clientId - Optional client identifier for relay subscription
   * @returns Unsubscribe function — call to stop watching
   */
  watchSession(
    sessionId: string,
    projectDir: string,
    callback: (event: StreamEvent) => void,
    clientId?: string
  ): () => void {
    return this.broadcaster.registerCallback(sessionId, projectDir, callback, clientId);
  }

  // ---------------------------------------------------------------------------
  // Session locking — delegated to SessionLockManager
  // ---------------------------------------------------------------------------

  /** Attempt to acquire an exclusive write lock for a session. */
  acquireLock(sessionId: string, clientId: string, res: SseResponse): boolean {
    return this.lockManager.acquireLock(sessionId, clientId, res);
  }

  /** Release the lock held by a specific client. */
  releaseLock(sessionId: string, clientId: string): void {
    this.lockManager.releaseLock(sessionId, clientId);
  }

  /** Check whether a session is currently locked. */
  isLocked(sessionId: string, clientId?: string): boolean {
    return this.lockManager.isLocked(sessionId, clientId);
  }

  /** Get lock metadata, or null if the session is not locked. */
  getLockInfo(sessionId: string): { clientId: string; acquiredAt: number } | null {
    return this.lockManager.getLockInfo(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Models
  // ---------------------------------------------------------------------------

  /** Get available models — returns SDK-reported models if cached, otherwise defaults. */
  async getSupportedModels(): Promise<ModelOption[]> {
    return this.cachedModels ?? DEFAULT_MODELS;
  }

  // ---------------------------------------------------------------------------
  // Commands — delegated to CommandRegistryService
  // ---------------------------------------------------------------------------

  /** Return the command registry for the given CWD (defaults to server CWD). */
  async getCommands(forceRefresh?: boolean, cwd?: string): Promise<CommandRegistry> {
    const root = cwd || this.cwd;
    let registry = this.commandRegistries.get(root);
    if (!registry) {
      // Evict oldest entry if cache is full
      if (this.commandRegistries.size >= ClaudeCodeRuntime.MAX_COMMAND_REGISTRIES) {
        const oldest = this.commandRegistries.keys().next().value!;
        this.commandRegistries.delete(oldest);
      }
      registry = new CommandRegistryService(root);
      this.commandRegistries.set(root, registry);
    }
    return registry.getCommands(forceRefresh);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Evict sessions that have exceeded their idle timeout. */
  checkSessionHealth(): void {
    const now = Date.now();
    const expiredIds: string[] = [];
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > this.SESSION_TIMEOUT_MS) {
        for (const interaction of session.pendingInteractions.values()) {
          clearTimeout(interaction.timeout);
        }
        this.sdkSessionIndex.delete(session.sdkSessionId);
        this.sessions.delete(id);
        expiredIds.push(id);
      }
    }
    this.lockManager.cleanup(expiredIds);
  }

  /**
   * Return the backend-internal session ID for a given DorkOS session ID.
   * For Claude Code this is the SDK session ID used in JSONL filenames.
   */
  getInternalSessionId(sessionId: string): string | undefined {
    return this.findSession(sessionId)?.sdkSessionId;
  }

  /**
   * Backward-compatible alias for `getInternalSessionId`.
   *
   * @deprecated Use `getInternalSessionId()` instead.
   */
  getSdkSessionId(sessionId: string): string | undefined {
    return this.getInternalSessionId(sessionId);
  }

  // ---------------------------------------------------------------------------
  // MCP status cache
  // ---------------------------------------------------------------------------

  /**
   * Return last-known MCP server status for a project path, or null if no session has run.
   *
   * @param cwd - Absolute project directory path
   */
  getMcpStatus(cwd: string): McpServerEntry[] | null {
    return this.cachedMcpStatus.get(cwd) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Tool server (optional interface methods)
  // ---------------------------------------------------------------------------

  /** Return the MCP tool server config. */
  getToolServerConfig(): Record<string, unknown> {
    return this.mcpServerFactory ? this.mcpServerFactory() : {};
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Find a session by its map key OR by its sdkSessionId (O(1) via reverse index). */
  private findSession(sessionId: string): AgentSession | undefined {
    const direct = this.sessions.get(sessionId);
    if (direct) return direct;
    const mappedKey = this.sdkSessionIndex.get(sessionId);
    return mappedKey ? this.sessions.get(mappedKey) : undefined;
  }
}
