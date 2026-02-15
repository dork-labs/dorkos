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
} from '@dorkos/shared/types';
import type { Transport } from '@dorkos/shared/transport';

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
    cwd?: string,
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
        const errorData = await response.json().catch(() => null) as SessionLockedError | null;
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

  submitAnswers(sessionId: string, toolCallId: string, answers: Record<string, string>): Promise<{ ok: boolean }> {
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
      return await fetchJSON<{ tasks: TaskItem[] }>(this.baseUrl, `/sessions/${sessionId}/tasks${qs ? `?${qs}` : ''}`);
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
      `/git/status${qs ? `?${qs}` : ''}`,
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
}
