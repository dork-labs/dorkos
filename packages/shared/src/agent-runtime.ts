/**
 * Universal AgentRuntime interface — the contract that all agent backends must implement.
 *
 * This module defines the abstraction layer between DorkOS routes/services and
 * specific agent backend implementations (ClaudeCodeRuntime, future OpenCodeRuntime, etc.).
 *
 * @module shared/agent-runtime
 */
import type {
  StreamEvent,
  Session,
  HistoryMessage,
  TaskItem,
  ModelOption,
  CommandRegistry,
  PermissionMode,
} from './types.js';

/** Minimal response interface for session locking — only needs close event detection. */
export interface SseResponse {
  on(event: 'close', cb: () => void): void;
}

/**
 * Narrow port interface for agent registry operations.
 * MeshCore satisfies this structurally — no `implements` clause needed.
 */
export interface AgentRegistryPort {
  getByPath(cwd: string): { id: string; name?: string } | undefined;
  updateLastSeen(agentId: string, event: string): void;
  listWithPaths(): Array<{
    id: string;
    name: string;
    projectPath: string;
    icon?: string;
    color?: string;
  }>;
}

/**
 * Narrow port interface for relay messaging operations.
 * RelayCore satisfies this structurally — no `implements` clause needed.
 */
export interface RelayPort {
  publish(subject: string, payload: unknown, options: unknown): Promise<unknown>;
}

/** Runtime capability flags — describes what a given backend supports. */
export interface RuntimeCapabilities {
  /** Runtime identifier, e.g. 'claude-code' | 'opencode' | 'aider' */
  readonly type: string;

  /** Whether this runtime supports permission modes */
  supportsPermissionModes: boolean;
  supportedPermissionModes?: PermissionMode[];

  /** Whether tool approval UI should be shown */
  supportsToolApproval: boolean;

  /** Whether cost/token tracking is available */
  supportsCostTracking: boolean;

  /** Whether sessions can be resumed */
  supportsResume: boolean;

  /** Whether MCP tool servers can be injected */
  supportsMcp: boolean;

  /** Whether AskUserQuestion interactive flow is supported */
  supportsQuestionPrompt: boolean;
}

/** Options for creating or resuming a session. */
export interface SessionOpts {
  permissionMode: PermissionMode;
  cwd?: string;
  hasStarted?: boolean;
}

/** Options for sending a message to a session. */
export interface MessageOpts {
  permissionMode?: PermissionMode;
  cwd?: string;
  systemPromptAppend?: string;
}

/**
 * Universal contract for agent backends.
 *
 * All session lifecycle, messaging, storage queries, and synchronization operations
 * are expressed through this interface. Routes and services depend only on
 * `AgentRuntime`, never on a specific implementation like `ClaudeCodeRuntime`.
 */
export interface AgentRuntime {
  /** Runtime type identifier, e.g. 'claude-code' */
  readonly type: string;

  // --- Session lifecycle ---

  /** Create or resume a session. */
  ensureSession(sessionId: string, opts: SessionOpts): void;

  /** Return true if the session is currently tracked in memory. */
  hasSession(sessionId: string): boolean;

  /** Update mutable session fields. Returns false if the session does not exist. */
  updateSession(
    sessionId: string,
    opts: {
      permissionMode?: PermissionMode;
      model?: string;
    }
  ): boolean;

  // --- Messaging ---

  /**
   * Send a user message and stream back response events.
   *
   * @param sessionId - The session to send the message to
   * @param content - User message text
   * @param opts - Optional overrides for permission mode, cwd, and system prompt
   */
  sendMessage(sessionId: string, content: string, opts?: MessageOpts): AsyncGenerator<StreamEvent>;

  // --- Interactive flows ---

  /**
   * Approve or deny a pending tool call.
   *
   * @param sessionId - Target session
   * @param toolCallId - The tool call to approve/deny
   * @param approved - Whether to approve (true) or deny (false)
   * @returns false if the session or interaction was not found
   */
  approveTool(sessionId: string, toolCallId: string, approved: boolean): boolean;

  /**
   * Submit answers to a pending AskUserQuestion interaction.
   *
   * @param sessionId - Target session
   * @param toolCallId - The question tool call to answer
   * @param answers - Map of question key → answer value
   * @returns false if the session or interaction was not found
   */
  submitAnswers(sessionId: string, toolCallId: string, answers: Record<string, string>): boolean;

  // --- Session queries (storage) ---

  /** List all sessions for a project directory. */
  listSessions(projectDir: string): Promise<Session[]>;

  /** Get metadata for a single session, or null if not found. */
  getSession(projectDir: string, sessionId: string): Promise<Session | null>;

  /** Read the full message history for a session. */
  getMessageHistory(projectDir: string, sessionId: string): Promise<HistoryMessage[]>;

  /** Read task items from a session transcript. */
  getSessionTasks(projectDir: string, sessionId: string): Promise<TaskItem[]>;

  /** Get the ETag for a session's transcript (for conditional HTTP responses). */
  getSessionETag(projectDir: string, sessionId: string): Promise<string | null>;

  /**
   * Return the JSONL-assigned message IDs for the last user and assistant
   * messages in a session. Used for client-server ID reconciliation.
   *
   * @param sessionId - Session to query
   * @returns ID pair or null if not available
   */
  getLastMessageIds(sessionId: string): Promise<{ user: string; assistant: string } | null>;

  /**
   * Read new content from a session transcript starting at a byte offset.
   *
   * @param projectDir - Project directory for transcript lookup
   * @param sessionId - Target session ID
   * @param offset - Byte offset to start reading from
   * @returns New content and the updated byte offset
   */
  readFromOffset(
    projectDir: string,
    sessionId: string,
    offset: number
  ): Promise<{ content: string; newOffset: number }>;

  // --- Session sync ---

  /**
   * Watch a session for new content and invoke the callback on each event.
   *
   * @param sessionId - Session to watch
   * @param projectDir - Project directory for transcript lookup
   * @param callback - Called with each new stream event
   * @param clientId - Optional client identifier for deduplication
   * @returns Unsubscribe function — call to stop watching
   */
  watchSession(
    sessionId: string,
    projectDir: string,
    callback: (event: StreamEvent) => void,
    clientId?: string
  ): () => void;

  // --- Session locking ---

  /**
   * Attempt to acquire an exclusive write lock for a session.
   *
   * @param sessionId - Session to lock
   * @param clientId - Identifying string for the lock holder
   * @param res - SSE response to release the lock when the connection closes
   * @returns true if the lock was acquired, false if already held by another client
   */
  acquireLock(sessionId: string, clientId: string, res: SseResponse): boolean;

  /** Release the lock held by a specific client. No-op if not locked by that client. */
  releaseLock(sessionId: string, clientId: string): void;

  /**
   * Check whether a session is currently locked.
   *
   * @param sessionId - Session to check
   * @param clientId - If provided, returns true only if locked by a different client
   */
  isLocked(sessionId: string, clientId?: string): boolean;

  /** Get lock metadata, or null if the session is not locked. */
  getLockInfo(sessionId: string): { clientId: string; acquiredAt: number } | null;

  // --- Capabilities ---

  /** Return available models for this runtime. */
  getSupportedModels(): Promise<ModelOption[]>;

  /** Return static capability flags for this runtime. */
  getCapabilities(): RuntimeCapabilities;

  // --- Commands ---

  /**
   * Return the command registry for this runtime.
   *
   * @param forceRefresh - If true, bypass the cache and re-scan
   * @param cwd - Optional working directory for per-directory command resolution
   */
  getCommands(forceRefresh?: boolean, cwd?: string): Promise<CommandRegistry>;

  // --- Lifecycle ---

  /** Evict sessions that have exceeded their idle timeout. */
  checkSessionHealth(): void;

  /**
   * Return the backend-internal session ID for a given DorkOS session ID.
   * For Claude Code this is the SDK session ID used in JSONL filenames.
   */
  getInternalSessionId(sessionId: string): string | undefined;

  // --- Tool server (optional) ---

  /** Return the MCP tool server config, if this runtime supports it. */
  getToolServerConfig?(): Record<string, unknown>;

  /** Register a factory that produces a fresh MCP tool server per query. */
  setMcpServerFactory?(factory: () => Record<string, unknown>): void;

  /**
   * Return last-known MCP server status for a project path, or null if not yet available.
   *
   * Implement this to surface live connectivity status (connected/failed/pending) in the UI.
   * The default fallback is `.mcp.json` config-only parsing (no connectivity data).
   *
   * @param cwd - Absolute project directory path
   */
  getMcpStatus?(cwd: string): import('./transport.js').McpServerEntry[] | null;

  // --- Dependency injection (optional) ---

  /** Inject an agent registry for peer-agent context and agent manifest resolution. */
  setMeshCore?(meshCore: AgentRegistryPort): void;

  /** Inject a relay instance for Relay-aware context building. */
  setRelay?(relay: RelayPort): void;
}
