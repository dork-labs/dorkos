import type {
  Session,
  CreateSessionRequest,
  UpdateSessionRequest,
  BrowseDirectoryResponse,
  CommandRegistry,
  FileListResponse,
  HealthResponse,
  HistoryMessage,
  StreamEvent,
  TaskItem,
  ServerConfig,
  GitStatusResponse,
  GitStatusError,
  SessionLockedError,
  PulseSchedule,
  PulseRun,
  CreateScheduleInput,
  UpdateScheduleRequest,
  ListRunsQuery,
} from '@dorkos/shared/types';
import type { Transport, AdapterListItem } from '@dorkos/shared/transport';
import type { TraceSpan, DeliveryMetrics } from '@dorkos/shared/relay-schemas';
import type {
  AgentManifest,
  DiscoveryCandidate,
  DenialRecord,
  AgentHealth,
  MeshStatus,
  TopologyView,
  UpdateAccessRuleRequest,
  CrossNamespaceRule,
} from '@dorkos/shared/mesh-schemas';

async function fetchJSON<T>(baseUrl: string, url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export class HttpTransport implements Transport {
  private readonly clientId: string;
  private readonly etagCache = new Map<string, string>();
  private readonly messageCache = new Map<string, { messages: HistoryMessage[] }>();

  constructor(private baseUrl: string) {
    this.clientId = crypto.randomUUID();
  }

  createSession(opts: CreateSessionRequest): Promise<Session> {
    return fetchJSON<Session>(this.baseUrl, '/sessions', {
      method: 'POST',
      body: JSON.stringify(opts),
    });
  }

  listSessions(cwd?: string): Promise<Session[]> {
    const params = new URLSearchParams();
    if (cwd) params.set('cwd', cwd);
    const qs = params.toString();
    return fetchJSON<Session[]>(this.baseUrl, `/sessions${qs ? `?${qs}` : ''}`);
  }

  getSession(id: string, cwd?: string): Promise<Session> {
    const params = new URLSearchParams();
    if (cwd) params.set('cwd', cwd);
    const qs = params.toString();
    return fetchJSON<Session>(this.baseUrl, `/sessions/${id}${qs ? `?${qs}` : ''}`);
  }

  updateSession(id: string, opts: UpdateSessionRequest, cwd?: string): Promise<Session> {
    const params = new URLSearchParams();
    if (cwd) params.set('cwd', cwd);
    const qs = params.toString();
    return fetchJSON<Session>(this.baseUrl, `/sessions/${id}${qs ? `?${qs}` : ''}`, {
      method: 'PATCH',
      body: JSON.stringify(opts),
    });
  }

  async getMessages(sessionId: string, cwd?: string): Promise<{ messages: HistoryMessage[] }> {
    const params = new URLSearchParams();
    if (cwd) params.set('cwd', cwd);
    const qs = params.toString();
    const url = `/sessions/${sessionId}/messages${qs ? `?${qs}` : ''}`;

    // Build headers with If-None-Match if we have a cached ETag
    const headers: HeadersInit = { 'Content-Type': 'application/json' };
    const cachedEtag = this.etagCache.get(sessionId);
    if (cachedEtag) {
      headers['If-None-Match'] = cachedEtag;
    }

    const res = await fetch(`${this.baseUrl}${url}`, { headers });

    // 304 Not Modified: return cached response
    if (res.status === 304) {
      const cached = this.messageCache.get(sessionId);
      if (cached) {
        return cached;
      }
      // Fallback: if cache is missing, treat as error
      throw new Error('304 received but no cached response available');
    }

    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || `HTTP ${res.status}`);
    }

    // 200 OK: parse response, cache ETag and response
    const data = await res.json();
    const etag = res.headers.get('ETag');
    if (etag) {
      this.etagCache.set(sessionId, etag);
      this.messageCache.set(sessionId, data);
    }

    return data;
  }

  async sendMessage(
    sessionId: string,
    content: string,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal,
    cwd?: string
  ): Promise<void> {
    const response = await fetch(`${this.baseUrl}/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': this.clientId,
      },
      body: JSON.stringify({ content, ...(cwd && { cwd }) }),
      signal,
    });

    if (!response.ok) {
      // Check for 409 SESSION_LOCKED error
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
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let eventType = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ') && eventType) {
          const data = JSON.parse(line.slice(6));
          onEvent({ type: eventType, data } as StreamEvent);
          eventType = '';
        }
      }
    }
  }

  approveTool(sessionId: string, toolCallId: string): Promise<{ ok: boolean }> {
    return fetchJSON<{ ok: boolean }>(this.baseUrl, `/sessions/${sessionId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ toolCallId }),
    });
  }

  denyTool(sessionId: string, toolCallId: string): Promise<{ ok: boolean }> {
    return fetchJSON<{ ok: boolean }>(this.baseUrl, `/sessions/${sessionId}/deny`, {
      method: 'POST',
      body: JSON.stringify({ toolCallId }),
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
    });
  }

  async getTasks(sessionId: string, cwd?: string): Promise<{ tasks: TaskItem[] }> {
    try {
      const params = new URLSearchParams();
      if (cwd) params.set('cwd', cwd);
      const qs = params.toString();
      return await fetchJSON<{ tasks: TaskItem[] }>(
        this.baseUrl,
        `/sessions/${sessionId}/tasks${qs ? `?${qs}` : ''}`
      );
    } catch {
      return { tasks: [] };
    }
  }

  browseDirectory(dirPath?: string, showHidden?: boolean): Promise<BrowseDirectoryResponse> {
    const params = new URLSearchParams();
    if (dirPath) params.set('path', dirPath);
    if (showHidden) params.set('showHidden', 'true');
    const qs = params.toString();
    return fetchJSON<BrowseDirectoryResponse>(this.baseUrl, `/directory${qs ? `?${qs}` : ''}`);
  }

  getDefaultCwd(): Promise<{ path: string }> {
    return fetchJSON<{ path: string }>(this.baseUrl, '/directory/default');
  }

  getCommands(refresh = false, cwd?: string): Promise<CommandRegistry> {
    const params = new URLSearchParams();
    if (refresh) params.set('refresh', 'true');
    if (cwd) params.set('cwd', cwd);
    const qs = params.toString();
    return fetchJSON<CommandRegistry>(this.baseUrl, `/commands${qs ? `?${qs}` : ''}`);
  }

  getGitStatus(cwd?: string): Promise<GitStatusResponse | GitStatusError> {
    const params = new URLSearchParams();
    if (cwd) params.set('dir', cwd);
    const qs = params.toString();
    return fetchJSON<GitStatusResponse | GitStatusError>(
      this.baseUrl,
      `/git/status${qs ? `?${qs}` : ''}`
    );
  }

  health(): Promise<HealthResponse> {
    return fetchJSON<HealthResponse>(this.baseUrl, '/health');
  }

  listFiles(cwd: string): Promise<FileListResponse> {
    const params = new URLSearchParams({ cwd });
    return fetchJSON<FileListResponse>(this.baseUrl, `/files?${params}`);
  }

  getConfig(): Promise<ServerConfig> {
    return fetchJSON<ServerConfig>(this.baseUrl, '/config');
  }

  startTunnel(): Promise<{ url: string }> {
    return fetchJSON<{ url: string }>(this.baseUrl, '/tunnel/start', { method: 'POST' });
  }

  async stopTunnel(): Promise<void> {
    await fetchJSON<{ ok: boolean }>(this.baseUrl, '/tunnel/stop', { method: 'POST' });
  }

  // --- Pulse Scheduler ---

  listSchedules(): Promise<PulseSchedule[]> {
    return fetchJSON<PulseSchedule[]>(this.baseUrl, '/pulse/schedules');
  }

  createSchedule(opts: CreateScheduleInput): Promise<PulseSchedule> {
    return fetchJSON<PulseSchedule>(this.baseUrl, '/pulse/schedules', {
      method: 'POST',
      body: JSON.stringify(opts),
    });
  }

  updateSchedule(id: string, opts: UpdateScheduleRequest): Promise<PulseSchedule> {
    return fetchJSON<PulseSchedule>(this.baseUrl, `/pulse/schedules/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(opts),
    });
  }

  deleteSchedule(id: string): Promise<{ success: boolean }> {
    return fetchJSON<{ success: boolean }>(this.baseUrl, `/pulse/schedules/${id}`, {
      method: 'DELETE',
    });
  }

  triggerSchedule(id: string): Promise<{ runId: string }> {
    return fetchJSON<{ runId: string }>(this.baseUrl, `/pulse/schedules/${id}/trigger`, {
      method: 'POST',
    });
  }

  listRuns(opts?: Partial<ListRunsQuery>): Promise<PulseRun[]> {
    const params = new URLSearchParams();
    if (opts?.scheduleId) params.set('scheduleId', opts.scheduleId);
    if (opts?.status) params.set('status', opts.status);
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.offset) params.set('offset', String(opts.offset));
    const qs = params.toString();
    return fetchJSON<PulseRun[]>(this.baseUrl, `/pulse/runs${qs ? `?${qs}` : ''}`);
  }

  getRun(id: string): Promise<PulseRun> {
    return fetchJSON<PulseRun>(this.baseUrl, `/pulse/runs/${id}`);
  }

  cancelRun(id: string): Promise<{ success: boolean }> {
    return fetchJSON<{ success: boolean }>(this.baseUrl, `/pulse/runs/${id}/cancel`, {
      method: 'POST',
    });
  }

  // --- Relay Message Bus ---

  listRelayMessages(filters?: {
    subject?: string;
    status?: string;
    from?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ messages: unknown[]; nextCursor?: string }> {
    const params = new URLSearchParams();
    if (filters?.subject) params.set('subject', filters.subject);
    if (filters?.status) params.set('status', filters.status);
    if (filters?.from) params.set('from', filters.from);
    if (filters?.cursor) params.set('cursor', filters.cursor);
    if (filters?.limit) params.set('limit', String(filters.limit));
    const qs = params.toString();
    return fetchJSON(this.baseUrl, `/relay/messages${qs ? `?${qs}` : ''}`);
  }

  getRelayMessage(id: string): Promise<unknown> {
    return fetchJSON(this.baseUrl, `/relay/messages/${id}`);
  }

  sendRelayMessage(opts: {
    subject: string;
    payload: unknown;
    from: string;
    replyTo?: string;
  }): Promise<{ messageId: string; deliveredTo: number }> {
    return fetchJSON(this.baseUrl, '/relay/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
  }

  listRelayEndpoints(): Promise<unknown[]> {
    return fetchJSON(this.baseUrl, '/relay/endpoints');
  }

  registerRelayEndpoint(subject: string): Promise<unknown> {
    return fetchJSON(this.baseUrl, '/relay/endpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject }),
    });
  }

  unregisterRelayEndpoint(subject: string): Promise<{ success: boolean }> {
    return fetchJSON(this.baseUrl, `/relay/endpoints/${subject}`, { method: 'DELETE' });
  }

  readRelayInbox(
    subject: string,
    opts?: { status?: string; cursor?: string; limit?: number },
  ): Promise<{ messages: unknown[]; nextCursor?: string }> {
    const params = new URLSearchParams();
    if (opts?.status) params.set('status', opts.status);
    if (opts?.cursor) params.set('cursor', opts.cursor);
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return fetchJSON(this.baseUrl, `/relay/endpoints/${subject}/inbox${qs ? `?${qs}` : ''}`);
  }

  getRelayMetrics(): Promise<unknown> {
    return fetchJSON(this.baseUrl, '/relay/metrics');
  }

  // --- Relay Convergence ---

  async sendMessageRelay(
    sessionId: string,
    content: string,
    options?: { clientId?: string },
  ): Promise<{ messageId: string; traceId: string }> {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': options?.clientId ?? this.clientId,
      },
      body: JSON.stringify({ content }),
    });
    if (res.status !== 202 && !res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  getRelayTrace(messageId: string): Promise<{ traceId: string; spans: TraceSpan[] }> {
    return fetchJSON(this.baseUrl, `/relay/messages/${messageId}/trace`);
  }

  getRelayDeliveryMetrics(): Promise<DeliveryMetrics> {
    return fetchJSON(this.baseUrl, '/relay/trace/metrics');
  }

  // --- Relay Adapters ---

  listRelayAdapters(): Promise<AdapterListItem[]> {
    return fetchJSON(this.baseUrl, '/relay/adapters');
  }

  toggleRelayAdapter(id: string, enabled: boolean): Promise<{ ok: boolean }> {
    return fetchJSON(this.baseUrl, `/relay/adapters/${id}/${enabled ? 'enable' : 'disable'}`, {
      method: 'POST',
    });
  }

  // --- Mesh Agent Discovery ---

  discoverMeshAgents(roots: string[], maxDepth?: number): Promise<{ candidates: DiscoveryCandidate[] }> {
    return fetchJSON(this.baseUrl, '/mesh/discover', {
      method: 'POST',
      body: JSON.stringify({ roots, ...(maxDepth !== undefined && { maxDepth }) }),
    });
  }

  listMeshAgents(filters?: { runtime?: string; capability?: string }): Promise<{ agents: AgentManifest[] }> {
    const params = new URLSearchParams();
    if (filters?.runtime) params.set('runtime', filters.runtime);
    if (filters?.capability) params.set('capability', filters.capability);
    const qs = params.toString();
    return fetchJSON(this.baseUrl, `/mesh/agents${qs ? `?${qs}` : ''}`);
  }

  getMeshAgent(id: string): Promise<AgentManifest> {
    return fetchJSON(this.baseUrl, `/mesh/agents/${id}`);
  }

  registerMeshAgent(path: string, overrides?: Partial<AgentManifest>, approver?: string): Promise<AgentManifest> {
    return fetchJSON(this.baseUrl, '/mesh/agents', {
      method: 'POST',
      body: JSON.stringify({ path, ...(overrides && { overrides }), ...(approver && { approver }) }),
    });
  }

  updateMeshAgent(id: string, updates: Partial<AgentManifest>): Promise<AgentManifest> {
    return fetchJSON(this.baseUrl, `/mesh/agents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }

  unregisterMeshAgent(id: string): Promise<{ success: boolean }> {
    return fetchJSON(this.baseUrl, `/mesh/agents/${id}`, { method: 'DELETE' });
  }

  denyMeshAgent(path: string, reason?: string, denier?: string): Promise<{ success: boolean }> {
    return fetchJSON(this.baseUrl, '/mesh/deny', {
      method: 'POST',
      body: JSON.stringify({ path, ...(reason && { reason }), ...(denier && { denier }) }),
    });
  }

  listDeniedMeshAgents(): Promise<{ denied: DenialRecord[] }> {
    return fetchJSON(this.baseUrl, '/mesh/denied');
  }

  clearMeshDenial(path: string): Promise<{ success: boolean }> {
    return fetchJSON(this.baseUrl, `/mesh/denied/${encodeURIComponent(path)}`, { method: 'DELETE' });
  }

  // --- Mesh Observability ---

  getMeshStatus(): Promise<MeshStatus> {
    return fetchJSON(this.baseUrl, '/mesh/status');
  }

  getMeshAgentHealth(id: string): Promise<AgentHealth> {
    return fetchJSON(this.baseUrl, `/mesh/agents/${id}/health`);
  }

  sendMeshHeartbeat(id: string, event?: string): Promise<{ success: boolean }> {
    return fetchJSON(this.baseUrl, `/mesh/agents/${id}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify({ ...(event && { event }) }),
    });
  }

  // --- Mesh Topology ---

  getMeshTopology(namespace?: string): Promise<TopologyView> {
    const qs = namespace ? `?namespace=${encodeURIComponent(namespace)}` : '';
    return fetchJSON(this.baseUrl, `/mesh/topology${qs}`);
  }

  updateMeshAccessRule(body: UpdateAccessRuleRequest): Promise<CrossNamespaceRule> {
    return fetchJSON(this.baseUrl, '/mesh/topology/access', {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  getMeshAgentAccess(agentId: string): Promise<{ rules: CrossNamespaceRule[] }> {
    return fetchJSON(this.baseUrl, `/mesh/agents/${encodeURIComponent(agentId)}/access`);
  }
}
