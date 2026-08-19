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
  AddAgentMcpServerInput,
  ImportAgentMcpServerInput,
  UpdateAgentMcpServerInput,
  AgentMcpMutationResult,
  AgentMcpTestResult,
  StartMcpSigninResult,
  McpClientCredentials,
  McpSigninPollResult,
} from '@dorkos/shared/transport';
import type { RecentSessionsResponse, SessionDailyCountsResponse } from '@dorkos/shared/types';
import type { MemberRoomsResponse, TeamRosterResponse } from '@dorkos/shared/team-schemas';
import type { UnattendedAutonomyState } from '@dorkos/shared/permission-semantics';
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
  HaltRoomResponse,
  PromoteHoldResponse,
  ListRoomEntriesQuery,
  ListRoomsQuery,
  ListThreadsQuery,
  PostThreadReplyRequest,
  PostToRoomRequest,
  PostToRoomResponse,
  RoomAttachment,
  RoomEntry,
  RoomEvent,
  RoomMember,
  RoomSessionsResponse,
  AuthorRef,
  RoomRosterEntry,
  RoomSummary,
  RoomWithRoster,
  ThreadSummary,
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
  AgentConnectorAttachment,
  AgentConnectorAttachResult,
} from '@dorkos/shared/connector-provider';
import type {
  TraceSpan,
  DeliveryMetrics,
  CatalogEntry,
  AdapterBinding,
  CreateBindingRequest,
  UpdateBindingRequest,
  BindingTestResult,
  UnclaimedChat,
  UnclaimedChatStatus,
  ClaimUnclaimedChatRequest,
  ClaimUnclaimedChatResponse,
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
  ManagedMcpServer,
  ManagedMcpServerView,
} from '@dorkos/shared/mesh-schemas';
import type {
  Task,
  TaskRun,
  CreateTaskInput,
  UpdateTaskRequest,
  ListTaskRunsQuery,
  TaskTemplate,
  CancelTaskRunResponse,
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

  async cancelTaskRun(_id: string): Promise<CancelTaskRunResponse> {
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

  async moveBinding(_id: string, _agentId: string): Promise<AdapterBinding> {
    throw new Error('Relay bindings are not supported in embedded mode');
  },

  async listUnclaimedChats(_status?: UnclaimedChatStatus): Promise<UnclaimedChat[]> {
    return [];
  },

  async claimUnclaimedChat(
    _id: string,
    _input: ClaimUnclaimedChatRequest
  ): Promise<ClaimUnclaimedChatResponse> {
    throw new Error('Relay bindings are not supported in embedded mode');
  },

  async ignoreUnclaimedChat(_id: string): Promise<void> {
    throw new Error('Relay bindings are not supported in embedded mode');
  },

  async blockUnclaimedChat(_id: string): Promise<void> {
    throw new Error('Relay bindings are not supported in embedded mode');
  },

  async leaveUnclaimedChat(_id: string): Promise<void> {
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

  async getSessionDailyCounts(_days?: number): Promise<SessionDailyCountsResponse> {
    // No agent roster here either, so there is nothing machine-wide to count.
    // `days: 0` with no buckets says "no answer" — a week of zeros would say
    // "nothing ran", which is a claim the embed has not earned.
    return { days: 0, dailyCounts: [], warnings: [] };
  },

  async getUnattendedAutonomy(): Promise<UnattendedAutonomyState> {
    // The embed has neither relay bindings nor scheduled tasks, so no surface
    // here can be running unattended — the standing banner is correct to be
    // silent rather than merely unwired.
    return { drivers: [] };
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

  async listThreads(_query?: ListThreadsQuery): Promise<ThreadSummary[]> {
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

  async uploadRoomAttachments(): Promise<RoomAttachment[]> {
    throw new Error('Rooms are not supported in embedded mode');
  },

  async replyInThread(_id: string, _req: PostThreadReplyRequest): Promise<PostToRoomResponse> {
    throw new Error('Rooms are not supported in embedded mode');
  },

  async haltRoom(_id: string): Promise<HaltRoomResponse> {
    throw new Error('Rooms are not supported in embedded mode');
  },

  async haltRoomAgent(_id: string, _authorId: string): Promise<HaltRoomResponse> {
    throw new Error('Rooms are not supported in embedded mode');
  },

  async promoteHold(_id: string, _authorId: string): Promise<PromoteHoldResponse> {
    throw new Error('Rooms are not supported in embedded mode');
  },

  async listRoomSessions(_id: string): Promise<RoomSessionsResponse> {
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

  async setAuthorHandle(_authorId: string, _handle: string): Promise<AuthorRef> {
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

  async getAgentConnectors(_agentId: string): Promise<AgentConnectorAttachment[]> {
    return [];
  },

  async attachAgentConnector(
    _agentId: string,
    _accountId: string
  ): Promise<AgentConnectorAttachResult> {
    throw new Error(EMBEDDED_CONNECTORS_NOTICE);
  },

  async detachAgentConnector(_agentId: string, _accountId: string): Promise<void> {
    throw new Error(EMBEDDED_CONNECTORS_NOTICE);
  },
};

/** The one honest notice every refused connector write carries (spec OQ4). */
const EMBEDDED_CONNECTORS_NOTICE =
  'Connections can only be managed from the web cockpit — open DorkOS in your browser to connect services.';

/** The one honest notice every refused managed-MCP write carries. */
const EMBEDDED_MCP_NOTICE =
  'MCP servers can only be managed from the web cockpit — open DorkOS in your browser to add or change them.';

/**
 * Managed per-agent MCP servers (spec `mcp-server-management`). Server-only: the
 * capability registry and `AgentMcpServerService` that back these verbs live on
 * the server, so the embedded runtime reads honest-empty and refuses every
 * write with {@link EMBEDDED_MCP_NOTICE}.
 */
export const mcpManagementStubs = {
  async listAgentMcpServers(_agentId: string): Promise<ManagedMcpServerView[]> {
    return [];
  },

  async addAgentMcpServer(
    _input: AddAgentMcpServerInput,
    _opts?: { approvalToken?: string }
  ): Promise<AgentMcpMutationResult> {
    throw new Error(EMBEDDED_MCP_NOTICE);
  },

  async importAgentMcpServer(
    _input: ImportAgentMcpServerInput,
    _opts?: { approvalToken?: string }
  ): Promise<AgentMcpMutationResult> {
    throw new Error(EMBEDDED_MCP_NOTICE);
  },

  async updateAgentMcpServer(
    _input: UpdateAgentMcpServerInput,
    _opts?: { approvalToken?: string }
  ): Promise<AgentMcpMutationResult> {
    throw new Error(EMBEDDED_MCP_NOTICE);
  },

  async removeAgentMcpServer(_agentId: string, _name: string): Promise<ManagedMcpServer[]> {
    throw new Error(EMBEDDED_MCP_NOTICE);
  },

  async enableAgentMcpServer(_agentId: string, _name: string): Promise<ManagedMcpServer[]> {
    throw new Error(EMBEDDED_MCP_NOTICE);
  },

  async disableAgentMcpServer(_agentId: string, _name: string): Promise<ManagedMcpServer[]> {
    throw new Error(EMBEDDED_MCP_NOTICE);
  },

  async testAgentMcpServer(_agentId: string, _name: string): Promise<AgentMcpTestResult> {
    throw new Error(EMBEDDED_MCP_NOTICE);
  },

  async startMcpSignin(_agentId: string, _name: string): Promise<StartMcpSigninResult> {
    throw new Error(EMBEDDED_MCP_NOTICE);
  },

  async pollMcpSignin(_flowId: string): Promise<McpSigninPollResult> {
    throw new Error(EMBEDDED_MCP_NOTICE);
  },

  async setMcpClientCredentials(
    _agentId: string,
    _name: string,
    _credentials: McpClientCredentials
  ): Promise<void> {
    throw new Error(EMBEDDED_MCP_NOTICE);
  },
};

// ---------------------------------------------------------------------------
// Team roster (spec `identity-consistency` §W2.2)
// ---------------------------------------------------------------------------

/**
 * The team roster in embedded mode.
 *
 * The roster is a server-side aggregation over `authors` and the mesh registry,
 * and the Obsidian plugin runs beside neither. It answers in the endpoint's own
 * degraded shape rather than throwing or returning a bare `{ members: [] }`:
 * the page already knows how to say "a source did not answer", and an empty
 * roster with no explanation is the one thing the surface must never show —
 * it would read as "there is nobody here", which is never true.
 *
 * `message` is diagnostic, matching every other warning on this envelope
 * (`err.message` from whatever failed). The sentence a person reads is keyed
 * off `source` by the banner that draws it, which is the single owner of that
 * copy — see `SOURCE_COPY` in `features/team-roster`.
 */
export const teamStubs = {
  async getTeamRoster(): Promise<TeamRosterResponse> {
    return {
      members: [],
      warnings: [{ source: 'team', message: 'No DorkOS server in embedded mode.' }],
    };
  },

  /**
   * The rooms a member is in, with no rooms subsystem behind the plugin.
   *
   * An empty list rather than a throw, and — unlike the roster above — with no
   * warning to carry it, because this envelope has nowhere to put one and
   * inventing a field for the embed would be the wrong place to decide the
   * shape. It is honest in the only way it can be: the roster it would have
   * been read for is empty too, so nothing in the embed ever asks this about
   * somebody it just listed.
   */
  async listMemberRooms(): Promise<MemberRoomsResponse> {
    return { rooms: [] };
  },
};

// ---------------------------------------------------------------------------
// Profile stubs
// ---------------------------------------------------------------------------

/**
 * Editing your own identity, in a plugin with no server behind it.
 *
 * These throw rather than answer emptily, and the difference matters here more
 * than it does for a read: a read that quietly returns nothing shows an empty
 * page, but a WRITE that quietly succeeds tells somebody their new name was
 * saved when nothing stored it. The surfaces that offer these are not reachable
 * in the embed anyway — the account menu and Settings › Profile both hang off
 * the roster, which is empty here — so this is the guard on that, not the path.
 *
 * @internal
 */
// Read state is deliberately NOT stubbed here. The embed keeps its own cursors
// in this browser (`direct/read-cursor-methods`), because a transcript with an
// unread rule that never draws reads as a broken divider rather than as a
// missing server — and where read state is stored is precisely what the
// Transport seam is for.

export const profileStubs = {
  async updateProfile(_displayName: string): Promise<never> {
    throw new Error('Editing your profile needs a DorkOS server');
  },

  async uploadProfileAvatar(_file: Blob, _filename: string): Promise<never> {
    throw new Error('Profile photos need a DorkOS server');
  },

  async deleteProfileAvatar(): Promise<never> {
    throw new Error('Profile photos need a DorkOS server');
  },
};
