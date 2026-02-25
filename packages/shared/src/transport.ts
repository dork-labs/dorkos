/**
 * Transport interface — the hexagonal architecture port that decouples the React client
 * from its backend. Two adapters exist: `HttpTransport` (standalone web, HTTP/SSE to Express)
 * and `DirectTransport` (Obsidian plugin, in-process services).
 *
 * Injected via React Context (`TransportProvider`).
 *
 * @module shared/transport
 */
import type {
  Session,
  CreateSessionRequest,
  UpdateSessionRequest,
  BrowseDirectoryResponse,
  CommandRegistry,
  HealthResponse,
  HistoryMessage,
  StreamEvent,
  TaskItem,
  ServerConfig,
  FileListResponse,
  GitStatusResponse,
  GitStatusError,
  PulseSchedule,
  PulseRun,
  CreateScheduleInput,
  UpdateScheduleRequest,
  ListRunsQuery,
} from './types.js';
import type { AdapterConfigZ, AdapterStatusZ } from './relay-schemas.js';

/** A single entry in the adapter list — config plus live status. */
export interface AdapterListItem {
  config: AdapterConfigZ;
  status: AdapterStatusZ;
}

export interface Transport {
  /** Create a new Claude agent session. */
  createSession(opts: CreateSessionRequest): Promise<Session>;
  /** List all sessions, optionally scoped to a working directory. */
  listSessions(cwd?: string): Promise<Session[]>;
  /** Get metadata for a single session by ID. */
  getSession(id: string, cwd?: string): Promise<Session>;
  /** Update session settings (permission mode, model). */
  updateSession(id: string, opts: UpdateSessionRequest, cwd?: string): Promise<Session>;
  /** Fetch message history for a session. */
  getMessages(sessionId: string, cwd?: string): Promise<{ messages: HistoryMessage[] }>;
  /**
   * Send a message and stream the response via SSE.
   *
   * @param sessionId - Target session UUID
   * @param content - User message text
   * @param onEvent - Callback invoked for each streamed event
   * @param signal - Optional AbortSignal to cancel the request
   * @param cwd - Optional working directory override
   */
  sendMessage(
    sessionId: string,
    content: string,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal,
    cwd?: string
  ): Promise<void>;
  /** Approve a pending tool call that requires user confirmation. */
  approveTool(sessionId: string, toolCallId: string): Promise<{ ok: boolean }>;
  /** Deny a pending tool call that requires user confirmation. */
  denyTool(sessionId: string, toolCallId: string): Promise<{ ok: boolean }>;
  /** Submit answers for an AskUserQuestion interactive prompt. */
  submitAnswers(
    sessionId: string,
    toolCallId: string,
    answers: Record<string, string>
  ): Promise<{ ok: boolean }>;
  /** Get the current task list for a session. */
  getTasks(sessionId: string, cwd?: string): Promise<{ tasks: TaskItem[] }>;
  /** Browse server filesystem directories for working directory selection. */
  browseDirectory(dirPath?: string, showHidden?: boolean): Promise<BrowseDirectoryResponse>;
  /** Get the server's default working directory. */
  getDefaultCwd(): Promise<{ path: string }>;
  /** List available slash commands from `.claude/commands/`. */
  getCommands(refresh?: boolean, cwd?: string): Promise<CommandRegistry>;
  /** List files in a directory for the file browser. */
  listFiles(cwd: string): Promise<FileListResponse>;
  /** Get git status (branch, changes) for a working directory. */
  getGitStatus(cwd?: string): Promise<GitStatusResponse | GitStatusError>;
  /** Server health check. */
  health(): Promise<HealthResponse>;
  /** Get server configuration (version, tunnel status, paths). */
  getConfig(): Promise<ServerConfig>;
  /** Start the ngrok tunnel and return the public URL. */
  startTunnel(): Promise<{ url: string }>;
  /** Stop the ngrok tunnel. */
  stopTunnel(): Promise<void>;

  // --- Pulse Scheduler ---

  /** List all Pulse schedules. */
  listSchedules(): Promise<PulseSchedule[]>;
  /** Create a new Pulse schedule. */
  createSchedule(opts: CreateScheduleInput): Promise<PulseSchedule>;
  /** Update an existing Pulse schedule. */
  updateSchedule(id: string, opts: UpdateScheduleRequest): Promise<PulseSchedule>;
  /** Delete a Pulse schedule. */
  deleteSchedule(id: string): Promise<{ success: boolean }>;
  /** Trigger a manual run of a schedule. */
  triggerSchedule(id: string): Promise<{ runId: string }>;
  /** List Pulse runs with optional filters. */
  listRuns(opts?: Partial<ListRunsQuery>): Promise<PulseRun[]>;
  /** Get a specific Pulse run. */
  getRun(id: string): Promise<PulseRun>;
  /** Cancel a running Pulse job. */
  cancelRun(id: string): Promise<{ success: boolean }>;

  // --- Relay Message Bus ---

  /** List relay messages with optional filters. */
  listRelayMessages(filters?: {
    subject?: string;
    status?: string;
    from?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ messages: unknown[]; nextCursor?: string }>;
  /** Get a single relay message by ID. */
  getRelayMessage(id: string): Promise<unknown>;
  /** Send a relay message. */
  sendRelayMessage(opts: {
    subject: string;
    payload: unknown;
    from: string;
    replyTo?: string;
  }): Promise<{ messageId: string; deliveredTo: number }>;
  /** List relay endpoints. */
  listRelayEndpoints(): Promise<unknown[]>;
  /** Register a relay endpoint. */
  registerRelayEndpoint(subject: string): Promise<unknown>;
  /** Unregister a relay endpoint. */
  unregisterRelayEndpoint(subject: string): Promise<{ success: boolean }>;
  /** Read inbox for a relay endpoint. */
  readRelayInbox(
    subject: string,
    opts?: { status?: string; cursor?: string; limit?: number }
  ): Promise<{ messages: unknown[]; nextCursor?: string }>;
  /** Get relay system metrics. */
  getRelayMetrics(): Promise<unknown>;

  // --- Relay Adapters ---

  /** List all relay adapters with their live status. */
  listRelayAdapters(): Promise<AdapterListItem[]>;
  /** Enable or disable a relay adapter by ID. */
  toggleRelayAdapter(id: string, enabled: boolean): Promise<{ ok: boolean }>;
}
