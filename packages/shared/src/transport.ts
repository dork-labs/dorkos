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
} from './types.js';

export interface Transport {
  createSession(opts: CreateSessionRequest): Promise<Session>;
  listSessions(cwd?: string): Promise<Session[]>;
  getSession(id: string, cwd?: string): Promise<Session>;
  updateSession(id: string, opts: UpdateSessionRequest): Promise<Session>;
  getMessages(sessionId: string, cwd?: string): Promise<{ messages: HistoryMessage[] }>;
  sendMessage(
    sessionId: string,
    content: string,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal,
    cwd?: string,
  ): Promise<void>;
  approveTool(
    sessionId: string,
    toolCallId: string,
  ): Promise<{ ok: boolean }>;
  denyTool(
    sessionId: string,
    toolCallId: string,
  ): Promise<{ ok: boolean }>;
  submitAnswers(
    sessionId: string,
    toolCallId: string,
    answers: Record<string, string>,
  ): Promise<{ ok: boolean }>;
  getTasks(sessionId: string, cwd?: string): Promise<{ tasks: TaskItem[] }>;
  browseDirectory(dirPath?: string, showHidden?: boolean): Promise<BrowseDirectoryResponse>;
  getDefaultCwd(): Promise<{ path: string }>;
  getCommands(refresh?: boolean): Promise<CommandRegistry>;
  health(): Promise<HealthResponse>;
  getConfig(): Promise<ServerConfig>;
}
