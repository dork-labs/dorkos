/**
 * HTTP Transport — implements the Transport interface for standalone web clients.
 * Domain-specific methods are delegated to factory-produced objects (pulse, relay, mesh).
 *
 * @module shared/lib/transport/http-transport
 */
import type {
  Session,
  UpdateSessionRequest,
  BrowseDirectoryResponse,
  CommandRegistry,
  FileListResponse,
  HealthResponse,
  HistoryMessage,
  StreamEvent,
  TaskItem,
  ServerConfig,
  ModelOption,
  GitStatusResponse,
  GitStatusError,
  SessionLockedError,
  PulseSchedule,
  PulseRun,
  CreateScheduleInput,
  UpdateScheduleRequest,
  ListRunsQuery,
  PulsePreset,
  ReloadPluginsResult,
  UploadResult,
  UploadProgress,
} from '@dorkos/shared/types';
import type {
  Transport,
  AdapterListItem,
  AdapterEvent,
  UploadFile,
  McpConfigResponse,
} from '@dorkos/shared/transport';
import type { TemplateEntry } from '@dorkos/shared/template-catalog';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import type {
  TraceSpan,
  DeliveryMetrics,
  CatalogEntry,
  RelayConversation,
  AdapterBinding,
  CreateBindingRequest,
  ObservedChat,
} from '@dorkos/shared/relay-schemas';
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
  TransportScanOptions,
  TransportScanEvent,
} from '@dorkos/shared/mesh-schemas';
import { fetchJSON, buildQueryString } from './http-client';
import { parseSSEStream } from './sse-parser';
import { createPulseMethods } from './pulse-methods';
import { createRelayMethods } from './relay-methods';
import { createMeshMethods } from './mesh-methods';

/**
 *
 */
export class HttpTransport implements Transport {
  readonly clientId: string;
  private readonly etagCache = new Map<string, string>();
  private readonly messageCache = new Map<string, { messages: HistoryMessage[] }>();

  // Delegated method declarations — satisfied at runtime via Object.assign
  declare listSchedules: () => Promise<PulseSchedule[]>;
  declare createSchedule: (opts: CreateScheduleInput) => Promise<PulseSchedule>;
  declare updateSchedule: (id: string, opts: UpdateScheduleRequest) => Promise<PulseSchedule>;
  declare deleteSchedule: (id: string) => Promise<{ success: boolean }>;
  declare triggerSchedule: (id: string) => Promise<{ runId: string }>;
  declare listRuns: (opts?: Partial<ListRunsQuery>) => Promise<PulseRun[]>;
  declare getRun: (id: string) => Promise<PulseRun>;
  declare cancelRun: (id: string) => Promise<{ success: boolean }>;
  declare getPulsePresets: () => Promise<PulsePreset[]>;

  declare listRelayMessages: (filters?: {
    subject?: string;
    status?: string;
    from?: string;
    cursor?: string;
    limit?: number;
  }) => Promise<{ messages: unknown[]; nextCursor?: string }>;
  declare getRelayMessage: (id: string) => Promise<unknown>;
  declare sendRelayMessage: (opts: {
    subject: string;
    payload: unknown;
    from: string;
    replyTo?: string;
  }) => Promise<{ messageId: string; deliveredTo: number }>;
  declare listRelayEndpoints: () => Promise<unknown[]>;
  declare registerRelayEndpoint: (subject: string) => Promise<unknown>;
  declare unregisterRelayEndpoint: (subject: string) => Promise<{ success: boolean }>;
  declare readRelayInbox: (
    subject: string,
    opts?: { status?: string; cursor?: string; limit?: number }
  ) => Promise<{ messages: unknown[]; nextCursor?: string }>;
  declare getRelayMetrics: () => Promise<unknown>;
  declare listRelayDeadLetters: (filters?: { endpointHash?: string }) => Promise<unknown[]>;
  declare listAggregatedDeadLetters: () => Promise<{
    groups: import('@dorkos/shared/transport').AggregatedDeadLetter[];
  }>;
  declare dismissDeadLetterGroup: (
    source: string,
    reason: string
  ) => Promise<{ dismissed: number }>;
  declare listRelayConversations: () => Promise<{ conversations: RelayConversation[] }>;
  declare sendMessageRelay: (
    sessionId: string,
    content: string,
    options?: { clientId?: string; correlationId?: string; cwd?: string }
  ) => Promise<{ messageId: string; traceId: string }>;
  declare getRelayTrace: (messageId: string) => Promise<{ traceId: string; spans: TraceSpan[] }>;
  declare getRelayDeliveryMetrics: () => Promise<DeliveryMetrics>;
  declare listRelayAdapters: () => Promise<AdapterListItem[]>;
  declare toggleRelayAdapter: (id: string, enabled: boolean) => Promise<{ ok: boolean }>;
  declare getAdapterCatalog: () => Promise<CatalogEntry[]>;
  declare addRelayAdapter: (
    type: string,
    id: string,
    config: Record<string, unknown>
  ) => Promise<{ ok: boolean }>;
  declare removeRelayAdapter: (id: string) => Promise<{ ok: boolean }>;
  declare updateRelayAdapterConfig: (
    id: string,
    config: Record<string, unknown>
  ) => Promise<{ ok: boolean }>;
  declare testRelayAdapterConnection: (
    type: string,
    config: Record<string, unknown>
  ) => Promise<{ ok: boolean; error?: string; botUsername?: string }>;
  declare getAdapterEvents: (
    adapterId: string,
    limit?: number
  ) => Promise<{ events: AdapterEvent[] }>;
  declare getObservedChats: (adapterId: string) => Promise<ObservedChat[]>;
  declare getBindings: () => Promise<AdapterBinding[]>;
  declare createBinding: (input: CreateBindingRequest) => Promise<AdapterBinding>;
  declare deleteBinding: (id: string) => Promise<void>;
  declare updateBinding: (
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
  ) => Promise<AdapterBinding>;

  declare listMeshAgentPaths: () => Promise<{ agents: AgentPathEntry[] }>;
  declare discoverMeshAgents: (
    roots: string[],
    maxDepth?: number
  ) => Promise<{ candidates: DiscoveryCandidate[] }>;
  declare listMeshAgents: (filters?: {
    runtime?: string;
    capability?: string;
  }) => Promise<{ agents: AgentManifest[] }>;
  declare getMeshAgent: (id: string) => Promise<AgentManifest>;
  declare registerMeshAgent: (
    path: string,
    overrides?: Partial<AgentManifest>,
    approver?: string
  ) => Promise<AgentManifest>;
  declare updateMeshAgent: (id: string, updates: Partial<AgentManifest>) => Promise<AgentManifest>;
  declare unregisterMeshAgent: (id: string) => Promise<{ success: boolean }>;
  declare denyMeshAgent: (
    path: string,
    reason?: string,
    denier?: string
  ) => Promise<{ success: boolean }>;
  declare listDeniedMeshAgents: () => Promise<{ denied: DenialRecord[] }>;
  declare clearMeshDenial: (path: string) => Promise<{ success: boolean }>;
  declare getMeshStatus: () => Promise<MeshStatus>;
  declare getMeshAgentHealth: (id: string) => Promise<AgentHealth>;
  declare sendMeshHeartbeat: (id: string, event?: string) => Promise<{ success: boolean }>;
  declare getMeshTopology: (namespace?: string) => Promise<TopologyView>;
  declare updateMeshAccessRule: (body: UpdateAccessRuleRequest) => Promise<CrossNamespaceRule>;
  declare getMeshAgentAccess: (agentId: string) => Promise<{ agents: AgentManifest[] }>;
  declare getAgentByPath: (path: string) => Promise<AgentManifest | null>;
  declare resolveAgents: (paths: string[]) => Promise<Record<string, AgentManifest | null>>;
  declare initAgent: (
    path: string,
    name?: string,
    description?: string,
    runtime?: string
  ) => Promise<AgentManifest>;
  declare updateAgentByPath: (
    path: string,
    updates: Partial<AgentManifest>
  ) => Promise<AgentManifest>;
  declare createAgent: (opts: CreateAgentOptions) => Promise<AgentManifest>;

  constructor(private baseUrl: string) {
    this.clientId = `web-${crypto.randomUUID()}`;
    Object.assign(
      this,
      createPulseMethods(baseUrl),
      createRelayMethods(baseUrl, () => this.clientId),
      createMeshMethods(baseUrl)
    );
  }

  // --- Session Management ---

  listSessions(cwd?: string): Promise<Session[]> {
    const qs = buildQueryString({ cwd });
    return fetchJSON<Session[]>(this.baseUrl, `/sessions${qs}`);
  }

  getSession(id: string, cwd?: string): Promise<Session> {
    const qs = buildQueryString({ cwd });
    return fetchJSON<Session>(this.baseUrl, `/sessions/${id}${qs}`);
  }

  updateSession(id: string, opts: UpdateSessionRequest, cwd?: string): Promise<Session> {
    const qs = buildQueryString({ cwd });
    return fetchJSON<Session>(this.baseUrl, `/sessions/${id}${qs}`, {
      method: 'PATCH',
      body: JSON.stringify(opts),
    });
  }

  forkSession(
    id: string,
    opts?: { upToMessageId?: string; title?: string },
    cwd?: string
  ): Promise<Session> {
    const qs = buildQueryString({ cwd });
    return fetchJSON<Session>(this.baseUrl, `/sessions/${id}/fork${qs}`, {
      method: 'POST',
      body: JSON.stringify(opts ?? {}),
    });
  }

  reloadPlugins(sessionId: string): Promise<ReloadPluginsResult> {
    return fetchJSON<ReloadPluginsResult>(this.baseUrl, `/sessions/${sessionId}/reload-plugins`, {
      method: 'POST',
    });
  }

  // --- Message History (ETag caching) ---

  async getMessages(sessionId: string, cwd?: string): Promise<{ messages: HistoryMessage[] }> {
    const qs = buildQueryString({ cwd });
    const url = `/sessions/${sessionId}/messages${qs}`;

    const headers: HeadersInit = { 'Content-Type': 'application/json' };
    const cachedEtag = this.etagCache.get(sessionId);
    if (cachedEtag) {
      headers['If-None-Match'] = cachedEtag;
    }

    const res = await fetch(`${this.baseUrl}${url}`, { headers });

    if (res.status === 304) {
      const cached = this.messageCache.get(sessionId);
      if (cached) return cached;
      throw new Error('304 received but no cached response available');
    }

    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    const etag = res.headers.get('ETag');
    if (etag) {
      this.etagCache.set(sessionId, etag);
      this.messageCache.set(sessionId, data);
    }

    return data;
  }

  // --- Message Streaming (SSE) ---

  async sendMessage(
    sessionId: string,
    content: string,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal,
    cwd?: string,
    options?: { clientMessageId?: string; uiState?: import('@dorkos/shared/types').UiState }
  ): Promise<void> {
    const body: Record<string, unknown> = { content };
    if (cwd) body.cwd = cwd;
    if (options?.clientMessageId) body.clientMessageId = options.clientMessageId;
    if (options?.uiState) body.uiState = options.uiState;

    const response = await fetch(`${this.baseUrl}/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': this.clientId,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      if (response.status === 409) {
        const errorData = (await response.json().catch(() => null)) as SessionLockedError | null;
        if (errorData && errorData.code === 'SESSION_LOCKED') {
          const error = new Error('Session locked') as Error & SessionLockedError;
          error.code = 'SESSION_LOCKED';
          error.lockedBy = errorData.lockedBy;
          error.lockedAt = errorData.lockedAt;
          throw error;
        }
      }
      throw new Error(`HTTP ${response.status}`);
    }

    const reader = response.body!.getReader();
    for await (const event of parseSSEStream<StreamEvent['data']>(reader)) {
      onEvent({ type: event.type, data: event.data } as StreamEvent);
    }
  }

  // --- Tool Approval ---
  // Interaction requests use a longer timeout (10 min) to match the server-side
  // INTERACTION_TIMEOUT_MS. The default 30s fetchJSON timeout is too aggressive
  // because these requests can be queued by the browser when SSE connections
  // consume the HTTP/1.1 per-origin connection limit (6 in Chrome).
  private static readonly INTERACTION_TIMEOUT_MS = 10 * 60 * 1000;

  approveTool(sessionId: string, toolCallId: string): Promise<{ ok: boolean }> {
    return fetchJSON<{ ok: boolean }>(this.baseUrl, `/sessions/${sessionId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ toolCallId }),
      timeout: HttpTransport.INTERACTION_TIMEOUT_MS,
    });
  }

  denyTool(sessionId: string, toolCallId: string): Promise<{ ok: boolean }> {
    return fetchJSON<{ ok: boolean }>(this.baseUrl, `/sessions/${sessionId}/deny`, {
      method: 'POST',
      body: JSON.stringify({ toolCallId }),
      timeout: HttpTransport.INTERACTION_TIMEOUT_MS,
    });
  }

  submitAnswers(
    sessionId: string,
    toolCallId: string,
    answers: Record<string, string>
  ): Promise<{ ok: boolean }> {
    return fetchJSON<{ ok: boolean }>(this.baseUrl, `/sessions/${sessionId}/submit-answers`, {
      method: 'POST',
      body: JSON.stringify({ toolCallId, answers }),
      timeout: HttpTransport.INTERACTION_TIMEOUT_MS,
    });
  }

  /** Stop a running background task. */
  stopTask(sessionId: string, taskId: string): Promise<{ success: boolean; taskId: string }> {
    return fetchJSON<{ success: boolean; taskId: string }>(
      this.baseUrl,
      `/sessions/${sessionId}/tasks/${taskId}/stop`,
      { method: 'POST' }
    );
  }

  // --- Tasks ---

  async getTasks(sessionId: string, cwd?: string): Promise<{ tasks: TaskItem[] }> {
    try {
      const qs = buildQueryString({ cwd });
      return await fetchJSON<{ tasks: TaskItem[] }>(
        this.baseUrl,
        `/sessions/${sessionId}/tasks${qs}`
      );
    } catch {
      return { tasks: [] };
    }
  }

  // --- Directory & File Operations ---

  browseDirectory(dirPath?: string, showHidden?: boolean): Promise<BrowseDirectoryResponse> {
    const qs = buildQueryString({ path: dirPath, showHidden: showHidden || undefined });
    return fetchJSON<BrowseDirectoryResponse>(this.baseUrl, `/directory${qs}`);
  }

  createDirectory(parentPath: string, folderName: string): Promise<{ path: string }> {
    return fetchJSON<{ path: string }>(this.baseUrl, '/directory', {
      method: 'POST',
      body: JSON.stringify({ parentPath, folderName }),
    });
  }

  getDefaultCwd(): Promise<{ path: string }> {
    return fetchJSON<{ path: string }>(this.baseUrl, '/directory/default');
  }

  listFiles(cwd: string): Promise<FileListResponse> {
    const params = new URLSearchParams({ cwd });
    return fetchJSON<FileListResponse>(this.baseUrl, `/files?${params}`);
  }

  getGitStatus(cwd?: string): Promise<GitStatusResponse | GitStatusError> {
    const qs = buildQueryString({ dir: cwd });
    return fetchJSON<GitStatusResponse | GitStatusError>(this.baseUrl, `/git/status${qs}`);
  }

  // --- Commands & Status ---

  getCommands(refresh = false, cwd?: string): Promise<CommandRegistry> {
    const qs = buildQueryString({ refresh: refresh || undefined, cwd });
    return fetchJSON<CommandRegistry>(this.baseUrl, `/commands${qs}`);
  }

  // --- Config & Health ---

  health(): Promise<HealthResponse> {
    return fetchJSON<HealthResponse>(this.baseUrl, '/health');
  }

  getConfig(): Promise<ServerConfig> {
    return fetchJSON<ServerConfig>(this.baseUrl, '/config');
  }

  async updateConfig(patch: Record<string, unknown>): Promise<void> {
    await fetchJSON<void>(this.baseUrl, '/config', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  getModels(): Promise<ModelOption[]> {
    return fetchJSON<{ models: ModelOption[] }>(this.baseUrl, '/models').then((r) => r.models);
  }

  getCapabilities(): Promise<{
    capabilities: Record<string, RuntimeCapabilities>;
    defaultRuntime: string;
  }> {
    return fetchJSON(this.baseUrl, '/capabilities');
  }

  // --- Tunnel Management ---

  startTunnel(): Promise<{ url: string }> {
    return fetchJSON<{ url: string }>(this.baseUrl, '/tunnel/start', { method: 'POST' });
  }

  async stopTunnel(): Promise<void> {
    await fetchJSON<{ ok: boolean }>(this.baseUrl, '/tunnel/stop', { method: 'POST' });
  }

  verifyTunnelPasscode(
    passcode: string
  ): Promise<{ ok: boolean; error?: string; retryAfter?: number }> {
    return fetchJSON(this.baseUrl, '/tunnel/passcode/verify', {
      method: 'POST',
      body: JSON.stringify({ passcode }),
    });
  }

  checkTunnelSession(): Promise<{ authenticated: boolean; passcodeRequired: boolean }> {
    return fetchJSON(this.baseUrl, '/tunnel/passcode/session');
  }

  setTunnelPasscode(opts: { passcode?: string; enabled: boolean }): Promise<{ ok: boolean }> {
    return fetchJSON(this.baseUrl, '/tunnel/passcode/set', {
      method: 'POST',
      body: JSON.stringify(opts),
    });
  }

  // --- Admin Operations ---

  async resetAllData(confirm: string): Promise<{ message: string }> {
    const res = await fetch(`${this.baseUrl}/admin/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text);
    }
    return res.json();
  }

  async restartServer(): Promise<{ message: string }> {
    const res = await fetch(`${this.baseUrl}/admin/restart`, {
      method: 'POST',
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text);
    }
    return res.json();
  }

  // --- Discovery Scan (SSE) ---

  async scan(
    options: TransportScanOptions,
    onEvent: (event: TransportScanEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const response = await fetch(`${this.baseUrl}/discovery/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
      signal,
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(body.error ?? `HTTP ${response.status}`);
    }

    const reader = response.body!.getReader();
    for await (const event of parseSSEStream<TransportScanEvent['data']>(reader)) {
      onEvent({ type: event.type, data: event.data } as TransportScanEvent);
    }
  }

  // --- File Uploads ---

  // --- Templates ---

  async getTemplates(): Promise<TemplateEntry[]> {
    const data = await fetchJSON<{ templates: TemplateEntry[] }>(this.baseUrl, '/templates');
    return data.templates;
  }

  getMcpConfig(projectPath: string): Promise<McpConfigResponse> {
    return fetchJSON<McpConfigResponse>(
      this.baseUrl,
      `/mcp-config?path=${encodeURIComponent(projectPath)}`
    );
  }

  async uploadFiles(
    files: UploadFile[],
    cwd: string,
    onProgress?: (progress: UploadProgress) => void
  ): Promise<UploadResult[]> {
    const formData = new FormData();
    for (const file of files) {
      const buffer = await file.arrayBuffer();
      formData.append('files', new Blob([buffer], { type: file.type }), file.name);
    }

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${this.baseUrl}/uploads?cwd=${encodeURIComponent(cwd)}`);

      if (onProgress) {
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            onProgress({
              loaded: e.loaded,
              total: e.total,
              percentage: Math.round((e.loaded / e.total) * 100),
            });
          }
        });
      }

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const data = JSON.parse(xhr.responseText);
          resolve(data.uploads);
        } else {
          try {
            const error = JSON.parse(xhr.responseText).error || `HTTP ${xhr.status}`;
            reject(new Error(error));
          } catch {
            reject(new Error(`HTTP ${xhr.status}`));
          }
        }
      });

      xhr.addEventListener('error', () => reject(new Error('Upload failed')));
      xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));

      xhr.send(formData);
    });
  }

  // --- Default Agent ---

  async setDefaultAgent(agentName: string): Promise<void> {
    await fetchJSON<{ success: boolean }>(this.baseUrl, '/config/agents/defaultAgent', {
      method: 'PUT',
      body: JSON.stringify({ value: agentName }),
    });
  }
}
