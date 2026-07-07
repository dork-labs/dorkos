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
  SessionListResponse,
  UpdateSessionRequest,
  BrowseDirectoryResponse,
  CommandRegistry,
  HealthResponse,
  HistoryMessage,
  TaskItem,
  ServerConfig,
  ModelOption,
  SubagentInfo,
  FileListResponse,
  GitStatusResponse,
  GitStatusError,
  Task,
  TaskRun,
  CreateTaskInput,
  UpdateTaskRequest,
  ListTaskRunsQuery,
  TaskTemplate,
  UploadResult,
  UploadProgress,
} from './types.js';
import type {
  Workspace,
  WorkspaceWithSessions,
  EnsureWorkspaceRequest,
  RemoveResult,
} from './workspace.js';
import type {
  AdapterConfig,
  AdapterStatus,
  TraceSpan,
  DeliveryMetrics,
  CatalogEntry,
  RelayConversation,
  AdapterBinding,
  CreateBindingRequest,
  UpdateBindingRequest,
  ObservedChat,
  BindingTestResult,
} from './relay-schemas.js';
import type {
  AgentManifest,
  AgentPathEntry,
  CreateAgentOptions,
  DiscoveryCandidate,
  DenialRecord,
  AgentHealth,
  MeshStatus,
  TopologyView,
  UpdateAccessRuleRequest,
  CrossNamespaceRule,
  TransportScanEvent,
  TransportScanOptions,
} from './mesh-schemas.js';
import type { RuntimeCapabilities, SystemRequirements } from './agent-runtime.js';
import type {
  StoreCredentialResult,
  DelegatedLoginResult,
  OpenRouterKeyResult,
  OpenRouterOAuthStart,
  OpenRouterOAuthStatus,
  OpenRouterModel,
  OllamaStatus,
  OllamaModelCatalog,
  OllamaPullProgress,
  OllamaPullResult,
} from './runtime-connect.js';
import type { SessionSnapshot, SessionEvent, SessionListEvent } from './session-stream.js';
import type { TemplateEntry } from './template-catalog.js';
import type { ClientContext } from './additional-context.js';
import type { ListActivityQuery, ListActivityResponse } from './activity-schemas.js';
import type {
  AggregatedPackage,
  PackageFilter,
  MarketplacePackageDetail,
  InstallOptions,
  InstallResult,
  UninstallOptions,
  UninstallResult,
  UpdateOptions,
  UpdateResult,
  InstalledPackage,
  MarketplaceSource,
  AddSourceInput,
} from './marketplace-schemas.js';
import type { CloudLinkStatus, CloudLinkSummary, StartLinkResult } from './cloud-schemas.js';

/** A single entry in the adapter list — config plus live status. */
export interface AdapterListItem {
  config: AdapterConfig;
  status: AdapterStatus;
}

/** Aggregated dead-letter group — multiple failures collapsed by source + reason. */
export interface AggregatedDeadLetter {
  /** Source identifier (adapter name or from field). */
  source: string;
  /** Rejection reason code. */
  reason: string;
  /** Number of matching dead letters in this group. */
  count: number;
  /** ISO timestamp of the earliest failure in this group. */
  firstSeen: string;
  /** ISO timestamp of the most recent failure in this group. */
  lastSeen: string;
  /** Representative envelope sample from this group. */
  sample?: unknown;
}

/** A single MCP server entry — from `.mcp.json` (config only) or live runtime status. */
export interface McpServerEntry {
  name: string;
  type: 'stdio' | 'sse' | 'http';
  /**
   * Current status reported by the owning runtime. Runtimes without MCP
   * support omit the entry entirely; see `capabilities.supportsMcp`.
   */
  status?: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  /** Error message populated when status === 'failed'. */
  error?: string;
  /**
   * Config scope — typically one of 'project' | 'user' | 'local' | 'managed'.
   * Additional runtime-specific scopes may appear; callers should treat this
   * as an open string and check `capabilities` for supported values.
   */
  scope?: string;
}

/** Response shape for the `GET /api/mcp-config` endpoint. */
export interface McpConfigResponse {
  servers: McpServerEntry[];
}

/** A lifecycle event recorded for an adapter instance. */
export interface AdapterEvent {
  id: string;
  subject: string;
  status: string;
  sentAt: string;
  metadata: string | null;
}

/**
 * Minimal file interface for upload — matches the browser File API.
 *
 * Using a custom interface (rather than the DOM `File` type) keeps the shared
 * package free of DOM lib dependencies so it can be used in Node.js contexts.
 */
export interface UploadFile {
  /** Original filename as provided by the user. */
  name: string;
  /** File size in bytes. */
  size: number;
  /** MIME type of the file. */
  type: string;
  /** Read the file contents as an ArrayBuffer. */
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Claude-specific capability-gated sub-transport.
 *
 * Obtained via `transport.asClaudePluginTransport(sessionId)` — non-null only
 * when the resolved runtime's `capabilities.supportsPlugins` is true. Callers
 * must gate access behind the capability check rather than calling the
 * universal Transport surface directly.
 */
export interface ClaudePluginTransport {
  /**
   * Trigger a plugin reload on the Claude-managed plugin set for the session
   * this sub-transport was obtained for. Only available when the resolved
   * runtime's `capabilities.supportsPlugins` is true.
   */
  reloadPlugins(): Promise<import('./types.js').ReloadPluginsResult>;
}

/**
 * Result of {@link Transport.writeFile}. A conflict is normal control flow (the
 * file changed under an optimistic-concurrency write), not an exception, so it
 * is returned rather than thrown — the caller decides whether to reload or
 * force-overwrite. Genuine failures (network, permissions, missing file) still
 * throw.
 */
export type WriteFileResult =
  | { ok: true; hash: string }
  | { ok: false; conflict: { currentHash: string; currentContent: string } };

/** A single progress frame emitted while a runtime binary is being provisioned on demand. */
export interface RuntimeProvisionProgress {
  /** Lifecycle stage of the install. */
  stage: 'starting' | 'installing' | 'done' | 'error';
  /** Human-readable progress line (installer output or a status message). */
  message: string;
}

/**
 * Terminal result of an on-demand runtime provisioning action (ADR-0317).
 *
 * On success the binary is resolvable and the runtime flips to Ready on the next
 * requirements probe; on failure the partial install is cleaned up and `error`
 * carries an honest message (never a raw stack) for the Connect surface.
 */
export interface RuntimeProvisionResult {
  /** True when the install completed and the binary is resolvable. */
  ok: boolean;
  /** Absolute path to the provisioned binary, when `ok`. */
  binaryPath?: string;
  /** Honest failure message when not `ok`. */
  error?: string;
}

export interface Transport {
  /** Optional client identifier for SSE presence tracking. */
  readonly clientId?: string;
  /**
   * List sessions across all registered runtimes, optionally scoped to a
   * working directory. Returns the aggregation envelope (ADR-0310): `sessions`
   * merged and sorted by `updatedAt` descending, plus optional per-runtime
   * `warnings` when a backend failed or timed out (partial results, never a
   * failed request).
   */
  listSessions(cwd?: string): Promise<SessionListResponse>;
  /** Get metadata for a single session by ID. */
  getSession(id: string, cwd?: string): Promise<Session>;
  /**
   * Resolve the runtime type string (e.g. `'claude-code'`, `'test-mode'`) that
   * owns the given session.
   *
   * Clients use this to gate UI off the active session's capabilities rather
   * than the server-default. Legacy sessions with no persisted runtime row
   * resolve to `'claude-code'` (infer-on-access) on the server side.
   *
   * @param sessionId - Session identifier
   */
  getSessionRuntimeType(sessionId: string): Promise<string>;
  /** Update session settings (permission mode, model). */
  updateSession(id: string, opts: UpdateSessionRequest, cwd?: string): Promise<Session>;
  /** Fork a session, creating a new independent copy. */
  forkSession(
    id: string,
    opts?: { upToMessageId?: string; title?: string },
    cwd?: string
  ): Promise<Session>;
  /** Fetch message history for a session. */
  getMessages(sessionId: string, cwd?: string): Promise<{ messages: HistoryMessage[] }>;
  /**
   * Fetch the authoritative current state of a session for hydration: completed
   * messages, the in-progress turn's events, status projection, pending
   * interactions, and the snapshot cursor (highest seq reflected). Subscribe
   * with this cursor to replay only events not yet seen.
   *
   * @param sessionId - Target session ID
   * @param cwd - Optional working directory override
   */
  getSessionSnapshot(sessionId: string, cwd?: string): Promise<SessionSnapshot>;
  /**
   * Subscribe to a session's normalized, monotonically-seq'd event stream.
   *
   * HTTP maps this to `GET /api/sessions/:id/events` (SSE); Direct/Obsidian maps
   * it to in-process async iteration. Pass `sinceCursor` to resume after a gap,
   * receiving only events with `seq` greater than the cursor.
   *
   * @param sessionId - Target session ID
   * @param sinceCursor - Resume point; emit only events past this cursor
   * @param cwd - Optional working directory override
   * @param signal - Aborts the stream deterministically. Mirrors
   *   `AgentRuntime.subscribeSession`: a bare `iterator.return()` cannot
   *   interrupt a generator parked on an un-settleable wait, so consumers that
   *   re-target or tear down (e.g. session switch) should abort via this signal.
   */
  subscribeSession(
    sessionId: string,
    sinceCursor?: number,
    cwd?: string,
    signal?: AbortSignal
  ): AsyncIterable<SessionEvent>;
  /**
   * Subscribe to the global session-list stream — discovery + liveness across
   * all observable sessions, feeding the sidebar and fleet-wide status view.
   *
   * HTTP maps this to `GET /api/events` (SSE); Direct/Obsidian maps it to
   * in-process async iteration.
   */
  subscribeSessionList(): AsyncIterable<SessionListEvent>;
  /**
   * Trigger a turn for a session and resolve to the canonical session id.
   *
   * POSTs to `/sessions/:id/messages` (trigger-only, `202`) and parses the
   * `{ sessionId }` body — the SDK-canonical id the server resolved for this
   * turn. The turn itself is delivered out-of-band over the durable `/events`
   * stream (snapshot → replay → live), NOT in this response. When the returned
   * `sessionId` differs from `sessionId`, the caller re-targets the durable
   * stream and rewrites the URL to the canonical id (create-on-first-message).
   *
   * Throws a typed `SESSION_LOCKED` error on `409` (another client holds the
   * lock) so callers can restore input and surface a busy banner.
   *
   * @param sessionId - Target session id (a client UUID for a brand-new session)
   * @param content - User message text
   * @param cwd - Optional working directory override
   * @param options - Optional additional parameters (clientMessageId for server-echo ID, context for neutral client signals: uiState, queued, runtime as the first-turn runtime hint resolved hint > agent manifest > default and persisted first-write-wins per ADR-0255)
   */
  postMessage(
    sessionId: string,
    content: string,
    cwd?: string,
    options?: { clientMessageId?: string; context?: ClientContext; runtime?: string }
  ): Promise<{ sessionId: string }>;
  /** Approve a pending tool call that requires user confirmation. */
  approveTool(
    sessionId: string,
    toolCallId: string,
    alwaysAllow?: boolean
  ): Promise<{ ok: boolean }>;
  /** Deny a pending tool call that requires user confirmation. */
  denyTool(sessionId: string, toolCallId: string): Promise<{ ok: boolean }>;
  /** Approve multiple pending tool calls at once. */
  batchApprove(
    sessionId: string,
    toolCallIds: string[]
  ): Promise<{ results: { toolCallId: string; ok: boolean }[] }>;
  /** Deny multiple pending tool calls at once. */
  batchDeny(
    sessionId: string,
    toolCallIds: string[]
  ): Promise<{ results: { toolCallId: string; ok: boolean }[] }>;
  /**
   * Submit answers for a structured-question prompt.
   *
   * `answers` is the canonical, runtime-neutral format: keyed by question index
   * (`"0"`, `"1"`, …), each value the answer as a display string with multi-select
   * selections joined by `", "`. The active runtime translates it for its backend.
   */
  submitAnswers(
    sessionId: string,
    toolCallId: string,
    answers: Record<string, string>
  ): Promise<{ ok: boolean }>;
  /** Submit a response to an MCP elicitation prompt. */
  submitElicitation(
    sessionId: string,
    interactionId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>
  ): Promise<{ ok: boolean }>;
  /**
   * Stop a running background task.
   *
   * @param sessionId - The parent session containing the task
   * @param taskId - The background task to stop
   * @returns Result indicating success or failure
   */
  stopTask(sessionId: string, taskId: string): Promise<{ success: boolean; taskId: string }>;
  /**
   * Interrupt the active query for a session.
   *
   * Best-effort — callers should not block on the result. The server attempts
   * a graceful SDK interrupt, falling back to a forceful close if needed.
   *
   * @param sessionId - The session whose query should be interrupted
   */
  interruptSession(sessionId: string): Promise<{ ok: boolean }>;
  /** Get the current task list for a session. */
  getTasks(sessionId: string, cwd?: string): Promise<{ tasks: TaskItem[] }>;
  /** Browse server filesystem directories for working directory selection. */
  browseDirectory(dirPath?: string, showHidden?: boolean): Promise<BrowseDirectoryResponse>;
  /** Get the server's default working directory. */
  getDefaultCwd(): Promise<{ path: string }>;
  /**
   * List available slash commands from the resolved runtime.
   *
   * @param refresh - Force a rescan of the command filesystem cache.
   * @param cwd - Working directory scope (passed to the runtime).
   * @param opts - Optional context. `runtime` explicitly selects a runtime by
   *   type and takes precedence — the not-yet-started-session path where no
   *   metadata row exists yet, so `sessionId` would wrongly infer the default
   *   (showing Claude's commands for a fresh Codex session). `sessionId`
   *   otherwise scopes the call to the runtime that owns the session. Omit both
   *   for cold-discovery (onboarding, first-run).
   */
  getCommands(
    refresh?: boolean,
    cwd?: string,
    opts?: { sessionId?: string; runtime?: string }
  ): Promise<CommandRegistry>;
  /** List files in a directory for the file browser. */
  listFiles(cwd: string): Promise<FileListResponse>;
  /**
   * Write edited content back to an existing file in a session's working
   * directory — backs the editable markdown canvas. The path is resolved within
   * and confined to `cwd`; the file must already exist (this never creates
   * files).
   *
   * The write can be made conditional (optimistic concurrency) by passing
   * `options.expectedHash` (a SHA-256 the client already holds) or, on a first
   * save when it has no hash, `options.expectedContent` (the baseline the server
   * hashes for it — so the client needs no `crypto.subtle`). If the on-disk
   * content no longer matches, the call resolves to `{ ok: false, conflict }`
   * carrying the current bytes. Pass neither to force an unconditional overwrite.
   *
   * @param cwd - Session working directory the path is resolved within.
   * @param filePath - File path, absolute or relative to `cwd`.
   * @param content - Full new file content.
   * @param options - `expectedHash` or `expectedContent` enable the conflict check.
   */
  writeFile(
    cwd: string,
    filePath: string,
    content: string,
    options?: { expectedHash?: string; expectedContent?: string }
  ): Promise<WriteFileResult>;
  /** Get git status (branch, changes) for a working directory. */
  getGitStatus(cwd?: string): Promise<GitStatusResponse | GitStatusError>;

  // --- Workspaces (server-managed isolated checkouts; DOR-84) ---
  /** List workspaces (optionally one project), each with its attached sessions. */
  listWorkspaces(projectKey?: string): Promise<WorkspaceWithSessions[]>;
  /** Resolve an absolute path (e.g. a session cwd) to its containing workspace, or null. */
  resolveWorkspace(absPath: string): Promise<Workspace | null>;
  /** Provision-or-reuse the workspace for a unit of work. */
  ensureWorkspace(req: EnsureWorkspaceRequest): Promise<Workspace>;
  /** Pin or unpin a workspace (pinned workspaces are exempt from cleanup). */
  pinWorkspace(id: string, pinned: boolean): Promise<Workspace>;
  /** Remove a workspace; refuses a dirty one unless `force`. */
  removeWorkspace(id: string, force?: boolean): Promise<RemoveResult>;

  /** Server health check. */
  health(): Promise<HealthResponse>;
  /** Get server configuration (version, tunnel status, paths). */
  getConfig(): Promise<ServerConfig>;
  /** Partially update the persisted user config. */
  updateConfig(patch: Record<string, unknown>): Promise<void>;
  /**
   * List models available for the resolved runtime.
   *
   * Individual entries' fields are runtime-specific; callers should not depend
   * on runtime-only fields beyond the base `ModelOption` shape.
   *
   * @param opts - Optional context. `runtime` explicitly selects a runtime by
   *   type and takes precedence — the not-yet-started-session path where no
   *   metadata row exists yet, so `sessionId` would wrongly infer the default.
   *   `sessionId` otherwise scopes the call to the runtime that owns the
   *   session. Omit both for cold-discovery (onboarding, first-run).
   */
  getModels(opts?: { sessionId?: string; runtime?: string }): Promise<ModelOption[]>;
  /**
   * List available subagents reported by the resolved runtime.
   *
   * @param opts - Optional context; `sessionId` scopes the call to the runtime
   *   that owns the session. Omit for cold-discovery (onboarding, first-run).
   */
  getSubagents(opts?: { sessionId?: string }): Promise<SubagentInfo[]>;
  /**
   * Get capabilities for all registered runtimes.
   *
   * @returns A map of runtime type → capabilities, plus the default runtime type.
   */
  getCapabilities(): Promise<{
    capabilities: Record<string, RuntimeCapabilities>;
    defaultRuntime: string;
  }>;
  /** Check system requirements (external dependencies) for all registered runtimes. */
  checkRequirements(): Promise<SystemRequirements>;
  /**
   * Provision the OpenCode runtime binary on demand (opt-in install, ADR-0317).
   *
   * Installs `opencode-ai` into a DorkOS-owned location and resolves to the
   * terminal result; when `onProgress` is supplied, streamed install progress is
   * delivered to it. Loopback-only server action. On failure the partial install
   * is cleaned up and the result carries an honest error.
   *
   * @param onProgress - Optional callback for streamed install progress frames.
   */
  provisionOpenCode(
    onProgress?: (progress: RuntimeProvisionProgress) => void
  ): Promise<RuntimeProvisionResult>;

  // --- Runtime Connect (terminal-free auth; ADR-0318, T1) ---

  /**
   * Store a runtime's native API key (paste-key path). The secret is encrypted
   * at rest and only its REFERENCE is persisted in config — the response returns
   * the reference, never the secret. Loopback-only server action.
   *
   * @param type - Runtime type (`'claude-code'` | `'codex'`).
   * @param secret - The raw API key. Sent once; never returned or logged.
   */
  storeRuntimeCredential(type: string, secret: string): Promise<StoreCredentialResult>;
  /**
   * Store an OpenCode Direct-provider's API key by reference and select it as
   * OpenCode's provider, recording an optional OpenAI-compatible base URL. The
   * secret is encrypted at rest and only its REFERENCE is persisted; the response
   * returns the reference, never the secret. Loopback-only server action.
   *
   * @param providerId - OpenAI-compatible provider id (e.g. `openai`).
   * @param secret - The raw provider API key. Sent once; never returned or logged.
   * @param baseURL - Optional base URL override; `null` clears a stored override.
   */
  storeProviderCredential(
    providerId: string,
    secret: string,
    baseURL?: string | null
  ): Promise<StoreCredentialResult>;
  /**
   * Delegate a vendor CLI login (`claude auth login` / `codex login`), spawned
   * terminal-free, resolving once the CLI reports a completed login. Bounded by a
   * server-side timeout so a never-completed login resolves to `{ ok: false }`
   * rather than blocking. Loopback-only server action.
   *
   * @param type - Runtime type (`'claude-code'` | `'codex'`).
   */
  delegateRuntimeLogin(type: string): Promise<DelegatedLoginResult>;
  /**
   * Validate and store an OpenRouter API key (Gateway paste-key path). The key is
   * validated against OpenRouter before being stored as a reference; the response
   * never echoes it. Loopback-only server action.
   *
   * @param key - The raw OpenRouter API key. Sent once; never returned or logged.
   */
  storeOpenRouterKey(key: string): Promise<OpenRouterKeyResult>;
  /**
   * Begin the OpenRouter OAuth-PKCE flow. Returns the authorize URL for the
   * client to open in a browser plus the flow `state` to poll; the `code_verifier`
   * stays server-side. Loopback-only server action.
   */
  startOpenRouterOAuth(): Promise<OpenRouterOAuthStart>;
  /**
   * Poll the status of an in-flight OpenRouter OAuth-PKCE flow. Resolves to
   * `connected` once the loopback callback exchanged the code for a scoped key.
   *
   * @param state - The flow id returned by {@link startOpenRouterOAuth}.
   */
  getOpenRouterOAuthStatus(state: string): Promise<OpenRouterOAuthStatus>;
  /** Fetch the OpenRouter model catalog for the model picker (short-TTL cached server-side). */
  getOpenRouterModels(): Promise<OpenRouterModel[]>;
  /**
   * Detect a local Ollama with zero auth: whether it is running and which coding
   * models are pulled. Bounded probe — an absent/hung Ollama degrades fast.
   */
  detectOllama(): Promise<OllamaStatus>;
  /**
   * Fetch the curated coding-model catalog for the guided pull, each entry
   * assessed against this machine's hardware with an honest fit verdict
   * (`runs-well | may-be-slow | too-large`). A static estimate, never a benchmark.
   * Loopback-only server action.
   */
  getOllamaModelCatalog(): Promise<OllamaModelCatalog>;
  /**
   * Trigger a single guided Ollama pull of a curated coding model and stream
   * download progress. Resolves to the terminal result; when `onProgress` is
   * supplied, streamed progress frames are delivered to it. DorkOS only triggers
   * the pull — it never owns or manages Ollama. Loopback-only server action.
   *
   * @param model - The curated model id to pull (e.g. `qwen2.5-coder:7b`).
   * @param onProgress - Optional callback for streamed download-progress frames.
   */
  pullOllamaModel(
    model: string,
    onProgress?: (progress: OllamaPullProgress) => void
  ): Promise<OllamaPullResult>;
  /** Start the ngrok tunnel and return the public URL. */
  startTunnel(): Promise<{ url: string }>;
  /** Stop the ngrok tunnel. */
  stopTunnel(): Promise<void>;

  // --- Tasks ---

  /** List all Tasks. */
  listTasks(): Promise<Task[]>;
  /** Create a new Task. */
  createTask(opts: CreateTaskInput): Promise<Task>;
  /** Update an existing Task. */
  updateTask(id: string, opts: UpdateTaskRequest): Promise<Task>;
  /** Delete a Task. */
  deleteTask(id: string): Promise<{ success: boolean }>;
  /** Trigger a manual run of a Task. */
  triggerTask(id: string): Promise<{ runId: string }>;
  /** List Task runs with optional filters. */
  listTaskRuns(opts?: Partial<ListTaskRunsQuery>): Promise<TaskRun[]>;
  /** Get a specific Task run. */
  getTaskRun(id: string): Promise<TaskRun>;
  /** Cancel a running Task. */
  cancelTaskRun(id: string): Promise<{ success: boolean }>;
  /** Fetch available Task templates for onboarding. */
  getTaskTemplates(): Promise<TaskTemplate[]>;

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
  /** List dead-letter messages with optional filters. */
  listRelayDeadLetters(filters?: { endpointHash?: string }): Promise<unknown[]>;
  /** List aggregated dead-letter groups (collapsed by source + reason). */
  listAggregatedDeadLetters(): Promise<{ groups: AggregatedDeadLetter[] }>;
  /** Dismiss all dead letters matching a source + reason pair. */
  dismissDeadLetterGroup(source: string, reason: string): Promise<{ dismissed: number }>;
  /** List relay conversations (grouped request/response exchanges with human labels). */
  listRelayConversations(): Promise<{ conversations: RelayConversation[] }>;

  // --- Relay Convergence ---

  /** Send a message via Relay, returns receipt. Only available when Relay enabled. */
  sendMessageRelay(
    sessionId: string,
    content: string,
    options?: { clientId?: string; correlationId?: string; cwd?: string }
  ): Promise<{ messageId: string; traceId: string }>;
  /** Get full trace for a message. */
  getRelayTrace(messageId: string): Promise<{ traceId: string; spans: TraceSpan[] }>;
  /** Get aggregate delivery metrics. */
  getRelayDeliveryMetrics(): Promise<DeliveryMetrics>;

  // --- Relay Adapters ---

  /** List all relay adapters with their live status. */
  listRelayAdapters(): Promise<AdapterListItem[]>;
  /** Enable or disable a relay adapter by ID. */
  toggleRelayAdapter(id: string, enabled: boolean): Promise<{ ok: boolean }>;
  /** Retrieve the adapter catalog with available types and configured instances. */
  getAdapterCatalog(): Promise<CatalogEntry[]>;
  /** Add a new relay adapter instance. */
  addRelayAdapter(
    type: string,
    id: string,
    config: Record<string, unknown>
  ): Promise<{ ok: boolean }>;
  /** Remove a relay adapter by ID. */
  removeRelayAdapter(id: string): Promise<{ ok: boolean }>;
  /** Update the config for an existing relay adapter. */
  updateRelayAdapterConfig(id: string, config: Record<string, unknown>): Promise<{ ok: boolean }>;
  /** Test connectivity for an adapter type and config without registering it. */
  testRelayAdapterConnection(
    type: string,
    config: Record<string, unknown>
  ): Promise<{ ok: boolean; error?: string; botUsername?: string }>;
  /** Fetch adapter lifecycle events by adapter instance ID. */
  getAdapterEvents(adapterId: string, limit?: number): Promise<{ events: AdapterEvent[] }>;
  /** Get observed chats for an adapter (for chatId picker). */
  getObservedChats(adapterId: string): Promise<ObservedChat[]>;

  // --- Relay Bindings ---

  /** List all adapter-agent bindings. */
  getBindings(): Promise<AdapterBinding[]>;
  /** Create a new adapter-agent binding. */
  createBinding(input: CreateBindingRequest): Promise<AdapterBinding>;
  /** Delete an adapter-agent binding by ID. */
  deleteBinding(id: string): Promise<void>;
  /** Update an existing binding's mutable fields. */
  updateBinding(id: string, updates: UpdateBindingRequest): Promise<AdapterBinding>;
  /**
   * Send a synthetic test probe through a binding. The server short-circuits
   * before invoking the agent; no real messages are delivered to any platform.
   *
   * @param bindingId - The binding to test
   */
  testBinding(bindingId: string): Promise<BindingTestResult>;

  // --- Mesh Agent Discovery ---

  /** List registered agents with their project paths (lightweight, for onboarding). */
  listMeshAgentPaths(): Promise<{ agents: AgentPathEntry[] }>;
  /** Discover agent candidates by scanning filesystem roots. */
  discoverMeshAgents(
    roots: string[],
    maxDepth?: number
  ): Promise<{ candidates: DiscoveryCandidate[] }>;
  /** List registered mesh agents with optional filters. */
  listMeshAgents(filters?: {
    runtime?: string;
    capability?: string;
  }): Promise<{ agents: AgentManifest[] }>;
  /** Get a single mesh agent by ID. */
  getMeshAgent(id: string): Promise<AgentManifest>;
  /** Register a discovered agent into the mesh registry. */
  registerMeshAgent(
    path: string,
    overrides?: Partial<AgentManifest>,
    approver?: string
  ): Promise<AgentManifest>;
  /** Update an existing mesh agent's metadata. */
  updateMeshAgent(id: string, updates: Partial<AgentManifest>): Promise<AgentManifest>;
  /** Unregister a mesh agent by ID. */
  unregisterMeshAgent(id: string): Promise<{ success: boolean }>;
  /** Delete an agent and its `.dork` directory by ID. */
  deleteAgentData(id: string): Promise<{ success: boolean; deletedPath: string }>;
  /** Deny a discovered agent path, preventing future registration. */
  denyMeshAgent(path: string, reason?: string, denier?: string): Promise<{ success: boolean }>;
  /** List all denied agent paths. */
  listDeniedMeshAgents(): Promise<{ denied: DenialRecord[] }>;
  /** Clear a denial record for a previously denied path. */
  clearMeshDenial(path: string): Promise<{ success: boolean }>;

  // --- Mesh Observability ---

  /** Get aggregate mesh health status. */
  getMeshStatus(): Promise<MeshStatus>;
  /** Get health details for a single agent. */
  getMeshAgentHealth(id: string): Promise<AgentHealth>;
  /** Send a heartbeat for an agent to update its last-seen timestamp. */
  sendMeshHeartbeat(id: string, event?: string): Promise<{ success: boolean }>;

  // --- Mesh Topology ---

  /** Get the mesh topology view, optionally scoped to a namespace. */
  getMeshTopology(namespace?: string): Promise<TopologyView>;
  /** Create or update a cross-namespace access rule. */
  updateMeshAccessRule(body: UpdateAccessRuleRequest): Promise<CrossNamespaceRule>;
  /** Get reachable agents for a specific agent. */
  getMeshAgentAccess(agentId: string): Promise<{ agents: AgentManifest[] }>;

  // --- Agent Identity (always available, no feature flag) ---

  /** Get the agent manifest for a working directory. Returns null if no agent registered. */
  getAgentByPath(path: string): Promise<AgentManifest | null>;
  /** Batch resolve agents for multiple paths. Returns a map of path -> manifest|null. */
  resolveAgents(paths: string[]): Promise<Record<string, AgentManifest | null>>;
  /** Initialize an agent at the given path (write config to existing directory). Returns the created manifest. */
  initAgent(
    path: string,
    name?: string,
    description?: string,
    runtime?: string
  ): Promise<AgentManifest>;
  /** Update an agent's fields by path. Returns the updated manifest. */
  updateAgentByPath(path: string, updates: Partial<AgentManifest>): Promise<AgentManifest>;
  /** Create a new agent: mkdir + scaffold files + register. Returns the created manifest and resolved path. */
  createAgent(opts: CreateAgentOptions): Promise<AgentManifest & { _path: string }>;

  // --- Discovery ---

  /**
   * Stream discovery scan results progressively via SSE.
   *
   * @param options - Scan roots, depth, and timeout options
   * @param onEvent - Callback invoked for each streamed scan event
   * @param signal - Optional AbortSignal to cancel the scan
   */
  scan(
    options: TransportScanOptions,
    onEvent: (event: TransportScanEvent) => void,
    signal?: AbortSignal
  ): Promise<void>;

  // --- File Uploads ---

  /**
   * Upload files to the session's working directory for agent access.
   *
   * Files are stored in `{cwd}/.dork/.temp/uploads/` with sanitized filenames.
   * The returned `savedPath` values can be injected into message text so the
   * resolved runtime reads them with its existing filesystem tools.
   *
   * @param files - Files to upload (browser File objects or UploadFile-compatible objects)
   * @param cwd - Working directory where files will be stored
   * @param onProgress - Optional callback for upload progress (useful for remote/tunnel uploads)
   */
  uploadFiles(
    files: UploadFile[],
    cwd: string,
    onProgress?: (progress: UploadProgress) => void
  ): Promise<UploadResult[]>;

  // --- Directory Operations ---

  /** Create a new directory within the boundary. Used by DirectoryPicker "New Folder". */
  createDirectory(parentPath: string, folderName: string): Promise<{ path: string }>;

  // --- Admin Operations ---

  /**
   * List the MCP servers visible to a runtime for a project directory.
   *
   * Resolves the runtime (explicit `opts.runtime`, else the server default) and
   * returns ITS servers: the runtime's live `getMcpStatus`, or — for the
   * `claude-code` runtime only — a fallback read of `<projectPath>/.mcp.json`.
   * A non-Claude runtime with no live status returns an empty list rather than
   * reading that Claude-format file (an honest "no MCP servers").
   *
   * @param projectPath - Absolute project directory to resolve MCP config for.
   * @param opts - Optional context; `runtime` selects a specific runtime by type
   *   (e.g. a Codex session must not inherit a Claude session's cwd cache).
   */
  getMcpConfig(projectPath: string, opts?: { runtime?: string }): Promise<McpConfigResponse>;

  /**
   * Obtain a Claude-specific plugin sub-transport for a session.
   *
   * Returns a `ClaudePluginTransport` bound to `sessionId`. Callers MUST
   * pre-gate on the session runtime's `capabilities.supportsPlugins`
   * (resolve the runtime from the session row, then look it up in the static
   * capabilities map — e.g. `useCapabilitiesForRuntime(useSessionRuntime(id))`)
   * before invoking `reloadPlugins` — this method is the lazy handle, not the
   * capability gate.
   *
   * Implementations differ:
   * - `HttpTransport` cannot synchronously resolve capabilities, so it always
   *   returns a concrete handle. Invocations against non-Claude runtimes are
   *   rejected by the server route (501).
   * - `DirectTransport` has synchronous access to the embedded runtime's
   *   capabilities and returns `null` as a secondary guard when plugins are
   *   unsupported. This null-return is a defense-in-depth optimization, NOT
   *   the primary capability gate.
   *
   * Either way: callers must check `supportsPlugins` at the UI layer first.
   *
   * @param sessionId - Session whose runtime owns the sub-transport handle.
   */
  asClaudePluginTransport(sessionId: string): ClaudePluginTransport | null;

  /** Initiate a factory reset: delete all DorkOS data and restart the server. */
  resetAllData(confirm: string): Promise<{ message: string }>;
  /** Initiate a graceful server restart. */
  restartServer(): Promise<{ message: string }>;

  // --- Activity Feed ---

  /** List activity events with optional filters and cursor-based pagination. */
  listActivityEvents(query?: Partial<ListActivityQuery>): Promise<ListActivityResponse>;

  // --- Templates ---

  /** Fetch the merged template catalog (builtin + user templates). */
  getTemplates(): Promise<TemplateEntry[]>;

  // --- Default Agent ---

  /** Set the default agent by name. Updates config.agents.defaultAgent. */
  setDefaultAgent(agentName: string): Promise<void>;

  // --- Marketplace ---

  /**
   * List packages from all enabled marketplace sources, with optional filtering.
   *
   * @param filter - Optional filter by type, marketplace source, or free-text query.
   */
  listMarketplacePackages(filter?: PackageFilter): Promise<AggregatedPackage[]>;

  /**
   * Fetch and validate a single package entry by name, returning its manifest
   * and a permission preview.
   *
   * @param name - Package name (e.g. `@org/my-plugin`). Will be URL-encoded.
   * @param marketplace - Restrict lookup to a specific marketplace source name.
   */
  getMarketplacePackage(name: string, marketplace?: string): Promise<MarketplacePackageDetail>;

  /**
   * Build a permission preview for a package without installing it.
   *
   * @param name - Package name. Will be URL-encoded.
   * @param opts - Optional install options (marketplace, source, projectPath).
   */
  previewMarketplacePackage(name: string, opts?: InstallOptions): Promise<MarketplacePackageDetail>;

  /**
   * Install a marketplace package.
   *
   * @param name - Package name. Will be URL-encoded.
   * @param opts - Install options (force, yes, marketplace, source, projectPath).
   */
  installMarketplacePackage(name: string, opts?: InstallOptions): Promise<InstallResult>;

  /**
   * Uninstall a marketplace package.
   *
   * @param name - Package name. Will be URL-encoded.
   * @param opts - Uninstall options (purge, projectPath).
   */
  uninstallMarketplacePackage(name: string, opts?: UninstallOptions): Promise<UninstallResult>;

  /**
   * Check for (and optionally apply) updates to a marketplace package.
   *
   * Advisory by default — pass `{ apply: true }` to reinstall in place.
   *
   * @param name - Package name. Will be URL-encoded.
   * @param opts - Update options (apply, projectPath).
   */
  updateMarketplacePackage(name: string, opts?: UpdateOptions): Promise<UpdateResult>;

  /**
   * List installed marketplace packages.
   *
   * Without `projectPath`: one entry per installation across ALL scopes — the
   * global roots plus every registered agent's local installs, each tagged
   * with scope and agent identity. With `projectPath`: the merged view for
   * that single project (one entry per name), used for scope-accurate
   * reinstall detection in the install dialog.
   *
   * @param projectPath - Optional agent project path for the merged view.
   */
  listInstalledPackages(projectPath?: string): Promise<InstalledPackage[]>;

  /**
   * List every installation of a single package across all scopes (global +
   * each agent), each enriched with its capability summary (`provides`:
   * command/skill counts + hooks). Used by the package detail drawer to
   * render the installations panel. Rejects with a 404 error when the package
   * is not installed anywhere.
   *
   * @param name - Installed package name.
   */
  listPackageInstallations(name: string): Promise<InstalledPackage[]>;

  /** List all configured marketplace sources. */
  listMarketplaceSources(): Promise<MarketplaceSource[]>;

  /**
   * Add a new marketplace source.
   *
   * @param input - Source name, URL, and optional enabled flag.
   */
  addMarketplaceSource(input: AddSourceInput): Promise<MarketplaceSource>;

  /**
   * Remove a configured marketplace source by name.
   *
   * @param name - Source name. Will be URL-encoded.
   */
  removeMarketplaceSource(name: string): Promise<void>;

  // --- DorkOS account link (accounts-and-auth P2) ---

  /**
   * Begin device-linking this instance to a DorkOS account. Returns the codes to
   * display to the user; the outcome arrives by polling {@link getCloudLinkStatus}.
   * Rejects (HTTP 502) when the cloud is unreachable.
   */
  startCloudLink(): Promise<StartLinkResult>;
  /**
   * Read the live link-flow state machine. Polled after {@link startCloudLink}
   * while the flow transitions from `pending` to a terminal state.
   */
  getCloudLinkStatus(): Promise<CloudLinkStatus>;
  /** Unlink this instance from its DorkOS account (best-effort server-side revoke). */
  unlinkCloud(): Promise<{ ok: boolean }>;
  /** Read the settled linked/unlinked summary for the Settings panel's initial render. */
  getCloudStatus(): Promise<CloudLinkSummary>;
}
