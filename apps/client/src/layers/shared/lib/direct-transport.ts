import type { Transport } from '@dorkos/shared/transport';
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
  GitStatusResponse,
  GitStatusError,
} from '@dorkos/shared/types';

export interface DirectTransportServices {
  agentManager: {
    ensureSession(
      id: string,
      opts: { permissionMode: PermissionMode; cwd?: string },
    ): void;
    sendMessage(
      id: string,
      content: string,
      opts?: { permissionMode?: PermissionMode; cwd?: string },
    ): AsyncGenerator<StreamEvent>;
    approveTool(
      sessionId: string,
      toolCallId: string,
      approved: boolean,
    ): boolean;
    submitAnswers(
      sessionId: string,
      toolCallId: string,
      answers: Record<string, string>,
    ): boolean;
    updateSession(
      sessionId: string,
      opts: { permissionMode?: PermissionMode; model?: string },
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
    return this.services.transcriptReader.listSessions(
      cwd || this.services.vaultRoot,
    );
  }

  async getSession(id: string, cwd?: string): Promise<Session> {
    const session = await this.services.transcriptReader.getSession(
      cwd || this.services.vaultRoot,
      id,
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

  async getMessages(
    sessionId: string,
    cwd?: string,
  ): Promise<{ messages: HistoryMessage[] }> {
    const messages = await this.services.transcriptReader.readTranscript(
      cwd || this.services.vaultRoot,
      sessionId,
    );
    return { messages };
  }

  async sendMessage(
    sessionId: string,
    content: string,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal,
    cwd?: string,
  ): Promise<void> {
    const generator = this.services.agentManager.sendMessage(
      sessionId,
      content,
      ...(cwd ? [{ cwd }] : []),
    );
    for await (const event of generator) {
      if (signal?.aborted) break;
      onEvent(event);
    }
  }

  async approveTool(
    sessionId: string,
    toolCallId: string,
  ): Promise<{ ok: boolean }> {
    const result = this.services.agentManager.approveTool(
      sessionId,
      toolCallId,
      true,
    );
    return { ok: result };
  }

  async denyTool(
    sessionId: string,
    toolCallId: string,
  ): Promise<{ ok: boolean }> {
    const result = this.services.agentManager.approveTool(
      sessionId,
      toolCallId,
      false,
    );
    return { ok: result };
  }

  async submitAnswers(
    sessionId: string,
    toolCallId: string,
    answers: Record<string, string>,
  ): Promise<{ ok: boolean }> {
    const ok = this.services.agentManager.submitAnswers(
      sessionId,
      toolCallId,
      answers,
    );
    return { ok };
  }

  async getTasks(sessionId: string, cwd?: string): Promise<{ tasks: TaskItem[] }> {
    const tasks = await this.services.transcriptReader.readTasks(
      cwd || this.services.vaultRoot,
      sessionId,
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
      .filter(d => d.isDirectory())
      .filter(d => showHidden || !d.name.startsWith('.'))
      .map(d => ({
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
    };
  }
}
