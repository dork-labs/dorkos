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
  PermissionMode,
  HistoryMessage,
  TaskItem,
  SessionLockedError,
  ReloadPluginsResult,
} from '@dorkos/shared/types';
import type { ClientContext } from '@dorkos/shared/additional-context';
import type { RuntimeCommandIntentId } from '@dorkos/shared/command-intents';
import type { ClaudePluginTransport } from '@dorkos/shared/transport';
import type { PendingInteractionsResponse } from '@dorkos/shared/interaction-events';
import type { UiActionRequest, MessageDisposition, QueuedMessage } from '@dorkos/shared/schemas';
import { formatUiActionMessage } from '@dorkos/shared/ui-widget';
import type { DirectTransportServices } from './services';

/**
 * Resolve the directory to read a session's messages from without a
 * caller-supplied `cwd` — the DirectTransport twin of the HTTP route's
 * `resolveMessagesCwd` (DOR-1322). Tries the embedded runtime's own live
 * binding first, then falls back to the vault root, but only after
 * `transcriptReader.getSession` confirms the session actually lives there —
 * the same "verify before trusting the fallback" contract as the server, so
 * a session from a different directory never reads back as silently empty.
 * Guarded: a `getSession` throw (rather than a `null` "not found") degrades
 * to `undefined` exactly like the server-side probe does, never propagates.
 *
 * @param services - In-process service seams wired by the embedding host
 * @param sessionId - Session to resolve
 */
async function resolveDirectMessagesCwd(
  services: DirectTransportServices,
  sessionId: string
): Promise<string | undefined> {
  const liveCwd = services.runtime.getSessionCwd?.(sessionId);
  if (liveCwd) return liveCwd;

  try {
    const found = await services.transcriptReader.getSession(services.vaultRoot, sessionId);
    return found ? services.vaultRoot : undefined;
  } catch {
    return undefined;
  }
}

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
      const updated = await services.runtime.updateSession(id, {
        ...opts,
        // The request type carries any id the owning runtime declares (DOR-811);
        // the runtime interface still names the narrower shared enum for the
        // same field. Safe to assert HERE and only here: an embedded host wires
        // exactly ONE runtime, and the only thing that ever fills this field is
        // that runtime's own mode descriptors, read from `getCapabilities()`.
        permissionMode: opts.permissionMode as PermissionMode | undefined,
      });
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

    /**
     * Read a session's message history, resolving its working directory the
     * same way the HTTP route does (DOR-1322): an explicit `cwd` wins;
     * otherwise the embedded runtime's own live binding
     * (`services.runtime.getSessionCwd`); otherwise the vault root, but only
     * once verified — `transcriptReader.getSession` confirms the session
     * actually lives there before `readTranscript` is trusted to look. A
     * session that resolves nowhere throws, exactly like the HTTP transport's
     * `fetchJSON` throws on the server's 404 SESSION_CWD_REQUIRED — callers
     * already handle a rejected `getMessages` as a query error (React Query).
     */
    async getMessages(sessionId: string, cwd?: string): Promise<{ messages: HistoryMessage[] }> {
      const resolvedCwd = cwd || (await resolveDirectMessagesCwd(services, sessionId));
      if (!resolvedCwd) {
        throw new Error(
          `Could not determine the working directory for session '${sessionId}'. Pass cwd explicitly.`
        );
      }
      const messages = await services.transcriptReader.readTranscript(resolvedCwd, sessionId);
      return { messages };
    },

    // ── Message Trigger (detached turn, delivery via subscribeSession) ──────

    /**
     * Trigger a turn and resolve to the canonical session id (trigger-only
     * contract, ADR-0264). The turn runs detached via the wired
     * {@link DirectTransportServices.turnTrigger | turnTrigger}, feeding the
     * session projector; tokens are delivered solely over `subscribeSession`.
     *
     * A busy session is never refused: the dispatcher behind this bridge takes
     * the message and holds it until the running turn ends (spec
     * `persistent-session-runtime` §3.3), exactly as the HTTP route does.
     */
    async postMessage(
      sessionId: string,
      content: string,
      cwd?: string,
      // `options.runtime` (the first-turn runtime hint) is intentionally not
      // forwarded: DirectTransport embeds exactly one in-process runtime, so
      // there is never a second runtime to select. `options.account` (the
      // first-turn billing hint) is not forwarded for the same reason: the
      // embedded bridge's turn trigger takes no account, and the status-bar
      // picker that produces the hint needs a multi-account registry the embedded
      // host does not report. `options.disposition` is not forwarded either: the
      // embedded bridge carries no disposition envelope, and every disposition
      // resolves to `queue` today anyway.
      options?: {
        clientMessageId?: string;
        context?: ClientContext;
        runtime?: string;
        account?: string;
        seedContext?: string;
        disposition?: MessageDisposition;
      }
    ): Promise<{ sessionId: string }> {
      const result = await services.turnTrigger.trigger({
        sessionId,
        clientId: getClientId(),
        content,
        cwd: cwd ?? services.vaultRoot,
        context: options?.context,
        seedContext: options?.seedContext,
      });
      return { sessionId: result.canonicalId ?? sessionId };
    },

    // ── Session Queue ───────────────────────────────────────────────────────

    /**
     * Edit or move a message waiting on the session's queue.
     *
     * Embedded hosts run without a queue store, so nothing is ever waiting and
     * the cockpit draws no chips to reach this from. It refuses honestly rather
     * than pretending to have edited something, which is what a silent no-op
     * would look like from the caller's side.
     */
    updateQueuedMessage(): Promise<{ message: QueuedMessage; queue: QueuedMessage[] }> {
      return Promise.reject(new Error('This surface keeps no message queue'));
    },

    /** Remove a message waiting on the session's queue. See {@link updateQueuedMessage}. */
    removeQueuedMessage(): Promise<{ queue: QueuedMessage[] }> {
      return Promise.reject(new Error('This surface keeps no message queue'));
    },

    // ── Command-Intent Trigger ───────────────────────────────────────────────

    /**
     * Trigger a RUNTIME-fulfilled command intent (currently `compact`)
     * in-process (trigger-only contract, ADR-0264). The run rides the wired
     * {@link DirectTransportServices.commandIntentTrigger | commandIntentTrigger},
     * feeding the session projector; the compaction is delivered solely over
     * `subscribeSession` (e.g. a `compact_boundary`). Throws a typed
     * `SESSION_LOCKED` error when the session lock is held — reachable only when
     * ANOTHER transport instance holds it, because this client's own in-flight
     * work is waited for rather than collided with (DOR-1088). The client
     * pre-gates on the runtime's capability, so this is reached only for a
     * supported intent.
     */
    async runCommandIntent(
      sessionId: string,
      intent: RuntimeCommandIntentId,
      instructions?: string
    ): Promise<{ sessionId: string }> {
      const result = await services.commandIntentTrigger.trigger({
        sessionId,
        clientId: getClientId(),
        intent,
        cwd: services.vaultRoot,
        instructions,
      });
      if (!result.accepted) {
        const error = new Error('Session locked') as Error & SessionLockedError;
        error.code = 'SESSION_LOCKED';
        // `lockedBy`/`lockedAt` are approximations — the narrowed seam exposes
        // no getLockInfo — and harmlessly so: `code` is the only field any
        // caller reads (`dispatchCompactIntent` picks the busy-agent toast off
        // it). `sendUiAction` below throws the same shape for the same reason.
        error.lockedBy = getClientId();
        error.lockedAt = new Date().toISOString();
        throw error;
      }
      return { sessionId };
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

    /**
     * Every prompt the embedded fleet is parked on.
     *
     * The in-process twin of `GET /api/sessions/pending-interactions`, reading
     * the same projector registry the HTTP route reads. No `warnings`: there is
     * one runtime here, so there is no other source to degrade.
     *
     * **Unfiltered, and that is not an omission.** The HTTP route scopes its
     * list to the caller (`askEntitlement`, spec `ask-entitlement` §3.1). There
     * is no caller here: this runs inside the Obsidian process, driven by the
     * person at the keyboard, so the principal is `operator` by construction
     * and the predicate would return `answer` for every row. Nothing on a chat
     * platform and nothing holding an API key can reach this method at all.
     */
    async listPendingInteractions(): Promise<PendingInteractionsResponse> {
      return { interactions: services.pendingInteractions.list() };
    },

    async approveTool(
      sessionId: string,
      toolCallId: string,
      alwaysAllow?: boolean
    ): Promise<{ ok: boolean }> {
      const result = services.runtime.approveTool(sessionId, toolCallId, true, { alwaysAllow });
      return { ok: result };
    },

    async denyTool(
      sessionId: string,
      toolCallId: string,
      reason?: string
    ): Promise<{ ok: boolean }> {
      const result = services.runtime.approveTool(sessionId, toolCallId, false, {
        denyReason: reason?.trim() || undefined,
      });
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

    /**
     * Interrupt the active query. DirectTransport delegates to the in-process
     * runtime if supported. Embedded hosts run without a queue store, so nothing
     * is ever waiting and `cancelledQueued` is always empty — the same reason
     * the queue-mutation methods above refuse honestly rather than pretend.
     */
    async interruptSession(
      sessionId: string
    ): Promise<{ ok: boolean; cancelledQueued: QueuedMessage[] }> {
      try {
        const runtime = services.runtime as {
          interruptQuery?: (s: string) => Promise<boolean>;
        };
        if (typeof runtime.interruptQuery !== 'function') {
          return { ok: false, cancelledQueued: [] };
        }
        const ok = await runtime.interruptQuery(sessionId);
        return { ok, cancelledQueued: [] };
      } catch {
        return { ok: false, cancelledQueued: [] };
      }
    },

    async getTasks(sessionId: string, cwd?: string): Promise<{ tasks: TaskItem[] }> {
      const tasks = await services.transcriptReader.readTasks(cwd || services.vaultRoot, sessionId);
      return { tasks };
    },
  };
}
