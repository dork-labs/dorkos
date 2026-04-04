/**
 * Session Transport methods factory — session CRUD, message history, streaming, and tool interactions.
 *
 * @module shared/lib/transport/session-methods
 */
import type {
  Session,
  UpdateSessionRequest,
  HistoryMessage,
  StreamEvent,
  TaskItem,
  SessionLockedError,
  ReloadPluginsResult,
} from '@dorkos/shared/types';
import type { UiState } from '@dorkos/shared/types';
import { fetchJSON, buildQueryString } from './http-client';
import { parseSSEStream } from './sse-parser';

// Interaction requests use a longer timeout (10 min) to match the server-side
// INTERACTION_TIMEOUT_MS. The default 30s fetchJSON timeout is too aggressive
// because these requests can be queued by the browser when SSE connections
// consume the HTTP/1.1 per-origin connection limit (6 in Chrome).
const INTERACTION_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Create all session-related methods bound to a base URL.
 *
 * @param baseUrl - Server base URL
 * @param getClientId - Accessor for the transport's client ID (used for session locking)
 * @param etagCache - Shared Map for message ETag caching
 * @param messageCache - Shared Map for message response caching
 */
export function createSessionMethods(
  baseUrl: string,
  getClientId: () => string,
  etagCache: Map<string, string>,
  messageCache: Map<string, { messages: HistoryMessage[] }>
) {
  return {
    // ── Session CRUD ────────────────────────────────────────────────────────

    listSessions(cwd?: string): Promise<Session[]> {
      const qs = buildQueryString({ cwd });
      return fetchJSON<Session[]>(baseUrl, `/sessions${qs}`);
    },

    getSession(id: string, cwd?: string): Promise<Session> {
      const qs = buildQueryString({ cwd });
      return fetchJSON<Session>(baseUrl, `/sessions/${id}${qs}`);
    },

    updateSession(id: string, opts: UpdateSessionRequest, cwd?: string): Promise<Session> {
      const qs = buildQueryString({ cwd });
      return fetchJSON<Session>(baseUrl, `/sessions/${id}${qs}`, {
        method: 'PATCH',
        body: JSON.stringify(opts),
      });
    },

    forkSession(
      id: string,
      opts?: { upToMessageId?: string; title?: string },
      cwd?: string
    ): Promise<Session> {
      const qs = buildQueryString({ cwd });
      return fetchJSON<Session>(baseUrl, `/sessions/${id}/fork${qs}`, {
        method: 'POST',
        body: JSON.stringify(opts ?? {}),
      });
    },

    reloadPlugins(sessionId: string): Promise<ReloadPluginsResult> {
      return fetchJSON<ReloadPluginsResult>(baseUrl, `/sessions/${sessionId}/reload-plugins`, {
        method: 'POST',
      });
    },

    // ── Message History (ETag caching) ────────────────────────────────────

    async getMessages(sessionId: string, cwd?: string): Promise<{ messages: HistoryMessage[] }> {
      const qs = buildQueryString({ cwd });
      const url = `/sessions/${sessionId}/messages${qs}`;

      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      const cachedEtag = etagCache.get(sessionId);
      if (cachedEtag) headers['If-None-Match'] = cachedEtag;

      const res = await fetch(`${baseUrl}${url}`, { headers });

      if (res.status === 304) {
        const cached = messageCache.get(sessionId);
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
        etagCache.set(sessionId, etag);
        messageCache.set(sessionId, data);
      }
      return data;
    },

    // ── Message Streaming (SSE) ────────────────────────────────────────────

    async sendMessage(
      sessionId: string,
      content: string,
      onEvent: (event: StreamEvent) => void,
      signal?: AbortSignal,
      cwd?: string,
      options?: { clientMessageId?: string; uiState?: UiState }
    ): Promise<void> {
      const body: Record<string, unknown> = { content };
      if (cwd) body.cwd = cwd;
      if (options?.clientMessageId) body.clientMessageId = options.clientMessageId;
      if (options?.uiState) body.uiState = options.uiState;

      const response = await fetch(`${baseUrl}/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': getClientId(),
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        if (response.status === 409) {
          const errorData = (await response.json().catch(() => null)) as SessionLockedError | null;
          if (errorData?.code === 'SESSION_LOCKED') {
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
    },

    // ── Tool Approval ──────────────────────────────────────────────────────

    approveTool(sessionId: string, toolCallId: string): Promise<{ ok: boolean }> {
      return fetchJSON<{ ok: boolean }>(baseUrl, `/sessions/${sessionId}/approve`, {
        method: 'POST',
        body: JSON.stringify({ toolCallId }),
        timeout: INTERACTION_TIMEOUT_MS,
      });
    },

    denyTool(sessionId: string, toolCallId: string): Promise<{ ok: boolean }> {
      return fetchJSON<{ ok: boolean }>(baseUrl, `/sessions/${sessionId}/deny`, {
        method: 'POST',
        body: JSON.stringify({ toolCallId }),
        timeout: INTERACTION_TIMEOUT_MS,
      });
    },

    submitAnswers(
      sessionId: string,
      toolCallId: string,
      answers: Record<string, string>
    ): Promise<{ ok: boolean }> {
      return fetchJSON<{ ok: boolean }>(baseUrl, `/sessions/${sessionId}/submit-answers`, {
        method: 'POST',
        body: JSON.stringify({ toolCallId, answers }),
        timeout: INTERACTION_TIMEOUT_MS,
      });
    },

    submitElicitation(
      sessionId: string,
      interactionId: string,
      action: 'accept' | 'decline' | 'cancel',
      content?: Record<string, unknown>
    ): Promise<{ ok: boolean }> {
      return fetchJSON<{ ok: boolean }>(baseUrl, `/sessions/${sessionId}/submit-elicitation`, {
        method: 'POST',
        body: JSON.stringify({ interactionId, action, content }),
        timeout: INTERACTION_TIMEOUT_MS,
      });
    },

    /** Stop a running background task. */
    stopTask(sessionId: string, taskId: string): Promise<{ success: boolean; taskId: string }> {
      return fetchJSON<{ success: boolean; taskId: string }>(
        baseUrl,
        `/sessions/${sessionId}/tasks/${taskId}/stop`,
        { method: 'POST' }
      );
    },

    /** Interrupt the active query for a session (best-effort, short timeout). */
    interruptSession(sessionId: string): Promise<{ ok: boolean }> {
      return fetchJSON<{ ok: boolean }>(baseUrl, `/sessions/${sessionId}/interrupt`, {
        method: 'POST',
        timeout: 5_000,
      });
    },

    async getTasks(sessionId: string, cwd?: string): Promise<{ tasks: TaskItem[] }> {
      try {
        const qs = buildQueryString({ cwd });
        return await fetchJSON<{ tasks: TaskItem[] }>(baseUrl, `/sessions/${sessionId}/tasks${qs}`);
      } catch {
        return { tasks: [] };
      }
    },
  };
}
