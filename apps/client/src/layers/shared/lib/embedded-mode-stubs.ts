/**
 * Embedded mode stub methods for subsystems not supported in the Obsidian plugin.
 *
 * Tasks, Relay, Mesh observability, and related features are server-only.
 * These stubs return empty arrays for list operations and throw descriptive
 * errors for write/mutation operations.
 *
 * @module shared/lib/embedded-mode-stubs
 */
import type {
  AdapterListItem,
  AdapterEvent,
  McpConfigResponse,
  RuntimeProvisionProgress,
  RuntimeProvisionResult,
} from '@dorkos/shared/transport';
import type { RecentSessionsResponse } from '@dorkos/shared/types';
import type {
  ApprovalDecisionResponse,
  PendingApprovalsResponse,
  RevokeStandingPermissionResponse,
  StandingPermissionsResponse,
} from '@dorkos/shared/approval-schemas';
import type {
  StoreCredentialResult,
  DelegatedLoginResult,
  OpenRouterKeyResult,
  OpenRouterOAuthStart,
  OpenRouterOAuthStatus,
  OllamaStatus,
  OllamaModelCatalog,
  OllamaPullProgress,
  OllamaPullResult,
  OllamaProvisionResult,
} from '@dorkos/shared/runtime-connect';
import type {
  AddRoomMemberRequest,
  CreateRoomRequest,
  ListRoomEntriesQuery,
  ListRoomsQuery,
  PostThreadReplyRequest,
  PostToRoomRequest,
  PostToRoomResponse,
  RoomEntry,
  RoomEvent,
  RoomMember,
  RoomRosterEntry,
  RoomSummary,
  RoomWithRoster,
  ToggleReactionRequest,
  ToggleReactionResponse,
  UpdateMembershipRequest,
  UpdateRoomRequest,
} from '@dorkos/shared/room-schemas';
import type {
  Workspace,
  WorkspaceWithSessions,
  EnsureWorkspaceRequest,
  RemoveResult,
} from '@dorkos/shared/workspace';
import type {
  ConnectorAccountsResponse,
  ConnectorConnectPollResponse,
  ConnectorConnectStartResponse,
  ConnectorProviderStatus,
  ConnectorRecommendationsResponse,
  ConnectorToolkitsResponse,
  SessionConnectorAttachResult,
  SessionConnectorStatus,
} from '@dorkos/shared/connector-provider';
import type {
  TraceSpan,
  DeliveryMetrics,
  CatalogEntry,
  AdapterBinding,
  CreateBindingRequest,
  UpdateBindingRequest,
  BindingTestResult,
} from '@dorkos/shared/relay-schemas';
import type {
  AgentManifest,
  CreateAgentOptions,
  DiscoveryCandidate,
  DenialRecord,
  AgentHealth,
  MeshStatus,
  TopologyView,
  CrossNamespaceRule,
  UpdateAccessRuleRequest,
  TransportScanOptions,
  TransportScanEvent,
} from '@dorkos/shared/mesh-schemas';
import type {
  Task,
  TaskRun,
  CreateTaskInput,
  UpdateTaskRequest,
  ListTaskRunsQuery,
  TaskTemplate,
} from '@dorkos/shared/types';
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
  InstalledShapeSummary,
  ApplyShapeResult,
  ForkShapeResult,
} from '@dorkos/shared/marketplace-schemas';
import type {
  CloudLinkStatus,
  CloudLinkSummary,
  StartLinkResult,
} from '@dorkos/shared/cloud-schemas';
import type {
  ForkShapeRequest,
  McpAppResourceRequest,
  McpAppResourceResponse,
} from '@dorkos/shared/schemas';

// ---------------------------------------------------------------------------
// Tasks scheduler stubs
// ---------------------------------------------------------------------------

/** @internal */
export const tasksStubs = {
  async listTasks(): Promise<Task[]> {
    return [];
  },

  async createTask(_opts: CreateTaskInput): Promise<Task> {
    throw new Error('Tasks scheduler is not supported in embedded mode');
  },

  async updateTask(_id: string, _opts: UpdateTaskRequest): Promise<Task> {
    throw new Error('Tasks scheduler is not supported in embedded mode');
  },

  async deleteTask(_id: string): Promise<{ success: boolean }> {
    throw new Error('Tasks scheduler is not supported in embedded mode');
  },

  async triggerTask(_id: string): Promise<{ runId: string }> {
    throw new Error('Tasks scheduler is not supported in embedded mode');
  },

  async listTaskRuns(_opts?: Partial<ListTaskRunsQuery>): Promise<TaskRun[]> {
    return [];
  },

  async getTaskRun(_id: string): Promise<TaskRun> {
    throw new Error('Tasks scheduler is not supported in embedded mode');
  },

  async cancelTaskRun(_id: string): Promise<{ success: boolean }> {
    throw new Error('Tasks scheduler is not supported in embedded mode');
  },

  async getTaskTemplates(): Promise<TaskTemplate[]> {
    return [];
  },
};

// ---------------------------------------------------------------------------
// Relay message bus stubs
// ---------------------------------------------------------------------------

/** @internal */
export const relayStubs = {
  async listRelayMessages(): Promise<{ messages: unknown[]; nextCursor?: string }> {
    return { messages: [] };
  },

  async getRelayMessage(_id: string): Promise<unknown> {
    throw new Error('Relay is not supported in embedded mode');
  },

  async sendRelayMessage(): Promise<{ messageId: string; deliveredTo: number }> {
    throw new Error('Relay is not supported in embedded mode');
  },

  async listRelayEndpoints(): Promise<unknown[]> {
    return [];
  },

  async registerRelayEndpoint(): Promise<unknown> {
    throw new Error('Relay is not supported in embedded mode');
  },

  async unregisterRelayEndpoint(): Promise<{ success: boolean }> {
    throw new Error('Relay is not supported in embedded mode');
  },

  async readRelayInbox(): Promise<{ messages: unknown[]; nextCursor?: string }> {
    return { messages: [] };
  },

  async getRelayMetrics(): Promise<unknown> {
    return { totalMessages: 0, byStatus: {}, bySubject: [] };
  },

  async listRelayDeadLetters(_filters?: { endpointHash?: string }): Promise<unknown[]> {
    return [];
  },

  async listAggregatedDeadLetters(): Promise<{ groups: never[] }> {
    return { groups: [] };
  },

  async dismissDeadLetterGroup(_source: string, _reason: string): Promise<{ dismissed: number }> {
    return { dismissed: 0 };
  },

  async listRelayConversations(): Promise<{ conversations: never[] }> {
    return { conversations: [] };
  },

  async sendMessageRelay(
    _sessionId: string,
    _content: string,
    _options?: { clientId?: string; correlationId?: string; cwd?: string }
  ): Promise<{ messageId: string; traceId: string }> {
    throw new Error('Relay is not supported in embedded mode');
  },

  async getRelayTrace(_messageId: string): Promise<{ traceId: string; spans: TraceSpan[] }> {
    throw new Error('Relay is not supported in embedded mode');
  },

  async getRelayDeliveryMetrics(): Promise<DeliveryMetrics> {
    throw new Error('Relay is not supported in embedded mode');
  },
};

// ---------------------------------------------------------------------------
// Relay adapter stubs
// ---------------------------------------------------------------------------

/** @internal */
export const adapterStubs = {
  async listRelayAdapters(): Promise<AdapterListItem[]> {
    return [];
  },

  async toggleRelayAdapter(_id: string, _enabled: boolean): Promise<{ ok: boolean }> {
    throw new Error('Relay adapters are not supported in embedded mode');
  },

  async getAdapterCatalog(): Promise<CatalogEntry[]> {
    return [];
  },

  async addRelayAdapter(
    _type: string,
    _id: string,
    _config: Record<string, unknown>
  ): Promise<{ ok: boolean }> {
    throw new Error('Adapter management not supported in embedded mode');
  },

  async removeRelayAdapter(_id: string): Promise<{ ok: boolean }> {
    throw new Error('Adapter management not supported in embedded mode');
  },

  async updateRelayAdapterConfig(
    _id: string,
    _config: Record<string, unknown>
  ): Promise<{ ok: boolean }> {
    throw new Error('Adapter management not supported in embedded mode');
  },

  async testRelayAdapterConnection(
    _type: string,
    _config: Record<string, unknown>
  ): Promise<{ ok: boolean; error?: string }> {
    throw new Error('Adapter management not supported in embedded mode');
  },

  async getAdapterEvents(_adapterId: string, _limit?: number): Promise<{ events: AdapterEvent[] }> {
    return { events: [] };
  },

  async getObservedChats(_adapterId: string): Promise<[]> {
    return [];
  },
};

// ---------------------------------------------------------------------------
// Relay binding stubs
// ---------------------------------------------------------------------------

/** @internal */
export const bindingStubs = {
  async getBindings(): Promise<AdapterBinding[]> {
    return [];
  },

  async createBinding(_input: CreateBindingRequest): Promise<AdapterBinding> {
    throw new Error('Relay bindings are not supported in embedded mode');
  },

  async deleteBinding(_id: string): Promise<void> {
    throw new Error('Relay bindings are not supported in embedded mode');
  },

  async updateBinding(_id: string, _updates: UpdateBindingRequest): Promise<AdapterBinding> {
    throw new Error('Relay bindings are not supported in embedded mode');
  },

  async testBinding(_bindingId: string): Promise<BindingTestResult> {
    throw new Error('Relay bindings are not supported in embedded mode');
  },
};

// ---------------------------------------------------------------------------
// Mesh stubs
// ---------------------------------------------------------------------------

/** @internal */
export const meshStubs = {
  async listMeshAgentPaths(): Promise<{ agents: never[] }> {
    return { agents: [] };
  },

  async discoverMeshAgents(
    _roots: string[],
    _maxDepth?: number
  ): Promise<{ candidates: DiscoveryCandidate[] }> {
    throw new Error('Mesh is not supported in embedded mode');
  },

  async listMeshAgents(_filters?: {
    runtime?: string;
    capability?: string;
  }): Promise<{ agents: AgentManifest[] }> {
    return { agents: [] };
  },

  async getMeshAgent(_id: string): Promise<AgentManifest> {
    throw new Error('Mesh is not supported in embedded mode');
  },

  async registerMeshAgent(
    _path: string,
    _overrides?: Partial<AgentManifest>,
    _approver?: string,
    _scanRoot?: string
  ): Promise<AgentManifest> {
    throw new Error('Mesh is not supported in embedded mode');
  },

  async updateMeshAgent(_id: string, _updates: Partial<AgentManifest>): Promise<AgentManifest> {
    throw new Error('Mesh is not supported in embedded mode');
  },

  async unregisterMeshAgent(_id: string): Promise<{ success: boolean }> {
    throw new Error('Mesh is not supported in embedded mode');
  },

  async deleteAgentData(_id: string): Promise<{ success: boolean; deletedPath: string }> {
    throw new Error('Mesh is not supported in embedded mode');
  },

  async denyMeshAgent(
    _path: string,
    _reason?: string,
    _denier?: string
  ): Promise<{ success: boolean }> {
    throw new Error('Mesh is not supported in embedded mode');
  },

  async listDeniedMeshAgents(): Promise<{ denied: DenialRecord[] }> {
    return { denied: [] };
  },

  async clearMeshDenial(_path: string): Promise<{ success: boolean }> {
    throw new Error('Mesh is not supported in embedded mode');
  },

  async getMeshStatus(): Promise<MeshStatus> {
    throw new Error('Mesh is not supported in embedded mode');
  },

  async getMeshAgentHealth(_id: string): Promise<AgentHealth> {
    throw new Error('Mesh is not supported in embedded mode');
  },

  async sendMeshHeartbeat(_id: string, _event?: string): Promise<{ success: boolean }> {
    throw new Error('Mesh is not supported in embedded mode');
  },

  async getMeshTopology(_namespace?: string): Promise<TopologyView> {
    throw new Error('Mesh is not supported in embedded mode');
  },

  async updateMeshAccessRule(_body: UpdateAccessRuleRequest): Promise<CrossNamespaceRule> {
    throw new Error('Mesh is not supported in embedded mode');
  },

  async getMeshAgentAccess(_agentId: string): Promise<{ agents: AgentManifest[] }> {
    throw new Error('Mesh is not supported in embedded mode');
  },
};

// ---------------------------------------------------------------------------
// Approval stubs
// ---------------------------------------------------------------------------

/**
 * Embedded mode has no agent-facing HTTP surface, so nothing there can request
 * an approval and there is never anything to decide.
 *
 * @internal
 */
export const approvalStubs = {
  async listPendingApprovals(): Promise<PendingApprovalsResponse> {
    return { approvals: [] };
  },

  async grantApproval(
    _approvalId: string,
    _options?: { standing?: boolean }
  ): Promise<ApprovalDecisionResponse> {
    throw new Error('Approvals are not supported in Obsidian plugin mode.');
  },

  async denyApproval(_approvalId: string, _reason?: string): Promise<ApprovalDecisionResponse> {
    throw new Error('Approvals are not supported in Obsidian plugin mode.');
  },

  async listStandingPermissions(): Promise<StandingPermissionsResponse> {
    return { grants: [] };
  },

  async revokeStandingPermission(_grantId: string): Promise<RevokeStandingPermissionResponse> {
    throw new Error('Approvals are not supported in Obsidian plugin mode.');
  },
};

// ---------------------------------------------------------------------------
// Activity feed stubs
// ---------------------------------------------------------------------------

/** @internal */
export const activityStubs = {
  async listActivityEvents(): Promise<{ items: never[]; nextCursor: null }> {
    return { items: [], nextCursor: null };
  },
};

// ---------------------------------------------------------------------------
// Miscellaneous server-only stubs
// ---------------------------------------------------------------------------

/** @internal */
export const serverOnlyStubs = {
  async listRecentSessions(_limit?: number): Promise<RecentSessionsResponse> {
    // Embedded mode has no multi-agent roster — the cross-agent Recent section
    // does not apply, so this returns an empty envelope.
    return { sessions: [], agentActivity: {}, warnings: [] };
  },

  async startTunnel(): Promise<{ url: string }> {
    return { url: '' };
  },

  async stopTunnel(): Promise<void> {
    // No-op in embedded mode
  },

  async updateConfig(_patch: Record<string, unknown>): Promise<void> {
    // No-op in embedded mode — config is not persisted via DirectTransport.
  },

  async rotateMcpLocalToken(): Promise<{ localToken: string }> {
    // The local MCP token gates the HTTP /mcp surface, which the embedded
    // in-process transport never exposes — there is nothing to rotate here.
    throw new Error('Rotating the local MCP token is not supported in Obsidian plugin mode.');
  },

  async revealMcpLocalToken(): Promise<{ localToken: string }> {
    // Same reasoning as rotate: no HTTP /mcp surface exists in embedded mode,
    // so there is no local token to reveal.
    throw new Error('Revealing the local MCP token is not supported in Obsidian plugin mode.');
  },

  async getMcpConfig(
    _projectPath: string,
    _opts?: { runtime?: string }
  ): Promise<McpConfigResponse> {
    return { servers: [] };
  },

  async fetchMcpAppResource(
    _sessionId: string,
    _request: McpAppResourceRequest
  ): Promise<McpAppResourceResponse> {
    // MCP Apps (SEP-1865) rendering is a web-cockpit v1 surface; the embedded
    // in-process transport does not wire the short-lived MCP client yet.
    throw new Error('MCP Apps are not supported in Obsidian plugin mode.');
  },

  async resetAllData(_confirm: string): Promise<{ message: string }> {
    throw new Error('Reset and restart are not supported in Obsidian plugin mode.');
  },

  async restartServer(): Promise<{ message: string }> {
    throw new Error('Reset and restart are not supported in Obsidian plugin mode.');
  },

  async scan(
    _options: TransportScanOptions,
    _onEvent: (event: TransportScanEvent) => void,
    _signal?: AbortSignal
  ): Promise<void> {
    throw new Error('Discovery scan is not supported in Obsidian plugin mode.');
  },

  async provisionRuntime(
    _runtimeType: string,
    _onProgress?: (progress: RuntimeProvisionProgress) => void
  ): Promise<RuntimeProvisionResult> {
    // On-demand install spawns a package manager — a desktop-server concern, not
    // available in the in-process Obsidian embedding. Honest Connect/error state.
    return {
      ok: false,
      error: 'Installing a runtime is not supported in Obsidian plugin mode.',
    };
  },

  // Runtime connect actions spawn vendor CLIs, host a loopback OAuth callback, and
  // write to the encrypted credential store — all desktop-server concerns. The
  // in-process Obsidian embedding honestly declines them (connect from the app).

  async storeRuntimeCredential(_type: string, _secret: string): Promise<StoreCredentialResult> {
    throw new Error('Connecting a runtime is not supported in Obsidian plugin mode.');
  },

  async storeProviderCredential(
    _providerId: string,
    _secret: string,
    _baseURL?: string | null
  ): Promise<StoreCredentialResult> {
    throw new Error('Connecting a provider is not supported in Obsidian plugin mode.');
  },

  async delegateRuntimeLogin(_type: string): Promise<DelegatedLoginResult> {
    return { ok: false, error: 'Signing in is not supported in Obsidian plugin mode.' };
  },

  async storeOpenRouterKey(_key: string): Promise<OpenRouterKeyResult> {
    return { ok: false, error: 'Connecting OpenRouter is not supported in Obsidian plugin mode.' };
  },

  async startOpenRouterOAuth(): Promise<OpenRouterOAuthStart> {
    throw new Error('OpenRouter sign-in is not supported in Obsidian plugin mode.');
  },

  async getOpenRouterOAuthStatus(_state: string): Promise<OpenRouterOAuthStatus> {
    return {
      status: 'error',
      error: 'OpenRouter sign-in is not supported in Obsidian plugin mode.',
    };
  },

  async detectOllama(): Promise<OllamaStatus> {
    return { running: false, models: [] };
  },

  async getOllamaModelCatalog(): Promise<OllamaModelCatalog> {
    // The guided pull is a desktop-server concern (it detects local hardware and
    // triggers an Ollama download). The in-process Obsidian embedding has no
    // hardware/pull surface, so it honestly reports an empty catalog.
    return {
      hardware: { totalRamBytes: 0, vramBytes: null, unifiedMemory: false },
      models: [],
    };
  },

  async pullOllamaModel(
    model: string,
    _onProgress?: (progress: OllamaPullProgress) => void
  ): Promise<OllamaPullResult> {
    return {
      ok: false,
      model,
      error: 'Pulling an Ollama model is not supported in Obsidian plugin mode.',
    };
  },

  async provisionOllama(
    _onProgress?: (progress: RuntimeProvisionProgress) => void
  ): Promise<OllamaProvisionResult> {
    // Installing Ollama spawns a package manager — a desktop-server concern, not
    // available in the in-process Obsidian embedding. Honest Connect/error state.
    return {
      ok: false,
      installMethod: 'manual',
      error: 'Installing Ollama is not supported in Obsidian plugin mode.',
    };
  },

  async createAgent(_opts: CreateAgentOptions): Promise<AgentManifest & { _path: string }> {
    throw new Error('Agent creation is not supported in Obsidian plugin mode.');
  },

  async setDefaultAgent(_agentName: string): Promise<void> {
    // No-op in embedded mode — config is not persisted via DirectTransport.
  },
};

// ---------------------------------------------------------------------------
// Marketplace stubs
// ---------------------------------------------------------------------------

/** @internal */
export const marketplaceStubs = {
  async listMarketplacePackages(_filter?: PackageFilter): Promise<AggregatedPackage[]> {
    return [];
  },

  async getMarketplacePackage(
    _name: string,
    _marketplace?: string
  ): Promise<MarketplacePackageDetail> {
    throw new Error('Marketplace is not supported in embedded mode');
  },

  async previewMarketplacePackage(
    _name: string,
    _opts?: InstallOptions
  ): Promise<MarketplacePackageDetail> {
    throw new Error('Marketplace is not supported in embedded mode');
  },

  async installMarketplacePackage(_name: string, _opts?: InstallOptions): Promise<InstallResult> {
    throw new Error('Marketplace is not supported in embedded mode');
  },

  async uninstallMarketplacePackage(
    _name: string,
    _opts?: UninstallOptions
  ): Promise<UninstallResult> {
    throw new Error('Marketplace is not supported in embedded mode');
  },

  async updateMarketplacePackage(_name: string, _opts?: UpdateOptions): Promise<UpdateResult> {
    throw new Error('Marketplace is not supported in embedded mode');
  },

  async listInstalledPackages(_projectPath?: string): Promise<InstalledPackage[]> {
    return [];
  },

  async listPackageInstallations(_name: string): Promise<InstalledPackage[]> {
    throw new Error('Marketplace is not supported in embedded mode');
  },

  async listMarketplaceSources(): Promise<MarketplaceSource[]> {
    return [];
  },

  async addMarketplaceSource(_input: AddSourceInput): Promise<MarketplaceSource> {
    throw new Error('Marketplace is not supported in embedded mode');
  },

  async removeMarketplaceSource(_name: string): Promise<void> {
    throw new Error('Marketplace is not supported in embedded mode');
  },
};

/** Shapes (DOR-355) are a server-only marketplace concept — inert in embedded mode. */
export const shapeStubs = {
  async listShapes(): Promise<InstalledShapeSummary[]> {
    return [];
  },

  async applyShape(_name: string): Promise<ApplyShapeResult> {
    throw new Error('Shapes are not supported in embedded mode');
  },

  async forkShape(_name: string, _request?: ForkShapeRequest): Promise<ForkShapeResult> {
    throw new Error('Shapes are not supported in embedded mode');
  },
};

// ---------------------------------------------------------------------------
// Cloud-link stubs
// ---------------------------------------------------------------------------

/**
 * Cloud-link stubs — linking an instance to a DorkOS account is a server-owned
 * lifecycle (device flow, persisted instance token, heartbeats). It is not
 * meaningful in the in-process Obsidian transport, so reads report "not linked"
 * and the link/unlink mutations refuse.
 *
 * @internal
 */
export const cloudStubs = {
  async startCloudLink(): Promise<StartLinkResult> {
    throw new Error('Account linking is not supported in Obsidian plugin mode.');
  },

  async getCloudLinkStatus(): Promise<CloudLinkStatus> {
    return { state: 'idle' };
  },

  async unlinkCloud(): Promise<{ ok: boolean }> {
    throw new Error('Account linking is not supported in Obsidian plugin mode.');
  },

  async getCloudStatus(): Promise<CloudLinkSummary> {
    return { linked: false, accountLabel: null, lastHeartbeatAt: null };
  },
};

/**
 * Workspace stubs — the WorkspaceManager is a server-only subsystem (it shells
 * out to git and owns the data dir), so the in-process Obsidian transport reports
 * "no workspaces" and refuses mutations.
 */
export const workspaceStubs = {
  async listWorkspaces(_projectKey?: string): Promise<WorkspaceWithSessions[]> {
    return [];
  },

  async resolveWorkspace(_absPath: string): Promise<Workspace | null> {
    return null;
  },

  async ensureWorkspace(_req: EnsureWorkspaceRequest): Promise<Workspace> {
    throw new Error('Workspaces are not supported in embedded mode');
  },

  async pinWorkspace(_id: string, _pinned: boolean): Promise<Workspace> {
    throw new Error('Workspaces are not supported in embedded mode');
  },

  async removeWorkspace(_id: string, _force?: boolean): Promise<RemoveResult> {
    throw new Error('Workspaces are not supported in embedded mode');
  },
};

/**
 * Room stubs — rooms are a server-owned subsystem (five SQLite tables and a
 * durable per-room stream), and the Obsidian embed is deliberately out of scope
 * for them in v1 (spec `rooms` §9). Reads answer "no rooms" so the embed's
 * sidebar simply has nothing to show; writes refuse.
 */
export const roomStubs = {
  async listRooms(_query?: ListRoomsQuery): Promise<RoomSummary[]> {
    return [];
  },

  async createRoom(_req: CreateRoomRequest): Promise<RoomWithRoster> {
    throw new Error('Rooms are not supported in embedded mode');
  },

  async getRoom(_id: string): Promise<RoomWithRoster> {
    throw new Error('Rooms are not supported in embedded mode');
  },

  async updateRoom(_id: string, _req: UpdateRoomRequest): Promise<RoomWithRoster> {
    throw new Error('Rooms are not supported in embedded mode');
  },

  async listRoomEntries(_id: string, _query?: ListRoomEntriesQuery): Promise<RoomEntry[]> {
    return [];
  },

  async postToRoom(_id: string, _req: PostToRoomRequest): Promise<PostToRoomResponse> {
    throw new Error('Rooms are not supported in embedded mode');
  },

  async replyInThread(_id: string, _req: PostThreadReplyRequest): Promise<PostToRoomResponse> {
    throw new Error('Rooms are not supported in embedded mode');
  },

  async toggleReaction(
    _id: string,
    _entryId: string,
    _req: ToggleReactionRequest
  ): Promise<ToggleReactionResponse> {
    throw new Error('Rooms are not supported in embedded mode');
  },

  async addRoomMember(_id: string, _req: AddRoomMemberRequest): Promise<RoomRosterEntry> {
    throw new Error('Rooms are not supported in embedded mode');
  },

  async updateRoomMember(
    _id: string,
    _authorId: string,
    _req: UpdateMembershipRequest
  ): Promise<RoomRosterEntry> {
    throw new Error('Rooms are not supported in embedded mode');
  },

  async removeRoomMember(_id: string, _authorId: string): Promise<void> {
    throw new Error('Rooms are not supported in embedded mode');
  },

  async setRoomReadCursor(_id: string, _lastReadSeq: number): Promise<RoomMember> {
    throw new Error('Rooms are not supported in embedded mode');
  },

  subscribeRoom(
    _roomId: string,
    _sinceCursor?: number,
    _signal?: AbortSignal
  ): AsyncIterable<RoomEvent> {
    return emptyRoomEvents();
  },
};

/** An empty room stream — the embed has no rooms, so nothing ever arrives. */
// eslint-disable-next-line require-yield
async function* emptyRoomEvents(): AsyncIterable<RoomEvent> {}

/**
 * Connector stubs — the connector gateway (provider registry, credential
 * store, connect flows, session tool exposure) is a server-owned subsystem the
 * in-process embed has no services for (connector-completion spec OQ4). Reads
 * answer honestly empty, so the Connections surface renders its real empty
 * state; credential and connect writes refuse with a clear pointer at the web
 * cockpit — never a silent failure. Session attach reads answer "nothing
 * attached" for the same reason.
 */
export const connectorStubs = {
  async getConnectorProviders(): Promise<ConnectorProviderStatus[]> {
    return [];
  },

  async putConnectorCredential(
    _provider: string,
    _secret: string
  ): Promise<ConnectorProviderStatus> {
    throw new Error(EMBEDDED_CONNECTORS_NOTICE);
  },

  async deleteConnectorCredential(_provider: string): Promise<ConnectorProviderStatus> {
    throw new Error(EMBEDDED_CONNECTORS_NOTICE);
  },

  async getConnectorToolkits(): Promise<ConnectorToolkitsResponse> {
    return { toolkits: [], warnings: [] };
  },

  async getConnectorRecommendation(_service: string): Promise<ConnectorRecommendationsResponse> {
    return { recommendations: [], warnings: [] };
  },

  async startConnectorFlow(
    _provider: string,
    _request: { toolkit: string; label?: string }
  ): Promise<ConnectorConnectStartResponse> {
    throw new Error(EMBEDDED_CONNECTORS_NOTICE);
  },

  async pollConnectorFlow(_flowId: string): Promise<ConnectorConnectPollResponse> {
    throw new Error(EMBEDDED_CONNECTORS_NOTICE);
  },

  async getConnectorAccounts(_toolkit?: string): Promise<ConnectorAccountsResponse> {
    return { accounts: [], warnings: [] };
  },

  async disconnectConnectorAccount(_accountId: string): Promise<void> {
    throw new Error(EMBEDDED_CONNECTORS_NOTICE);
  },

  async getSessionConnectors(_sessionId: string): Promise<SessionConnectorStatus> {
    return { accounts: [], warnings: [] };
  },

  async attachSessionConnector(
    _sessionId: string,
    _accountId: string
  ): Promise<SessionConnectorAttachResult> {
    throw new Error(EMBEDDED_CONNECTORS_NOTICE);
  },

  async detachSessionConnector(_sessionId: string, _accountId: string): Promise<void> {
    throw new Error(EMBEDDED_CONNECTORS_NOTICE);
  },
};

/** The one honest notice every refused connector write carries (spec OQ4). */
const EMBEDDED_CONNECTORS_NOTICE =
  'Connections can only be managed from the web cockpit — open DorkOS in your browser to connect services.';
