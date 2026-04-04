import type { Transport, UploadFile } from '@dorkos/shared/transport';
import type { TemplateEntry } from '@dorkos/shared/template-catalog';
import type { RuntimeCapabilities, SystemRequirements } from '@dorkos/shared/agent-runtime';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type {
  StreamEvent,
  Session,
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
  UploadResult,
  UploadProgress,
} from '@dorkos/shared/types';
import {
  tasksStubs,
  relayStubs,
  adapterStubs,
  bindingStubs,
  meshStubs,
  serverOnlyStubs,
  activityStubs,
} from './embedded-mode-stubs';

export interface DirectTransportServices {
  runtime: {
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
    getCapabilities(): RuntimeCapabilities;
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

/**
 * In-process Transport adapter for the Obsidian plugin.
 *
 * Core session/command methods delegate to injected services.
 * Tasks, Relay, Mesh, and other server-only subsystems use stub
 * implementations from `embedded-mode-stubs.ts`.
 */
export class DirectTransport implements Transport {
  constructor(private services: DirectTransportServices) {}

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
    const updated = this.services.runtime.updateSession(id, opts);
    if (!updated) throw new Error(`Session not found: ${id}`);
    return this.getSession(id, cwd);
  }

  async forkSession(
    _id: string,
    _opts?: { upToMessageId?: string; title?: string },
    _cwd?: string
  ): Promise<Session> {
    throw new Error('Session forking is not supported in DirectTransport');
  }

  async reloadPlugins(): Promise<never> {
    throw new Error('Plugin reload is not supported in DirectTransport');
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
    cwd?: string,
    _options?: { clientMessageId?: string; uiState?: import('@dorkos/shared/types').UiState }
  ): Promise<void> {
    const generator = this.services.runtime.sendMessage(
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
    const result = this.services.runtime.approveTool(sessionId, toolCallId, true);
    return { ok: result };
  }

  async denyTool(sessionId: string, toolCallId: string): Promise<{ ok: boolean }> {
    const result = this.services.runtime.approveTool(sessionId, toolCallId, false);
    return { ok: result };
  }

  async submitAnswers(
    sessionId: string,
    toolCallId: string,
    answers: Record<string, string>
  ): Promise<{ ok: boolean }> {
    const ok = this.services.runtime.submitAnswers(sessionId, toolCallId, answers);
    return { ok };
  }

  async submitElicitation(
    sessionId: string,
    interactionId: string,
    action: 'accept' | 'decline' | 'cancel',
    _content?: Record<string, unknown>
  ): Promise<{ ok: boolean }> {
    // DirectTransport runtime interface predates elicitation — use structural check
    const runtime = this.services.runtime as {
      submitElicitation?: (
        s: string,
        i: string,
        a: 'accept' | 'decline' | 'cancel',
        c?: Record<string, unknown>
      ) => boolean;
    };
    if (typeof runtime.submitElicitation !== 'function') {
      return { ok: false };
    }
    const ok = runtime.submitElicitation(sessionId, interactionId, action, _content);
    return { ok };
  }

  /** Stop a running background task. DirectTransport delegates to the in-process runtime if supported. */
  async stopTask(sessionId: string, taskId: string): Promise<{ success: boolean; taskId: string }> {
    try {
      // The DirectTransport runtime interface predates stopTask — use a structural check
      // to forward the call only when the method is present (Obsidian plugin compatibility).
      const runtime = this.services.runtime as {
        stopTask?: (s: string, t: string) => Promise<boolean>;
      };
      if (typeof runtime.stopTask !== 'function') {
        return { success: false, taskId };
      }
      const success = await runtime.stopTask(sessionId, taskId);
      return { success, taskId };
    } catch {
      return { success: false, taskId };
    }
  }

  /** Interrupt the active query. DirectTransport delegates to the in-process runtime if supported. */
  async interruptSession(sessionId: string): Promise<{ ok: boolean }> {
    try {
      const runtime = this.services.runtime as {
        interruptQuery?: (s: string) => Promise<boolean>;
      };
      if (typeof runtime.interruptQuery !== 'function') {
        return { ok: false };
      }
      const ok = await runtime.interruptQuery(sessionId);
      return { ok };
    } catch {
      return { ok: false };
    }
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
      isDevMode: true,
      dismissedUpgradeVersions: [],
      port: 0,
      uptime: 0,
      workingDirectory: this.services.vaultRoot,
      nodeVersion: process.version,
      claudeCliPath: null,
      tunnel: {
        enabled: false,
        connected: false,
        url: null,
        port: null,
        startedAt: null,
        authEnabled: false,
        tokenConfigured: false,
        domain: null,
        passcodeEnabled: false,
      },
      boundary: this.services.vaultRoot,
    };
  }

  async getModels(): Promise<ModelOption[]> {
    return [
      {
        value: 'claude-sonnet-4-5-20250929',
        displayName: 'Sonnet 4.5',
        description: 'Fast, intelligent model for everyday tasks',
      },
      {
        value: 'claude-haiku-4-5-20251001',
        displayName: 'Haiku 4.5',
        description: 'Fastest, most compact model',
      },
      {
        value: 'claude-opus-4-6',
        displayName: 'Opus 4.6',
        description: 'Most capable model for complex tasks',
      },
    ];
  }

  async getSubagents(): Promise<import('@dorkos/shared/types').SubagentInfo[]> {
    return [];
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

  async initAgent(
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
      enabledToolGroups: {},
    };
    await writeManifest(agentPath, manifest);
    return manifest;
  }

  async updateAgentByPath(
    agentPath: string,
    updates: Partial<AgentManifest>
  ): Promise<AgentManifest> {
    const { readManifest, writeManifest } = await import('@dorkos/shared/manifest');
    const existing = await readManifest(agentPath);
    if (!existing) throw new Error(`No agent registered at path: ${agentPath}`);
    const updated: AgentManifest = { ...existing, ...updates };
    await writeManifest(agentPath, updated);
    return updated;
  }

  async getCapabilities(): Promise<{
    capabilities: Record<string, RuntimeCapabilities>;
    defaultRuntime: string;
  }> {
    // Delegate to the runtime's getCapabilities() and wrap for the transport response shape.
    const caps = this.services.runtime.getCapabilities();
    return {
      capabilities: { [caps.type]: caps },
      defaultRuntime: caps.type,
    };
  }

  async checkRequirements(): Promise<SystemRequirements> {
    const runtime = this.services.runtime;
    const deps =
      'checkDependencies' in runtime
        ? await (runtime as { checkDependencies(): Promise<unknown[]> }).checkDependencies()
        : [];
    const runtimes = {
      [runtime.getCapabilities().type]: {
        dependencies: deps as SystemRequirements['runtimes'][string]['dependencies'],
      },
    };
    const allSatisfied = Object.values(runtimes).every((r) =>
      r.dependencies.every((d) => d.status === 'satisfied')
    );
    return { runtimes, allSatisfied };
  }

  // --- Directory Operations ---

  /** Create a new directory using direct filesystem access. */
  async createDirectory(parentPath: string, folderName: string): Promise<{ path: string }> {
    const fs = await import('fs/promises');
    const pathMod = await import('path');
    const newDirPath = pathMod.default.join(parentPath, folderName);

    try {
      await fs.default.access(newDirPath);
      throw new Error('Directory already exists');
    } catch (err: unknown) {
      if (err instanceof Error && err.message === 'Directory already exists') throw err;
      // Expected — directory does not exist yet
    }

    await fs.default.mkdir(newDirPath, { recursive: true });
    return { path: newDirPath };
  }

  // --- File Uploads ---

  /** Upload files to `{cwd}/.dork/.temp/uploads/` using direct filesystem access. */
  async uploadFiles(
    files: UploadFile[],
    cwd: string,
    _onProgress?: (progress: UploadProgress) => void
  ): Promise<UploadResult[]> {
    const fs = await import('fs/promises');
    const pathMod = await import('path');
    const { randomUUID } = await import('crypto');

    const uploadDir = pathMod.default.join(cwd, '.dork', '.temp', 'uploads');
    await fs.default.mkdir(uploadDir, { recursive: true });

    const results: UploadResult[] = [];
    for (const file of files) {
      const base = pathMod.default.basename(file.name);
      const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_');
      const filename = `${randomUUID().slice(0, 8)}-${safe}`;
      const savedPath = pathMod.default.join(uploadDir, filename);

      const buffer = Buffer.from(await file.arrayBuffer());
      await fs.default.writeFile(savedPath, buffer);

      results.push({
        originalName: file.name,
        savedPath,
        filename,
        size: file.size,
        mimeType: file.type,
      });
    }

    return results;
  }

  // --- Templates ---

  async getTemplates(): Promise<TemplateEntry[]> {
    const { DEFAULT_TEMPLATES } = await import('@dorkos/shared/template-catalog');
    return DEFAULT_TEMPLATES;
  }

  // --- Embedded mode stubs (Tasks, Relay, Mesh, etc.) ---
  // These subsystems are server-only. See embedded-mode-stubs.ts for implementations.

  startTunnel = serverOnlyStubs.startTunnel;
  stopTunnel = serverOnlyStubs.stopTunnel;
  verifyTunnelPasscode = serverOnlyStubs.verifyTunnelPasscode;
  checkTunnelSession = serverOnlyStubs.checkTunnelSession;
  setTunnelPasscode = serverOnlyStubs.setTunnelPasscode;
  updateConfig = serverOnlyStubs.updateConfig;
  getMcpConfig = serverOnlyStubs.getMcpConfig;
  resetAllData = serverOnlyStubs.resetAllData;
  restartServer = serverOnlyStubs.restartServer;
  scan = serverOnlyStubs.scan;
  createAgent = serverOnlyStubs.createAgent;
  setDefaultAgent = serverOnlyStubs.setDefaultAgent;

  listTasks = tasksStubs.listTasks;
  createTask = tasksStubs.createTask;
  updateTask = tasksStubs.updateTask;
  deleteTask = tasksStubs.deleteTask;
  triggerTask = tasksStubs.triggerTask;
  listTaskRuns = tasksStubs.listTaskRuns;
  getTaskRun = tasksStubs.getTaskRun;
  cancelTaskRun = tasksStubs.cancelTaskRun;
  getTaskTemplates = tasksStubs.getTaskTemplates;

  listRelayMessages = relayStubs.listRelayMessages;
  getRelayMessage = relayStubs.getRelayMessage;
  sendRelayMessage = relayStubs.sendRelayMessage;
  listRelayEndpoints = relayStubs.listRelayEndpoints;
  registerRelayEndpoint = relayStubs.registerRelayEndpoint;
  unregisterRelayEndpoint = relayStubs.unregisterRelayEndpoint;
  readRelayInbox = relayStubs.readRelayInbox;
  getRelayMetrics = relayStubs.getRelayMetrics;
  listRelayDeadLetters = relayStubs.listRelayDeadLetters;
  listAggregatedDeadLetters = relayStubs.listAggregatedDeadLetters;
  dismissDeadLetterGroup = relayStubs.dismissDeadLetterGroup;
  listRelayConversations = relayStubs.listRelayConversations;
  sendMessageRelay = relayStubs.sendMessageRelay;
  getRelayTrace = relayStubs.getRelayTrace;
  getRelayDeliveryMetrics = relayStubs.getRelayDeliveryMetrics;

  listRelayAdapters = adapterStubs.listRelayAdapters;
  toggleRelayAdapter = adapterStubs.toggleRelayAdapter;
  getAdapterCatalog = adapterStubs.getAdapterCatalog;
  addRelayAdapter = adapterStubs.addRelayAdapter;
  removeRelayAdapter = adapterStubs.removeRelayAdapter;
  updateRelayAdapterConfig = adapterStubs.updateRelayAdapterConfig;
  testRelayAdapterConnection = adapterStubs.testRelayAdapterConnection;
  getAdapterEvents = adapterStubs.getAdapterEvents;
  getObservedChats = adapterStubs.getObservedChats;

  getBindings = bindingStubs.getBindings;
  createBinding = bindingStubs.createBinding;
  deleteBinding = bindingStubs.deleteBinding;
  updateBinding = bindingStubs.updateBinding;

  listActivityEvents = activityStubs.listActivityEvents;

  listMeshAgentPaths = meshStubs.listMeshAgentPaths;
  discoverMeshAgents = meshStubs.discoverMeshAgents;
  listMeshAgents = meshStubs.listMeshAgents;
  getMeshAgent = meshStubs.getMeshAgent;
  registerMeshAgent = meshStubs.registerMeshAgent;
  updateMeshAgent = meshStubs.updateMeshAgent;
  unregisterMeshAgent = meshStubs.unregisterMeshAgent;
  denyMeshAgent = meshStubs.denyMeshAgent;
  listDeniedMeshAgents = meshStubs.listDeniedMeshAgents;
  clearMeshDenial = meshStubs.clearMeshDenial;
  getMeshStatus = meshStubs.getMeshStatus;
  getMeshAgentHealth = meshStubs.getMeshAgentHealth;
  sendMeshHeartbeat = meshStubs.sendMeshHeartbeat;
  getMeshTopology = meshStubs.getMeshTopology;
  updateMeshAccessRule = meshStubs.updateMeshAccessRule;
  getMeshAgentAccess = meshStubs.getMeshAgentAccess;
}
