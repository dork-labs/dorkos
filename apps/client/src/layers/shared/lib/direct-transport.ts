import type { Transport, AdapterListItem } from '@dorkos/shared/transport';
import type { TraceSpan, DeliveryMetrics, CatalogEntry } from '@dorkos/shared/relay-schemas';
import type { AgentManifest, DiscoveryCandidate, DenialRecord, AgentHealth, MeshStatus, TopologyView, CrossNamespaceRule, UpdateAccessRuleRequest } from '@dorkos/shared/mesh-schemas';
import type {
  StreamEvent,
  Session,
  CreateSessionRequest,
  UpdateSessionRequest,
  BrowseDirectoryResponse,
  HealthResponse,
  PermissionMode,
  HistoryMessage,
  CommandRegistry,
  FileListResponse,
  TaskItem,
  ServerConfig,
  ModelOption,
  GitStatusResponse,
  GitStatusError,
  PulseSchedule,
  PulseRun,
  CreateScheduleInput,
  UpdateScheduleRequest,
  ListRunsQuery,
} from '@dorkos/shared/types';

export interface DirectTransportServices {
  agentManager: {
    ensureSession(id: string, opts: { permissionMode: PermissionMode; cwd?: string }): void;
    sendMessage(
      id: string,
      content: string,
      opts?: { permissionMode?: PermissionMode; cwd?: string }
    ): AsyncGenerator<StreamEvent>;
    approveTool(sessionId: string, toolCallId: string, approved: boolean): boolean;
    submitAnswers(sessionId: string, toolCallId: string, answers: Record<string, string>): boolean;
    updateSession(
      sessionId: string,
      opts: { permissionMode?: PermissionMode; model?: string }
    ): boolean;
  };
  transcriptReader: {
    listSessions(vaultRoot: string): Promise<Session[]>;
    getSession(vaultRoot: string, id: string): Promise<Session | null>;
    readTranscript(vaultRoot: string, id: string): Promise<HistoryMessage[]>;
    readTasks(vaultRoot: string, id: string): Promise<TaskItem[]>;
  };
  commandRegistry: {
    getCommands(forceRefresh?: boolean): Promise<CommandRegistry>;
  };
  fileLister?: {
    listFiles(cwd: string): Promise<{ files: string[]; truncated: boolean; total: number }>;
  };
  gitStatus?: {
    getGitStatus(cwd: string): Promise<GitStatusResponse | GitStatusError>;
  };
  vaultRoot: string;
}

export class DirectTransport implements Transport {
  constructor(private services: DirectTransportServices) {}

  async createSession(opts: CreateSessionRequest): Promise<Session> {
    const id = crypto.randomUUID();
    const permissionMode = opts.permissionMode ?? 'default';
    this.services.agentManager.ensureSession(id, { permissionMode, cwd: opts.cwd });
    const now = new Date().toISOString();
    return {
      id,
      title: `Session ${id.slice(0, 8)}`,
      createdAt: now,
      updatedAt: now,
      permissionMode,
      cwd: opts.cwd,
    };
  }

  async listSessions(cwd?: string): Promise<Session[]> {
    return this.services.transcriptReader.listSessions(cwd || this.services.vaultRoot);
  }

  async getSession(id: string, cwd?: string): Promise<Session> {
    const session = await this.services.transcriptReader.getSession(
      cwd || this.services.vaultRoot,
      id
    );
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }
    return session;
  }

  async updateSession(id: string, opts: UpdateSessionRequest, cwd?: string): Promise<Session> {
    const updated = this.services.agentManager.updateSession(id, opts);
    if (!updated) throw new Error(`Session not found: ${id}`);
    return this.getSession(id, cwd);
  }

  async getMessages(sessionId: string, cwd?: string): Promise<{ messages: HistoryMessage[] }> {
    const messages = await this.services.transcriptReader.readTranscript(
      cwd || this.services.vaultRoot,
      sessionId
    );
    return { messages };
  }

  async sendMessage(
    sessionId: string,
    content: string,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal,
    cwd?: string
  ): Promise<void> {
    const generator = this.services.agentManager.sendMessage(
      sessionId,
      content,
      ...(cwd ? [{ cwd }] : [])
    );
    for await (const event of generator) {
      if (signal?.aborted) break;
      onEvent(event);
    }
  }

  async approveTool(sessionId: string, toolCallId: string): Promise<{ ok: boolean }> {
    const result = this.services.agentManager.approveTool(sessionId, toolCallId, true);
    return { ok: result };
  }

  async denyTool(sessionId: string, toolCallId: string): Promise<{ ok: boolean }> {
    const result = this.services.agentManager.approveTool(sessionId, toolCallId, false);
    return { ok: result };
  }

  async submitAnswers(
    sessionId: string,
    toolCallId: string,
    answers: Record<string, string>
  ): Promise<{ ok: boolean }> {
    const ok = this.services.agentManager.submitAnswers(sessionId, toolCallId, answers);
    return { ok };
  }

  async getTasks(sessionId: string, cwd?: string): Promise<{ tasks: TaskItem[] }> {
    const tasks = await this.services.transcriptReader.readTasks(
      cwd || this.services.vaultRoot,
      sessionId
    );
    return { tasks };
  }

  async browseDirectory(dirPath?: string, showHidden?: boolean): Promise<BrowseDirectoryResponse> {
    // In Obsidian/Electron, use direct filesystem access
    // This is a simplified implementation — the full security checks
    // are in the server route. For DirectTransport, we trust the local env.
    const fs = await import('fs/promises');
    const pathMod = await import('path');
    const os = await import('os');

    const HOME = os.default.homedir();
    const targetPath = dirPath || HOME;
    const resolved = await fs.default.realpath(targetPath);

    if (!resolved.startsWith(HOME)) {
      throw new Error('Access denied: path outside home directory');
    }

    const dirents = await fs.default.readdir(resolved, { withFileTypes: true });
    const entries = dirents
      .filter((d) => d.isDirectory())
      .filter((d) => showHidden || !d.name.startsWith('.'))
      .map((d) => ({
        name: d.name,
        path: pathMod.default.join(resolved, d.name),
        isDirectory: true,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const parent = pathMod.default.dirname(resolved);
    const hasParent = parent !== resolved && parent.startsWith(HOME);

    return {
      path: resolved,
      entries,
      parent: hasParent ? parent : null,
    };
  }

  async getDefaultCwd(): Promise<{ path: string }> {
    return { path: this.services.vaultRoot };
  }

  async getCommands(refresh?: boolean, _cwd?: string): Promise<CommandRegistry> {
    return this.services.commandRegistry.getCommands(refresh);
  }

  async health(): Promise<HealthResponse> {
    return { status: 'ok', version: '0.1.0', uptime: 0 };
  }

  async listFiles(cwd: string): Promise<FileListResponse> {
    if (this.services.fileLister) {
      return this.services.fileLister.listFiles(cwd);
    }
    return { files: [], truncated: false, total: 0 };
  }

  async getGitStatus(cwd?: string): Promise<GitStatusResponse | GitStatusError> {
    if (this.services.gitStatus) {
      return this.services.gitStatus.getGitStatus(cwd || this.services.vaultRoot);
    }
    return { error: 'not_git_repo' as const };
  }

  async getConfig(): Promise<ServerConfig> {
    return {
      version: '0.1.0',
      latestVersion: null,
      port: 0,
      uptime: 0,
      workingDirectory: this.services.vaultRoot,
      nodeVersion: process.version,
      claudeCliPath: null,
      tunnel: {
        enabled: false,
        connected: false,
        url: null,
        authEnabled: false,
        tokenConfigured: false,
      },
      boundary: this.services.vaultRoot,
    };
  }

  async getModels(): Promise<ModelOption[]> {
    return [
      { value: 'claude-sonnet-4-5-20250929', displayName: 'Sonnet 4.5', description: 'Fast, intelligent model for everyday tasks' },
      { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Fastest, most compact model' },
      { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: 'Most capable model for complex tasks' },
    ];
  }

  async startTunnel(): Promise<{ url: string }> {
    throw new Error('Tunnel is not supported in embedded mode');
  }

  async stopTunnel(): Promise<void> {
    throw new Error('Tunnel is not supported in embedded mode');
  }

  // Pulse scheduler is not supported in embedded mode
  async listSchedules(): Promise<PulseSchedule[]> {
    return [];
  }

  async createSchedule(_opts: CreateScheduleInput): Promise<PulseSchedule> {
    throw new Error('Pulse scheduler is not supported in embedded mode');
  }

  async updateSchedule(_id: string, _opts: UpdateScheduleRequest): Promise<PulseSchedule> {
    throw new Error('Pulse scheduler is not supported in embedded mode');
  }

  async deleteSchedule(_id: string): Promise<{ success: boolean }> {
    throw new Error('Pulse scheduler is not supported in embedded mode');
  }

  async triggerSchedule(_id: string): Promise<{ runId: string }> {
    throw new Error('Pulse scheduler is not supported in embedded mode');
  }

  async listRuns(_opts?: Partial<ListRunsQuery>): Promise<PulseRun[]> {
    return [];
  }

  async getRun(_id: string): Promise<PulseRun> {
    throw new Error('Pulse scheduler is not supported in embedded mode');
  }

  async cancelRun(_id: string): Promise<{ success: boolean }> {
    throw new Error('Pulse scheduler is not supported in embedded mode');
  }

  // Relay message bus is not supported in embedded mode
  async listRelayMessages(): Promise<{ messages: unknown[]; nextCursor?: string }> {
    return { messages: [] };
  }

  async getRelayMessage(_id: string): Promise<unknown> {
    throw new Error('Relay is not supported in embedded mode');
  }

  async sendRelayMessage(): Promise<{ messageId: string; deliveredTo: number }> {
    throw new Error('Relay is not supported in embedded mode');
  }

  async listRelayEndpoints(): Promise<unknown[]> {
    return [];
  }

  async registerRelayEndpoint(): Promise<unknown> {
    throw new Error('Relay is not supported in embedded mode');
  }

  async unregisterRelayEndpoint(): Promise<{ success: boolean }> {
    throw new Error('Relay is not supported in embedded mode');
  }

  async readRelayInbox(): Promise<{ messages: unknown[]; nextCursor?: string }> {
    return { messages: [] };
  }

  async getRelayMetrics(): Promise<unknown> {
    return { totalMessages: 0, byStatus: {}, bySubject: [] };
  }

  async listRelayDeadLetters(_filters?: { endpointHash?: string }): Promise<unknown[]> {
    return [];
  }

  // Relay convergence is not supported in embedded mode
  async sendMessageRelay(
    _sessionId: string,
    _content: string,
    _options?: { clientId?: string },
  ): Promise<{ messageId: string; traceId: string }> {
    throw new Error('Relay is not supported in embedded mode');
  }

  async getRelayTrace(_messageId: string): Promise<{ traceId: string; spans: TraceSpan[] }> {
    throw new Error('Relay is not supported in embedded mode');
  }

  async getRelayDeliveryMetrics(): Promise<DeliveryMetrics> {
    throw new Error('Relay is not supported in embedded mode');
  }

  // Relay adapters are not supported in embedded mode
  async listRelayAdapters(): Promise<AdapterListItem[]> {
    return [];
  }

  async toggleRelayAdapter(_id: string, _enabled: boolean): Promise<{ ok: boolean }> {
    throw new Error('Relay adapters are not supported in embedded mode');
  }

  async getAdapterCatalog(): Promise<CatalogEntry[]> {
    return [];
  }

  async addRelayAdapter(_type: string, _id: string, _config: Record<string, unknown>): Promise<{ ok: boolean }> {
    throw new Error('Adapter management not supported in embedded mode');
  }

  async removeRelayAdapter(_id: string): Promise<{ ok: boolean }> {
    throw new Error('Adapter management not supported in embedded mode');
  }

  async updateRelayAdapterConfig(_id: string, _config: Record<string, unknown>): Promise<{ ok: boolean }> {
    throw new Error('Adapter management not supported in embedded mode');
  }

  async testRelayAdapterConnection(_type: string, _config: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    throw new Error('Adapter management not supported in embedded mode');
  }

  // Mesh agent discovery is not supported in embedded mode
  async discoverMeshAgents(_roots: string[], _maxDepth?: number): Promise<{ candidates: DiscoveryCandidate[] }> {
    throw new Error('Mesh is not supported in embedded mode');
  }

  async listMeshAgents(_filters?: { runtime?: string; capability?: string }): Promise<{ agents: AgentManifest[] }> {
    return { agents: [] };
  }

  async getMeshAgent(_id: string): Promise<AgentManifest> {
    throw new Error('Mesh is not supported in embedded mode');
  }

  async registerMeshAgent(_path: string, _overrides?: Partial<AgentManifest>, _approver?: string): Promise<AgentManifest> {
    throw new Error('Mesh is not supported in embedded mode');
  }

  async updateMeshAgent(_id: string, _updates: Partial<AgentManifest>): Promise<AgentManifest> {
    throw new Error('Mesh is not supported in embedded mode');
  }

  async unregisterMeshAgent(_id: string): Promise<{ success: boolean }> {
    throw new Error('Mesh is not supported in embedded mode');
  }

  async denyMeshAgent(_path: string, _reason?: string, _denier?: string): Promise<{ success: boolean }> {
    throw new Error('Mesh is not supported in embedded mode');
  }

  async listDeniedMeshAgents(): Promise<{ denied: DenialRecord[] }> {
    return { denied: [] };
  }

  async clearMeshDenial(_path: string): Promise<{ success: boolean }> {
    throw new Error('Mesh is not supported in embedded mode');
  }

  // Mesh observability is not supported in embedded mode
  async getMeshStatus(): Promise<MeshStatus> {
    throw new Error('Mesh is not supported in embedded mode');
  }

  async getMeshAgentHealth(_id: string): Promise<AgentHealth> {
    throw new Error('Mesh is not supported in embedded mode');
  }

  async sendMeshHeartbeat(_id: string, _event?: string): Promise<{ success: boolean }> {
    throw new Error('Mesh is not supported in embedded mode');
  }

  async getMeshTopology(_namespace?: string): Promise<TopologyView> {
    throw new Error('Mesh is not supported in embedded mode');
  }

  async updateMeshAccessRule(_body: UpdateAccessRuleRequest): Promise<CrossNamespaceRule> {
    throw new Error('Mesh is not supported in embedded mode');
  }

  async getMeshAgentAccess(_agentId: string): Promise<{ agents: AgentManifest[] }> {
    throw new Error('Mesh is not supported in embedded mode');
  }

  // --- Agent Identity ---

  async getAgentByPath(agentPath: string): Promise<AgentManifest | null> {
    const { readManifest } = await import('@dorkos/shared/manifest');
    return readManifest(agentPath);
  }

  async resolveAgents(paths: string[]): Promise<Record<string, AgentManifest | null>> {
    const { readManifest } = await import('@dorkos/shared/manifest');
    const result: Record<string, AgentManifest | null> = {};
    await Promise.all(
      paths.map(async (p) => {
        result[p] = await readManifest(p);
      })
    );
    return result;
  }

  async createAgent(
    agentPath: string,
    name?: string,
    description?: string,
    runtime?: string
  ): Promise<AgentManifest> {
    const { readManifest, writeManifest } = await import('@dorkos/shared/manifest');
    const pathMod = await import('path');
    const existing = await readManifest(agentPath);
    if (existing) return existing;

    const manifest: AgentManifest = {
      id: crypto.randomUUID(),
      name: name ?? pathMod.default.basename(agentPath),
      description: description ?? '',
      runtime: (runtime as AgentManifest['runtime']) ?? 'claude-code',
      capabilities: [],
      behavior: { responseMode: 'always' },
      budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
      registeredAt: new Date().toISOString(),
      registeredBy: 'dorkos-obsidian',
      personaEnabled: true,
    };
    await writeManifest(agentPath, manifest);
    return manifest;
  }

  async updateAgentByPath(agentPath: string, updates: Partial<AgentManifest>): Promise<AgentManifest> {
    const { readManifest, writeManifest } = await import('@dorkos/shared/manifest');
    const existing = await readManifest(agentPath);
    if (!existing) throw new Error(`No agent registered at path: ${agentPath}`);
    const updated: AgentManifest = { ...existing, ...updates };
    await writeManifest(agentPath, updated);
    return updated;
  }
}
