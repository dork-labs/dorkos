import type {
  Session,
  CreateSessionRequest,
  UpdateSessionRequest,
  BrowseDirectoryResponse,
  CommandRegistry,
  HistoryMessage,
  StreamEvent,
  TaskItem,
} from '@lifeos/shared/types';
import type { Transport } from '@lifeos/shared/transport';

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
  constructor(private baseUrl: string) {}

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

  updateSession(id: string, opts: UpdateSessionRequest): Promise<Session> {
    return fetchJSON<Session>(this.baseUrl, `/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(opts),
    });
  }

  getMessages(sessionId: string, cwd?: string): Promise<{ messages: HistoryMessage[] }> {
    const params = new URLSearchParams();
    if (cwd) params.set('cwd', cwd);
    const qs = params.toString();
    return fetchJSON<{ messages: HistoryMessage[] }>(this.baseUrl, `/sessions/${sessionId}/messages${qs ? `?${qs}` : ''}`);
  }

  async sendMessage(
    sessionId: string,
    content: string,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await fetch(`${this.baseUrl}/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
      signal,
    });

    if (!response.ok) {
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

  getCommands(refresh = false): Promise<CommandRegistry> {
    return fetchJSON<CommandRegistry>(this.baseUrl, `/commands${refresh ? '?refresh=true' : ''}`);
  }

  health(): Promise<{ status: string; version: string; uptime: number }> {
    return fetchJSON<{ status: string; version: string; uptime: number }>(this.baseUrl, '/health');
  }
}
