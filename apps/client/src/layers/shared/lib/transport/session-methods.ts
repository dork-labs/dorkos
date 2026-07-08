/**
 * Session Transport methods factory — session CRUD, message history, streaming, and tool interactions.
 *
 * @module shared/lib/transport/session-methods
 */
import type {
  Session,
  SessionListResponse,
  UpdateSessionRequest,
  HistoryMessage,
  TaskItem,
  SessionLockedError,
  ReloadPluginsResult,
} from '@dorkos/shared/types';
import type { ClaudePluginTransport } from '@dorkos/shared/transport';
import type {
  UiActionRequest,
  McpAppResourceRequest,
  McpAppResourceResponse,
} from '@dorkos/shared/schemas';
import type { ClientContext } from '@dorkos/shared/additional-context';
import { fetchJSON, buildQueryString } from './http-client';

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

    listSessions(cwd?: string): Promise<SessionListResponse> {
      const qs = buildQueryString({ cwd });
      // Aggregated-list envelope (ADR-0310): { sessions, warnings? }.
      return fetchJSON<SessionListResponse>(baseUrl, `/sessions${qs}`);
    },

    getSession(id: string, cwd?: string): Promise<Session> {
      const qs = buildQueryString({ cwd });
      return fetchJSON<Session>(baseUrl, `/sessions/${id}${qs}`);
    },

    async getSessionRuntimeType(sessionId: string): Promise<string> {
      const res = await fetchJSON<{ runtime: string }>(
        baseUrl,
        `/sessions/${sessionId}/runtime-type`
      );
      return res.runtime;
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

    /**
     * Obtain a Claude-specific plugin sub-transport for a session.
     *
     * The HTTP transport does not know the active session's runtime at
     * invocation time, so this returns a concrete `ClaudePluginTransport` for
     * any sessionId. The server route rejects non-Claude runtimes with a 501
     * (`NOT_SUPPORTED`) and callers should still gate on `supportsPlugins`.
     */
    asClaudePluginTransport(sessionId: string): ClaudePluginTransport {
      return {
        reloadPlugins(): Promise<ReloadPluginsResult> {
          return fetchJSON<ReloadPluginsResult>(baseUrl, `/sessions/${sessionId}/reload-plugins`, {
            method: 'POST',
          });
        },
      };
    },

    // ── Message History (ETag caching) ────────────────────────────────────

    async getMessages(sessionId: string, cwd?: string): Promise<{ messages: HistoryMessage[] }> {
      const qs = buildQueryString({ cwd });
      const url = `/sessions/${sessionId}/messages${qs}`;

      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      const cachedEtag = etagCache.get(sessionId);
      if (cachedEtag) headers['If-None-Match'] = cachedEtag;

      const res = await fetch(`${baseUrl}${url}`, { headers, credentials: 'include' });

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

    // ── Message Trigger (202, out-of-band delivery via /events) ────────────

    async postMessage(
      sessionId: string,
      content: string,
      cwd?: string,
      options?: { clientMessageId?: string; context?: ClientContext; runtime?: string }
    ): Promise<{ sessionId: string }> {
      const body: Record<string, unknown> = { content };
      if (cwd) body.cwd = cwd;
      if (options?.clientMessageId) body.clientMessageId = options.clientMessageId;
      if (options?.context) body.context = options.context;
      if (options?.runtime) body.runtime = options.runtime;

      const response = await fetch(`${baseUrl}/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': getClientId(),
        },
        credentials: 'include',
        body: JSON.stringify(body),
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

      // Trigger-only contract: the turn streams over /events. The body carries
      // the SDK-canonical id (which may differ from the client UUID for a
      // brand-new session — create-on-first-message).
      const data = (await response.json().catch(() => ({}))) as { sessionId?: string };
      return { sessionId: data.sessionId ?? sessionId };
    },

    // ── Generative-UI Interactivity ───────────────────────────────────────

    /**
     * Dispatch a widget `agent`-kind action via `POST /sessions/:id/ui-action`
     * (spec gen-ui-tier1 §3). Trigger-only, identical to `postMessage`: the
     * server injects a `<ui_action>` block as the next user turn, the 202 body
     * carries the canonical session id, and the turn streams over `/events`.
     * Throws a typed `SESSION_LOCKED` error on 409 when a turn is running.
     */
    async sendUiAction(sessionId: string, action: UiActionRequest): Promise<{ sessionId: string }> {
      const response = await fetch(`${baseUrl}/sessions/${sessionId}/ui-action`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': getClientId(),
        },
        credentials: 'include',
        body: JSON.stringify(action),
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

      // Trigger-only contract, identical to postMessage: the turn streams over
      // /events; the body carries the SDK-canonical id.
      const data = (await response.json().catch(() => ({}))) as { sessionId?: string };
      return { sessionId: data.sessionId ?? sessionId };
    },

    // ── MCP Apps (SEP-1865) ────────────────────────────────────────────────

    /**
     * Read a `ui://` MCP App resource for sandboxed rendering. The server opens
     * its own short-lived MCP client (config never leaves the server) and
     * returns the HTML plus sandbox metadata. See spec `mcp-apps-host` §2.1.
     */
    fetchMcpAppResource(
      sessionId: string,
      request: McpAppResourceRequest
    ): Promise<McpAppResourceResponse> {
      return fetchJSON<McpAppResourceResponse>(baseUrl, `/sessions/${sessionId}/mcp-app/resource`, {
        method: 'POST',
        body: JSON.stringify(request),
      });
    },

    // ── Tool Approval ──────────────────────────────────────────────────────

    approveTool(
      sessionId: string,
      toolCallId: string,
      alwaysAllow?: boolean
    ): Promise<{ ok: boolean }> {
      return fetchJSON<{ ok: boolean }>(baseUrl, `/sessions/${sessionId}/approve`, {
        method: 'POST',
        body: JSON.stringify({ toolCallId, alwaysAllow: alwaysAllow || undefined }),
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

    batchApprove(
      sessionId: string,
      toolCallIds: string[]
    ): Promise<{ results: { toolCallId: string; ok: boolean }[] }> {
      return fetchJSON(baseUrl, `/sessions/${sessionId}/batch-approve`, {
        method: 'POST',
        body: JSON.stringify({ toolCallIds }),
        timeout: INTERACTION_TIMEOUT_MS,
      });
    },

    batchDeny(
      sessionId: string,
      toolCallIds: string[]
    ): Promise<{ results: { toolCallId: string; ok: boolean }[] }> {
      return fetchJSON(baseUrl, `/sessions/${sessionId}/batch-deny`, {
        method: 'POST',
        body: JSON.stringify({ toolCallIds }),
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
