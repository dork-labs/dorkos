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
  UpdateSessionRequest,
  BrowseDirectoryResponse,
  CommandRegistry,
  HealthResponse,
  HistoryMessage,
  StreamEvent,
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
  AdapterConfig,
  AdapterStatus,
  TraceSpan,
  DeliveryMetrics,
  CatalogEntry,
  RelayConversation,
  AdapterBinding,
  CreateBindingRequest,
  ObservedChat,
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
import type { TemplateEntry } from './template-catalog.js';
import type { UiState } from './types.js';
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

/** A single MCP server entry — from `.mcp.json` (config only) or SDK (with live status). */
export interface McpServerEntry {
  name: string;
  type: 'stdio' | 'sse' | 'http';
  /** Live connection status reported by the Claude Agent SDK after a session runs. */
  status?: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  /** Error message populated when status === 'failed'. */
  error?: string;
  /** Config scope: 'project' | 'user' | 'local' | 'claudeai' | 'managed'. */
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

export interface Transport {
  /** Optional client identifier for SSE presence tracking. */
  readonly clientId?: string;
  /** List all sessions, optionally scoped to a working directory. */
  listSessions(cwd?: string): Promise<Session[]>;
  /** Get metadata for a single session by ID. */
  getSession(id: string, cwd?: string): Promise<Session>;
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
   * Send a message and stream the response via SSE.
   *
   * @param sessionId - Target session UUID
   * @param content - User message text
   * @param onEvent - Callback invoked for each streamed event
   * @param signal - Optional AbortSignal to cancel the request
   * @param cwd - Optional working directory override
   * @param options - Optional additional parameters (clientMessageId for server-echo ID, uiState for agent awareness)
   */
  sendMessage(
    sessionId: string,
    content: string,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal,
    cwd?: string,
    options?: { clientMessageId?: string; uiState?: UiState }
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
  /** Partially update the persisted user config. */
  updateConfig(patch: Record<string, unknown>): Promise<void>;
  /** List available Claude models (dynamic from SDK, with defaults). */
  getModels(): Promise<ModelOption[]>;
  /** List available subagents reported by the SDK. */
  getSubagents(): Promise<SubagentInfo[]>;
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
  /** Start the ngrok tunnel and return the public URL. */
  startTunnel(): Promise<{ url: string }>;
  /** Stop the ngrok tunnel. */
  stopTunnel(): Promise<void>;
  /** Verify a 6-digit passcode for remote tunnel access. */
  verifyTunnelPasscode(
    passcode: string
  ): Promise<{ ok: boolean; error?: string; retryAfter?: number }>;
  /** Check if the current session is authenticated for tunnel access. */
  checkTunnelSession(): Promise<{ authenticated: boolean; passcodeRequired: boolean }>;
  /**
   * Set, update, or disable the tunnel passcode (localhost-only endpoint).
   *
   * @param opts - Pass `{ passcode, enabled: true }` to set a 6-digit PIN, or `{ enabled: false }` to disable.
   */
  setTunnelPasscode(opts: { passcode?: string; enabled: boolean }): Promise<{ ok: boolean }>;

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
  updateBinding(
    id: string,
    updates: Partial<
      Pick<
        AdapterBinding,
        | 'sessionStrategy'
        | 'label'
        | 'chatId'
        | 'channelType'
        | 'canInitiate'
        | 'canReply'
        | 'canReceive'
      >
    >
  ): Promise<AdapterBinding>;

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
  /** Create a new agent: mkdir + scaffold files + register. Returns the created manifest. */
  createAgent(opts: CreateAgentOptions): Promise<AgentManifest>;

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
   * Claude Code agent reads them with its existing filesystem tools.
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

  /** Read MCP server entries from `.mcp.json` in the given project directory. */
  getMcpConfig(projectPath: string): Promise<McpConfigResponse>;

  /** Reload plugins for a session and return refreshed status. */
  reloadPlugins(sessionId: string, cwd?: string): Promise<import('./types.js').ReloadPluginsResult>;

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

  // --- External MCP Access ---

  /** Generate a new MCP API key and persist it to config. Returns the key in plaintext (one-time reveal). */
  generateMcpApiKey(): Promise<{ apiKey: string }>;

  /** Remove the config-stored MCP API key. Does not affect the MCP_API_KEY environment variable. */
  deleteMcpApiKey(): Promise<{ success: boolean }>;

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

  /** List all installed marketplace packages from the DorkOS data directory. */
  listInstalledPackages(): Promise<InstalledPackage[]>;

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
}
