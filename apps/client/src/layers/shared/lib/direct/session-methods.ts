/**
 * Direct session methods factory — session CRUD, message history, turn
 * triggering, and tool interactions delegated to in-process services.
 *
 * Mirrors `transport/session-methods.ts` (the HTTP twin) so both Transport
 * implementations split along the same domain seams.
 *
 * @module shared/lib/direct/session-methods
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
import type { ClientContext } from '@dorkos/shared/additional-context';
import type { ClaudePluginTransport } from '@dorkos/shared/transport';
import type { UiActionRequest } from '@dorkos/shared/schemas';
import { formatUiActionMessage } from '@dorkos/shared/ui-widget';
import type { DirectTransportServices } from './services';

/**
 * Create all session-related methods bound to the injected services.
 *
 * @param services - In-process service seams wired by the embedding host
 * @param getClientId - Accessor for the transport's client ID (used for session locking)
 */
export function createDirectSessionMethods(
  services: DirectTransportServices,
  getClientId: () => string
) {
  async function getSession(id: string, cwd?: string): Promise<Session> {
    const session = await services.transcriptReader.getSession(cwd || services.vaultRoot, id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }
    return session;
  }

  return {
    // ── Session CRUD ────────────────────────────────────────────────────────

    async listSessions(cwd?: string): Promise<SessionListResponse> {
      // Single embedded runtime — no cross-runtime aggregation, so the
      // envelope (ADR-0310) never carries warnings here.
      const sessions = await services.transcriptReader.listSessions(cwd || services.vaultRoot);
      return { sessions };
    },

    getSession,

    /**
     * Resolve the runtime type for a session.
     *
     * The Obsidian plugin currently embeds a single in-process runtime
     * (`claude-code` today; `test-mode` is a plausible future addition for
     * integration testing). With only one runtime bundled, every session is
     * owned by it, so we return its type directly. When a second runtime is
     * added to `DirectTransportServices`, this should be widened to resolve
     * per-session via an embedded registry — tracked via ADR 0255 and the
     * future embedded-test-mode follow-up (Phase 3, task #17).
     *
     * TODO(embedded-multi-runtime): if `DirectTransportServices.runtime` ever
     * becomes a map `Record<string, runtime>`, change this to consult an
     * embedded registry keyed by `sessionId`. Until then, ANY multi-runtime
     * embedded wiring will silently misroute — fail loudly if that happens.
     *
     * @param _sessionId - Accepted for Transport parity; unused in single-runtime embedded mode.
     */
    async getSessionRuntimeType(_sessionId: string): Promise<string> {
      return services.runtime.getCapabilities().type;
    },

    async updateSession(id: string, opts: UpdateSessionRequest, cwd?: string): Promise<Session> {
      const updated = await services.runtime.updateSession(id, opts);
      if (!updated) throw new Error(`Session not found: ${id}`);
      return getSession(id, cwd);
    },

    async forkSession(
      _id: string,
      _opts?: { upToMessageId?: string; title?: string },
      _cwd?: string
    ): Promise<Session> {
      throw new Error('Session forking is not supported in DirectTransport');
    },

    /**
     * Obtain a Claude-specific plugin sub-transport for a session.
     *
     * Returns a concrete wrapper when the embedded runtime advertises
     * `capabilities.supportsPlugins: true` AND exposes a `reloadPlugins` bridge
     * via `DirectTransportServices.runtime.reloadPlugins`. Returns `null`
     * otherwise (plugins not supported by the runtime, or the bridge is not
     * wired). Per ADR 0258, plugin features are capability-gated and callers
     * must handle the null branch.
     *
     * The Obsidian plugin wires this bridge from `ClaudeCodeRuntime.reloadPlugins`
     * so reloads actually hit the in-process SDK query. A `null` return from the
     * bridge (no active SDK query yet) surfaces to the caller as a result with
     * zero commands/plugins so the UI can show a neutral "nothing to reload" state.
     *
     * @param sessionId - Session whose plugins will be reloaded on invocation.
     */
    asClaudePluginTransport(sessionId: string): ClaudePluginTransport | null {
      const caps = services.runtime.getCapabilities();
      if (!caps.supportsPlugins) return null;
      const reload = services.runtime.reloadPlugins;
      if (!reload) return null;
      const runtime = services.runtime;
      return {
        async reloadPlugins(): Promise<ReloadPluginsResult> {
          const result = await reload.call(runtime, sessionId);
          return result ?? { commandCount: 0, pluginCount: 0, errorCount: 0 };
        },
      };
    },

    // ── Message History ─────────────────────────────────────────────────────

    async getMessages(sessionId: string, cwd?: string): Promise<{ messages: HistoryMessage[] }> {
      const messages = await services.transcriptReader.readTranscript(
        cwd || services.vaultRoot,
        sessionId
      );
      return { messages };
    },

    // ── Message Trigger (detached turn, delivery via subscribeSession) ──────

    /**
     * Trigger a turn and resolve to the canonical session id (trigger-only
     * contract, ADR-0264). The turn runs detached via the wired
     * {@link DirectTransportServices.turnTrigger | turnTrigger}, feeding the
     * session projector; tokens are delivered solely over `subscribeSession`.
     * Throws a typed `SESSION_LOCKED` error when the session lock is held —
     * only reachable when ANOTHER transport instance (e.g. a previous view's
     * client id) holds it, since a same-client acquire steals the lock.
     * Callers restore input exactly as for the HTTP 409.
     */
    async postMessage(
      sessionId: string,
      content: string,
      cwd?: string,
      // `options.runtime` (the first-turn runtime hint) is intentionally not
      // forwarded: DirectTransport embeds exactly one in-process runtime, so
      // there is never a second runtime to select.
      options?: { clientMessageId?: string; context?: ClientContext; runtime?: string }
    ): Promise<{ sessionId: string }> {
      const result = await services.turnTrigger.trigger({
        sessionId,
        clientId: getClientId(),
        content,
        cwd: cwd ?? services.vaultRoot,
        context: options?.context,
      });
      if (!result.accepted) {
        const error = new Error('Session locked') as Error & SessionLockedError;
        error.code = 'SESSION_LOCKED';
        // Approximations: the narrowed runtime seam exposes no getLockInfo, and
        // only `code` is consumed by callers (classify-transport-error). The real
        // holder is some other embedded client id; the timestamp is "observed at".
        error.lockedBy = getClientId();
        error.lockedAt = new Date().toISOString();
        throw error;
      }
      return { sessionId: result.canonicalId ?? sessionId };
    },

    // ── Generative-UI Interactivity ─────────────────────────────────────────

    /**
     * In-process twin of the HTTP `POST /sessions/:id/ui-action`. Formats the
     * SAME `<ui_action>` block (shared formatter) and feeds it to the embedded
     * turn trigger, so the Obsidian path and the web path are byte-identical.
     */
    async sendUiAction(sessionId: string, action: UiActionRequest): Promise<{ sessionId: string }> {
      const result = await services.turnTrigger.trigger({
        sessionId,
        clientId: getClientId(),
        content: formatUiActionMessage(action),
        cwd: action.cwd ?? services.vaultRoot,
      });
      if (!result.accepted) {
        const error = new Error('Session locked') as Error & SessionLockedError;
        error.code = 'SESSION_LOCKED';
        error.lockedBy = getClientId();
        error.lockedAt = new Date().toISOString();
        throw error;
      }
      return { sessionId: result.canonicalId ?? sessionId };
    },

    /**
     * No-op: the embedded browser preview (DOR-216/DOR-213) is a web-only
     * surface, so there is never a capture to relay in the in-process Obsidian
     * transport. Present to satisfy the Transport contract.
     */
    async ingestDevtoolsCapture(): Promise<void> {
      /* web-only surface — nothing to relay in-process */
    },

    // ── Tool Approval ───────────────────────────────────────────────────────

    async approveTool(
      sessionId: string,
      toolCallId: string,
      alwaysAllow?: boolean
    ): Promise<{ ok: boolean }> {
      const result = services.runtime.approveTool(sessionId, toolCallId, true, alwaysAllow);
      return { ok: result };
    },

    async denyTool(sessionId: string, toolCallId: string): Promise<{ ok: boolean }> {
      const result = services.runtime.approveTool(sessionId, toolCallId, false);
      return { ok: result };
    },

    async batchApprove(
      sessionId: string,
      toolCallIds: string[]
    ): Promise<{ results: { toolCallId: string; ok: boolean }[] }> {
      const results = toolCallIds.map((id) => ({
        toolCallId: id,
        ok: services.runtime.approveTool(sessionId, id, true),
      }));
      return { results };
    },

    async batchDeny(
      sessionId: string,
      toolCallIds: string[]
    ): Promise<{ results: { toolCallId: string; ok: boolean }[] }> {
      const results = toolCallIds.map((id) => ({
        toolCallId: id,
        ok: services.runtime.approveTool(sessionId, id, false),
      }));
      return { results };
    },

    async submitAnswers(
      sessionId: string,
      toolCallId: string,
      answers: Record<string, string>
    ): Promise<{ ok: boolean }> {
      const ok = services.runtime.submitAnswers(sessionId, toolCallId, answers);
      return { ok };
    },

    async submitElicitation(
      sessionId: string,
      interactionId: string,
      action: 'accept' | 'decline' | 'cancel',
      _content?: Record<string, unknown>
    ): Promise<{ ok: boolean }> {
      // DirectTransport runtime interface predates elicitation — use structural check
      const runtime = services.runtime as {
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
    },

    /** Stop a running background task. DirectTransport delegates to the in-process runtime if supported. */
    async stopTask(
      sessionId: string,
      taskId: string
    ): Promise<{ success: boolean; taskId: string }> {
      try {
        // The DirectTransport runtime interface predates stopTask — use a structural check
        // to forward the call only when the method is present (Obsidian plugin compatibility).
        const runtime = services.runtime as {
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
    },

    /** Interrupt the active query. DirectTransport delegates to the in-process runtime if supported. */
    async interruptSession(sessionId: string): Promise<{ ok: boolean }> {
      try {
        const runtime = services.runtime as {
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
    },

    async getTasks(sessionId: string, cwd?: string): Promise<{ tasks: TaskItem[] }> {
      const tasks = await services.transcriptReader.readTasks(cwd || services.vaultRoot, sessionId);
      return { tasks };
    },
  };
}
