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
  DevtoolsIngest,
  RecentSessionsResponse,
  SessionDailyCountsResponse,
  MessageDisposition,
  QueueMoveTarget,
  QueuedMessage,
  UpdateQueuedMessageResponse,
  SessionQueueResponse,
} from '@dorkos/shared/schemas';
import {
  RecentSessionsResponseSchema,
  SessionDailyCountsResponseSchema,
  SendMessageResponseSchema,
  UpdateQueuedMessageResponseSchema,
  SessionQueueResponseSchema,
} from '@dorkos/shared/schemas';
import type { ClientContext } from '@dorkos/shared/additional-context';
import type { RuntimeCommandIntentId } from '@dorkos/shared/command-intents';
import { COMMAND_INTENT_REQUEST_TIMEOUT_MS } from '@dorkos/shared/command-intents';
import { fetchJSON, buildQueryString } from './http-client';

// Interaction requests use a longer timeout (10 min) to match the server-side
// INTERACTION_TIMEOUT_MS: an approval or a question waits on a person, and the
// default 30s fetchJSON timeout would give up on them.
//
// It was ALSO justified by the browser queueing these behind durable streams
// that had eaten the HTTP/1.1 per-origin connection limit. That reason is gone
// — the streams are WebSockets and do not draw on that pool (ADR
// 260805-041016) — but the first reason is the real one and still holds.
const INTERACTION_TIMEOUT_MS = 10 * 60 * 1000;

// The message-trigger POST is a raw `fetch` (it parses the 202 body itself), so
// like {@link runCommandIntent} it inherits no default timeout — every other
// transport write gets 30s from `fetchJSON`. Without a bound it could hang
// forever, and two callers latch on that promise: the composer holds the typed
// words until an enqueue settles (DOR-480), and enqueue POSTs are chained per
// session so acceptance order matches keystroke order (DOR-1165). An unbounded
// hang would leave the composer stuck AND wedge every message queued behind it.
// The bound is what guarantees the "reset on settle" the chain relies on.
const MESSAGE_TRIGGER_REQUEST_TIMEOUT_MS = 30_000;

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

    async listRecentSessions(limit?: number): Promise<RecentSessionsResponse> {
      const qs = buildQueryString({ limit });
      const data = await fetchJSON<unknown>(baseUrl, `/sessions/recent${qs}`);
      return RecentSessionsResponseSchema.parse(data);
    },

    async getSessionDailyCounts(days?: number): Promise<SessionDailyCountsResponse> {
      const qs = buildQueryString({ days });
      const data = await fetchJSON<unknown>(baseUrl, `/sessions/daily-counts${qs}`);
      return SessionDailyCountsResponseSchema.parse(data);
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
      options?: {
        clientMessageId?: string;
        context?: ClientContext;
        runtime?: string;
        seedContext?: string;
        disposition?: MessageDisposition;
      }
    ): Promise<{ sessionId: string }> {
      const body: Record<string, unknown> = { content };
      if (cwd) body.cwd = cwd;
      if (options?.clientMessageId) body.clientMessageId = options.clientMessageId;
      if (options?.context) body.context = options.context;
      if (options?.runtime) body.runtime = options.runtime;
      if (options?.seedContext) body.seedContext = options.seedContext;
      if (options?.disposition) body.disposition = options.disposition;

      const response = await fetch(`${baseUrl}/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': getClientId(),
        },
        credentials: 'include',
        signal: AbortSignal.timeout(MESSAGE_TRIGGER_REQUEST_TIMEOUT_MS),
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      // Trigger-only, accept-only contract: the turn (or the queue place) is
      // announced over /events. The body carries the SDK-canonical id, which
      // differs from the client UUID for a brand-new session
      // (create-on-first-message), plus the delivery receipt.
      //
      // Validated rather than cast: this is a contract with the server, and a
      // body that has drifted should say so here rather than as a mystery
      // three layers up. A body we cannot read is NOT treated as a failed send
      // though — the server said 202, the message is accepted, and throwing
      // would put a delivered message back in front of the person as if it had
      // been lost.
      const raw: unknown = await response.json().catch(() => null);
      const parsed = SendMessageResponseSchema.safeParse(raw);
      if (parsed.success) return { sessionId: parsed.data.sessionId };
      console.warn('[transport] The server accepted the message with a body DorkOS cannot read');
      const fallbackId = (raw as { sessionId?: unknown } | null)?.sessionId;
      return { sessionId: typeof fallbackId === 'string' ? fallbackId : sessionId };
    },

    // ── Session Queue (the messages waiting behind the running turn) ────────

    async updateQueuedMessage(
      sessionId: string,
      messageId: string,
      edit: { content?: string; move?: QueueMoveTarget }
    ): Promise<UpdateQueuedMessageResponse> {
      const data = await fetchJSON<unknown>(
        baseUrl,
        `/sessions/${sessionId}/queue/${encodeURIComponent(messageId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'X-Client-Id': getClientId() },
          body: JSON.stringify(edit),
        }
      );
      return UpdateQueuedMessageResponseSchema.parse(data);
    },

    async removeQueuedMessage(
      sessionId: string,
      messageId: string
    ): Promise<{ queue: QueuedMessage[] }> {
      const data = await fetchJSON<unknown>(
        baseUrl,
        `/sessions/${sessionId}/queue/${encodeURIComponent(messageId)}`,
        { method: 'DELETE', headers: { 'X-Client-Id': getClientId() } }
      );
      return SessionQueueResponseSchema.parse(data) satisfies SessionQueueResponse;
    },

    // ── Command-Intent Trigger (202, out-of-band delivery via /events) ─────

    /**
     * Trigger a runtime-fulfilled command intent via
     * `POST /sessions/:id/command-intents/:intent`. Trigger-only (202), mirroring
     * {@link postMessage}: the compaction is delivered out-of-band over `/events`
     * and the 202 body carries the SDK-canonical id. Throws a typed
     * `SESSION_LOCKED` error on 409 when a turn is already running. Trailing
     * instructions (e.g. `/compact focus on the API changes`) ride the JSON body.
     *
     * Bounded by `COMMAND_INTENT_REQUEST_TIMEOUT_MS` — the same 30s `fetchJSON`
     * gives every other call, spelled out because this is a raw `fetch` (it
     * needs the 409 body) and so inherits no default. Without a signal it was
     * the one transport call that could hang forever, leaving
     * `dispatchCompactIntent` unsettled and silent. Callers latch composer state
     * on that promise (DOR-479), which turns "hangs silently" into "the composer
     * never comes back", so the bound is what makes the latch safe to hold.
     *
     * The bound lives in `@dorkos/shared` because the server reads it too: it
     * keeps its own queue wait strictly under this one, so an intent this
     * request abandons is never executed afterwards (DOR-1101).
     */
    async runCommandIntent(
      sessionId: string,
      intent: RuntimeCommandIntentId,
      instructions?: string
    ): Promise<{ sessionId: string }> {
      const response = await fetch(`${baseUrl}/sessions/${sessionId}/command-intents/${intent}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': getClientId(),
        },
        credentials: 'include',
        signal: AbortSignal.timeout(COMMAND_INTENT_REQUEST_TIMEOUT_MS),
        // Express 5 leaves req.body undefined on an empty POST, so the body is
        // sent only when there are instructions to carry.
        ...(instructions !== undefined ? { body: JSON.stringify({ instructions }) } : {}),
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

    // ── DevTools Bridge capture (DOR-213) ─────────────────────────────────

    /**
     * Relay a preview capture batch to `POST /sessions/:id/devtools/ingest`.
     * Fire-and-forget: the response is a 204 sink and errors are swallowed — a
     * dropped batch must never surface in, or slow, the preview. The injected
     * shim never calls `/api/*`; this same-origin, authenticated client does.
     */
    async ingestDevtoolsCapture(sessionId: string, batch: DevtoolsIngest): Promise<void> {
      try {
        await fetch(`${baseUrl}/sessions/${sessionId}/devtools/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(batch),
        });
      } catch {
        /* best-effort capture — never disturb the preview */
      }
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

    denyTool(sessionId: string, toolCallId: string, reason?: string): Promise<{ ok: boolean }> {
      return fetchJSON<{ ok: boolean }>(baseUrl, `/sessions/${sessionId}/deny`, {
        method: 'POST',
        // A blank field is not a reason, so it is left off the wire entirely
        // rather than sent as an empty string the server has to interpret.
        body: JSON.stringify({ toolCallId, reason: reason?.trim() || undefined }),
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
