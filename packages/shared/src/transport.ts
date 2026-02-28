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
  ModelOption,
  FileListResponse,
  GitStatusResponse,
  GitStatusError,
  PulseSchedule,
  PulseRun,
  CreateScheduleInput,
  UpdateScheduleRequest,
  ListRunsQuery,
} from './types.js';
import type { AdapterConfigZ, AdapterStatusZ, TraceSpan, DeliveryMetrics, CatalogEntry, RelayConversation, AdapterBinding, CreateBindingRequest } from './relay-schemas.js';
import type {
  AgentManifest,
  DiscoveryCandidate,
  DenialRecord,
  AgentHealth,
  MeshStatus,
  TopologyView,
  UpdateAccessRuleRequest,
  CrossNamespaceRule,
} from './mesh-schemas.js';

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
  /** List available Claude models (dynamic from SDK, with defaults). */
  getModels(): Promise<ModelOption[]>;
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
  /** List dead-letter messages with optional filters. */
  listRelayDeadLetters(filters?: { endpointHash?: string }): Promise<unknown[]>;
  /** List relay conversations (grouped request/response exchanges with human labels). */
  listRelayConversations(): Promise<{ conversations: RelayConversation[] }>;

  // --- Relay Convergence ---

  /** Send a message via Relay, returns receipt. Only available when Relay enabled. */
  sendMessageRelay(
    sessionId: string,
    content: string,
    options?: { clientId?: string }
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
  addRelayAdapter(type: string, id: string, config: Record<string, unknown>): Promise<{ ok: boolean }>;
  /** Remove a relay adapter by ID. */
  removeRelayAdapter(id: string): Promise<{ ok: boolean }>;
  /** Update the config for an existing relay adapter. */
  updateRelayAdapterConfig(id: string, config: Record<string, unknown>): Promise<{ ok: boolean }>;
  /** Test connectivity for an adapter type and config without registering it. */
  testRelayAdapterConnection(type: string, config: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;

  // --- Relay Bindings ---

  /** List all adapter-agent bindings. */
  getBindings(): Promise<AdapterBinding[]>;
  /** Create a new adapter-agent binding. */
  createBinding(input: CreateBindingRequest): Promise<AdapterBinding>;
  /** Delete an adapter-agent binding by ID. */
  deleteBinding(id: string): Promise<void>;

  // --- Mesh Agent Discovery ---

  /** Discover agent candidates by scanning filesystem roots. */
  discoverMeshAgents(roots: string[], maxDepth?: number): Promise<{ candidates: DiscoveryCandidate[] }>;
  /** List registered mesh agents with optional filters. */
  listMeshAgents(filters?: { runtime?: string; capability?: string }): Promise<{ agents: AgentManifest[] }>;
  /** Get a single mesh agent by ID. */
  getMeshAgent(id: string): Promise<AgentManifest>;
  /** Register a discovered agent into the mesh registry. */
  registerMeshAgent(path: string, overrides?: Partial<AgentManifest>, approver?: string): Promise<AgentManifest>;
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
  /** Create a new agent at the given path. Returns the created manifest. */
  createAgent(path: string, name?: string, description?: string, runtime?: string): Promise<AgentManifest>;
  /** Update an agent's fields by path. Returns the updated manifest. */
  updateAgentByPath(path: string, updates: Partial<AgentManifest>): Promise<AgentManifest>;
}
