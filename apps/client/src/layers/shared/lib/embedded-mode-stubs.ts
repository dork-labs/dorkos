/**
 * Embedded mode stub methods for subsystems not supported in the Obsidian plugin.
 *
 * Pulse, Relay, Mesh observability, and related features are server-only.
 * These stubs return empty arrays for list operations and throw descriptive
 * errors for write/mutation operations.
 *
 * @module shared/lib/embedded-mode-stubs
 */
import type { AdapterListItem, AdapterEvent, McpConfigResponse } from '@dorkos/shared/transport';
import type {
  TraceSpan,
  DeliveryMetrics,
  CatalogEntry,
  AdapterBinding,
  CreateBindingRequest,
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
  PulseSchedule,
  PulseRun,
  CreateScheduleInput,
  UpdateScheduleRequest,
  ListRunsQuery,
  PulsePreset,
} from '@dorkos/shared/types';

// ---------------------------------------------------------------------------
// Pulse scheduler stubs
// ---------------------------------------------------------------------------

/** @internal */
export const pulseStubs = {
  async listSchedules(): Promise<PulseSchedule[]> {
    return [];
  },

  async createSchedule(_opts: CreateScheduleInput): Promise<PulseSchedule> {
    throw new Error('Pulse scheduler is not supported in embedded mode');
  },

  async updateSchedule(_id: string, _opts: UpdateScheduleRequest): Promise<PulseSchedule> {
    throw new Error('Pulse scheduler is not supported in embedded mode');
  },

  async deleteSchedule(_id: string): Promise<{ success: boolean }> {
    throw new Error('Pulse scheduler is not supported in embedded mode');
  },

  async triggerSchedule(_id: string): Promise<{ runId: string }> {
    throw new Error('Pulse scheduler is not supported in embedded mode');
  },

  async listRuns(_opts?: Partial<ListRunsQuery>): Promise<PulseRun[]> {
    return [];
  },

  async getRun(_id: string): Promise<PulseRun> {
    throw new Error('Pulse scheduler is not supported in embedded mode');
  },

  async cancelRun(_id: string): Promise<{ success: boolean }> {
    throw new Error('Pulse scheduler is not supported in embedded mode');
  },

  async getPulsePresets(): Promise<PulsePreset[]> {
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

  async updateBinding(
    _id: string,
    _updates: Partial<
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
  ): Promise<AdapterBinding> {
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
    _approver?: string
  ): Promise<AgentManifest> {
    throw new Error('Mesh is not supported in embedded mode');
  },

  async updateMeshAgent(_id: string, _updates: Partial<AgentManifest>): Promise<AgentManifest> {
    throw new Error('Mesh is not supported in embedded mode');
  },

  async unregisterMeshAgent(_id: string): Promise<{ success: boolean }> {
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
// Miscellaneous server-only stubs
// ---------------------------------------------------------------------------

/** @internal */
export const serverOnlyStubs = {
  async startTunnel(): Promise<{ url: string }> {
    return { url: '' };
  },

  async stopTunnel(): Promise<void> {
    // No-op in embedded mode
  },

  async verifyTunnelPasscode(
    _passcode: string
  ): Promise<{ ok: boolean; error?: string; retryAfter?: number }> {
    return { ok: false, error: 'Not available in embedded mode' };
  },

  async checkTunnelSession(): Promise<{ authenticated: boolean; passcodeRequired: boolean }> {
    return { authenticated: false, passcodeRequired: false };
  },

  async setTunnelPasscode(_opts: {
    passcode?: string;
    enabled: boolean;
  }): Promise<{ ok: boolean }> {
    return { ok: false };
  },

  async updateConfig(_patch: Record<string, unknown>): Promise<void> {
    // No-op in embedded mode — config is not persisted via DirectTransport.
  },

  async getMcpConfig(_projectPath: string): Promise<McpConfigResponse> {
    return { servers: [] };
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

  async createAgent(_opts: CreateAgentOptions): Promise<AgentManifest> {
    throw new Error('Agent creation is not supported in Obsidian plugin mode.');
  },

  async setDefaultAgent(_agentName: string): Promise<void> {
    // No-op in embedded mode — config is not persisted via DirectTransport.
  },
};
