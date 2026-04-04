/**
 * Manages per-session streaming lifecycle outside the React component tree.
 *
 * StreamManager owns AbortControllers, timer handles, and streaming metadata
 * for every active session. It coordinates with the session-chat-store to
 * persist per-session state (messages, status, error) and provides abort/cleanup
 * semantics that survive component unmounts and session switches.
 *
 * Phase 1: class structure, abort lifecycle, timer management, optimistic message
 * handling, and store initialization. The `dispatchEvent` passthrough will be
 * fully wired to createStreamEventHandler in a later phase.
 *
 * @module features/chat/model/stream-manager
 */
import type { Transport } from '@dorkos/shared/transport';
import type { UiState } from '@dorkos/shared/types';
import { useSessionChatStore } from '@/layers/entities/session';
import { SSE_RESILIENCE, TIMING } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import { classifyTransportError } from './classify-transport-error';
import type { ChatMessage, TransportErrorInfo } from './chat-types';

/** Per-session streaming context managed by StreamManager. */
interface ActiveStream {
  /** AbortController for the transport.sendMessage call. */
  abortController: AbortController;
  /** Transport instance for server-side interrupt calls. */
  transport: Transport;
  /** Client-generated assistant message ID for the current turn. */
  assistantId: string;
  /** Whether the assistant message has been created in the store. */
  assistantCreated: boolean;
  /** Optimistic user message ID (for rollback on error). */
  pendingUserId: string | null;
  /** Auto-retry counter for transient POST failures. */
  retryCount: number;
  /**
   * Tracks the current store key for this stream. Starts as the original
   * sessionId passed to `start()`, then updated by `remapSession()` when
   * the SDK assigns a different session ID (create-on-first-message).
   *
   * All store writes during and after streaming should use this value
   * instead of the captured `sessionId` from `start()`.
   */
  currentSessionId: string;
}

/** Timer handles for a single session. */
interface SessionTimers {
  textStreaming: ReturnType<typeof setTimeout> | null;
  systemStatus: ReturnType<typeof setTimeout> | null;
  sessionBusy: ReturnType<typeof setTimeout> | null;
  presenceTasks: ReturnType<typeof setTimeout> | null;
  rateLimitClear: ReturnType<typeof setTimeout> | null;
}

/** Options for starting a new stream. */
export interface StartStreamOptions {
  /** Transport instance to use for sendMessage. */
  transport: Transport;
  /** Session ID to stream to. */
  sessionId: string;
  /** User message content (already trimmed). */
  content: string;
  /** Working directory for the session. */
  cwd: string | null;
  /** Optional content transform (e.g., prepend context files). */
  transformContent?: (content: string) => string | Promise<string>;
  /**
   * Called for every stream event before StreamManager processes it.
   * Phase 1 shim: lets useChatSession forward events to its local streamEventHandler
   * while StreamManager owns the AbortController lifecycle. Removed in Phase 2 when
   * StreamManager takes full ownership of event dispatch.
   */
  onEvent?: (type: string, data: unknown, assistantId: string) => void;
  /** The assistant message ID for the current turn, used by onEvent. */
  assistantId?: string;
  /** Called when the SDK assigns a different session ID (create-on-first-message remap). */
  onSessionIdChange?: (newSessionId: string) => void;
  /** Called when streaming completes after MIN_STREAM_DURATION_MS. */
  onStreamingDone?: () => void;
}

/** Default timer state for a new session. */
const EMPTY_TIMERS: SessionTimers = {
  textStreaming: null,
  systemStatus: null,
  sessionBusy: null,
  presenceTasks: null,
  rateLimitClear: null,
};

/**
 * Manages streaming lifecycle for all active sessions.
 *
 * Designed as a singleton — one instance coordinates all concurrent streams.
 * React components read state from the session-chat-store; StreamManager is
 * the sole writer during streaming.
 */
export class StreamManager {
  /** Active streams keyed by session ID. */
  private streams = new Map<string, ActiveStream>();

  /** Timer handles keyed by session ID. */
  private timers = new Map<string, SessionTimers>();

  // ---------------------------------------------------------------------------
  // Public query API
  // ---------------------------------------------------------------------------

  /** Whether a given session is currently streaming. */
  isStreaming(sessionId: string): boolean {
    return this.streams.has(sessionId);
  }

  /** Session IDs with active streams. */
  getActiveSessionIds(): string[] {
    return Array.from(this.streams.keys());
  }

  // ---------------------------------------------------------------------------
  // Abort API
  // ---------------------------------------------------------------------------

  /** Abort a single session's active stream. No-op if not streaming. */
  abort(sessionId: string): void {
    const stream = this.streams.get(sessionId);
    if (!stream) return;

    // Fire-and-forget server-side interrupt so the SDK query actually stops.
    // Without this, aborting the fetch only drops the HTTP connection — the
    // agent subprocess continues running in the background.
    stream.transport.interruptSession(stream.currentSessionId).catch(() => {
      // Best-effort — swallow errors (session may already be idle)
    });

    stream.abortController.abort();
    this.clearTimers(sessionId);
    this.streams.delete(sessionId);

    // Reset streaming state in the store
    useSessionChatStore.getState().updateSession(sessionId, {
      status: 'idle',
      sdkState: null,
      isTextStreaming: false,
      streamStartTime: null,
      estimatedTokens: 0,
      isRateLimited: false,
      rateLimitRetryAfter: null,
    });
  }

  /** Abort all active streams. Used during app teardown or global cancel. */
  abortAll(): void {
    for (const sessionId of this.streams.keys()) {
      this.abort(sessionId);
    }
  }

  // ---------------------------------------------------------------------------
  // Session remap
  // ---------------------------------------------------------------------------

  /**
   * Update the internal session ID mapping when the SDK assigns a new ID
   * (create-on-first-message remap). Moves the ActiveStream and timer
   * entries to the new key so subsequent store writes target the correct
   * session.
   */
  remapSession(oldId: string, newId: string): void {
    const stream = this.streams.get(oldId);
    if (stream) {
      stream.currentSessionId = newId;
      this.streams.delete(oldId);
      this.streams.set(newId, stream);
    }

    const timers = this.timers.get(oldId);
    if (timers) {
      this.timers.delete(oldId);
      this.timers.set(newId, timers);
    }
  }

  // ---------------------------------------------------------------------------
  // Stream lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start a new streaming turn for a session.
   *
   * If the session already has an active stream, it is aborted first —
   * only one stream per session is allowed at a time.
   *
   * @returns A promise that resolves when the stream completes or rejects on
   *   unrecoverable error. AbortError is swallowed (user-initiated cancel).
   */
  async start(options: StartStreamOptions): Promise<void> {
    const { transport, sessionId, content, cwd, transformContent, onEvent } = options;

    // Abort any existing stream for this session
    if (this.streams.has(sessionId)) {
      this.abort(sessionId);
    }

    const store = useSessionChatStore.getState();

    // Ensure session exists in the store
    store.initSession(sessionId);

    // Create optimistic user message
    const pendingUserId = `pending-user-${crypto.randomUUID()}`;
    const userMessage: ChatMessage = {
      id: pendingUserId,
      role: 'user',
      content,
      parts: [{ type: 'text', text: content }],
      timestamp: new Date().toISOString(),
      _streaming: true,
    };

    const assistantId = crypto.randomUUID();
    const streamStart = Date.now();

    // Set up the ActiveStream entry
    const abortController = new AbortController();
    const activeStream: ActiveStream = {
      abortController,
      transport,
      assistantId,
      assistantCreated: false,
      pendingUserId,
      retryCount: 0,
      currentSessionId: sessionId,
    };
    this.streams.set(sessionId, activeStream);

    // Update store with optimistic state
    const currentMessages = store.getSession(sessionId).messages;
    store.updateSession(sessionId, {
      messages: [...currentMessages, userMessage],
      status: 'streaming',
      error: null,
      streamStartTime: streamStart,
      estimatedTokens: 0,
      pendingUserId,
      assistantId,
      assistantCreated: false,
      retryCount: 0,
      currentParts: [],
    });

    try {
      const finalContent = transformContent ? await transformContent(content) : content;

      await transport.sendMessage(
        sessionId,
        finalContent,
        (event) => {
          // Phase 1 shim: forward to caller's event handler (useChatSession local state)
          // before running StreamManager's own dispatch. Removed in Phase 2.
          if (onEvent) onEvent(event.type, event.data, assistantId);
          // Use currentSessionId (not the captured sessionId) so dispatchEvent
          // finds the stream entry after a session ID remap.
          this.dispatchEvent(activeStream.currentSessionId, event.type, event.data);
        },
        abortController.signal,
        cwd ?? undefined,
        {
          clientMessageId: pendingUserId,
          uiState: snapshotUiState(cwd),
        }
      );

      // Stream completed successfully — mark unseen activity so the sidebar
      // indicator lights up if this was a background (non-active) session.
      // The active session's useChatSession will clear this flag via useEffect.
      // Use currentSessionId (not the original sessionId) in case the SDK
      // remapped the session ID during streaming (create-on-first-message).
      const finalId = activeStream.currentSessionId;
      this.streams.delete(finalId);
      store.updateSession(finalId, {
        status: 'idle',
        sdkState: null,
        pendingUserId: null,
        hasUnseenActivity: true,
      });
    } catch (err) {
      // Use the (potentially remapped) session ID for all store writes in error paths.
      const errorSessionId = activeStream.currentSessionId;

      // AbortError is not an error — user cancelled intentionally.
      // Re-throw so callers can distinguish abort from real errors.
      if ((err as Error).name === 'AbortError') {
        this.cleanupStream(errorSessionId);
        useSessionChatStore.getState().updateSession(errorSessionId, { status: 'idle' });
        throw err;
      }

      const errorInfo = classifyTransportError(err);
      const stream = this.streams.get(errorSessionId) ?? this.streams.get(sessionId);

      // Session locked — restore input and show auto-dismissing banner.
      // Re-throw the original error so callers can inspect code === 'SESSION_LOCKED'.
      if ((err as { code?: string }).code === 'SESSION_LOCKED') {
        this.handleSessionLocked(errorSessionId, errorInfo, pendingUserId);
        throw err;
      }

      // Retryable transient error — auto-retry once before surfacing
      const hasPartialResponse = stream?.assistantCreated ?? false;
      if (
        errorInfo.retryable &&
        !hasPartialResponse &&
        (stream?.retryCount ?? 0) < SSE_RESILIENCE.POST_MAX_RETRIES
      ) {
        const retrySucceeded = await this.attemptRetry(
          options,
          abortController,
          pendingUserId,
          activeStream
        );
        if (retrySucceeded) return;
        // Retry failed — fall through to error display
      }

      // Non-retryable or mid-stream failure — write to store, then re-throw so
      // callers (e.g. useChatSession) can update their own local state.
      this.handleStreamError(errorSessionId, errorInfo, hasPartialResponse, pendingUserId);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Event dispatch (Phase 1 stub — wired in Phase 2)
  // ---------------------------------------------------------------------------

  /**
   * Dispatch a stream event to the appropriate handler.
   *
   * In Phase 1 this is a passthrough stub. Phase 2 will wire it to
   * createStreamEventHandler with store-backed setters.
   */
  dispatchEvent(sessionId: string, type: string, _data: unknown): void {
    const stream = this.streams.get(sessionId);
    if (!stream) return;

    // Use the (potentially remapped) session ID for all store writes
    const storeKey = stream.currentSessionId;

    // Mark assistant as created on first content event
    if (!stream.assistantCreated && (type === 'text_delta' || type === 'thinking_delta')) {
      stream.assistantCreated = true;
      useSessionChatStore.getState().updateSession(storeKey, {
        assistantCreated: true,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Timer management
  // ---------------------------------------------------------------------------

  /** Get or create the timer set for a session. */
  getOrCreateTimers(sessionId: string): SessionTimers {
    let timers = this.timers.get(sessionId);
    if (!timers) {
      timers = { ...EMPTY_TIMERS };
      this.timers.set(sessionId, timers);
    }
    return timers;
  }

  /** Clear all timers for a session and remove the entry. */
  clearTimers(sessionId: string): void {
    const timers = this.timers.get(sessionId);
    if (!timers) return;

    if (timers.textStreaming) clearTimeout(timers.textStreaming);
    if (timers.systemStatus) clearTimeout(timers.systemStatus);
    if (timers.sessionBusy) clearTimeout(timers.sessionBusy);
    if (timers.presenceTasks) clearTimeout(timers.presenceTasks);
    if (timers.rateLimitClear) clearTimeout(timers.rateLimitClear);

    this.timers.delete(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Clean up stream infrastructure (active stream entry, timers) and reset
   * transient streaming indicators (text streaming, rate limit) in the store.
   *
   * Does NOT reset `status` — callers set status before or after cleanup
   * depending on whether the stream ended normally or in error.
   */
  private cleanupStream(sessionId: string): void {
    this.clearTimers(sessionId);
    this.streams.delete(sessionId);

    useSessionChatStore.getState().updateSession(sessionId, {
      isTextStreaming: false,
      isRateLimited: false,
      rateLimitRetryAfter: null,
      sdkState: null,
    });
  }

  /** Handle SESSION_LOCKED error — remove optimistic message, show banner. */
  private handleSessionLocked(
    sessionId: string,
    errorInfo: TransportErrorInfo,
    pendingUserId: string
  ): void {
    const store = useSessionChatStore.getState();
    const session = store.getSession(sessionId);

    store.updateSession(sessionId, {
      messages: session.messages.filter((m) => m.id !== pendingUserId),
      sessionBusy: true,
      error: errorInfo,
      status: 'error',
      pendingUserId: null,
    });

    this.cleanupStream(sessionId);

    // Auto-dismiss busy state
    const timers = this.getOrCreateTimers(sessionId);
    if (timers.sessionBusy) clearTimeout(timers.sessionBusy);
    timers.sessionBusy = setTimeout(() => {
      useSessionChatStore.getState().updateSession(sessionId, {
        sessionBusy: false,
        error: null,
      });
      timers.sessionBusy = null;
    }, TIMING.SESSION_BUSY_CLEAR_MS);
  }

  /** Attempt a single auto-retry for a transient error. */
  private async attemptRetry(
    options: StartStreamOptions,
    abortController: AbortController,
    pendingUserId: string,
    activeStream: ActiveStream
  ): Promise<boolean> {
    const { transport, sessionId, content, cwd, transformContent } = options;
    // Use the (potentially remapped) session ID for store writes
    const storeId = activeStream.currentSessionId;

    activeStream.retryCount += 1;
    useSessionChatStore.getState().updateSession(storeId, {
      error: {
        heading: 'Connection interrupted',
        message: 'Retrying\u2026',
        retryable: false,
      },
      retryCount: activeStream.retryCount,
    });

    await new Promise((resolve) => setTimeout(resolve, SSE_RESILIENCE.POST_RETRY_DELAY_MS));

    try {
      const retryContent = transformContent ? await transformContent(content) : content;

      await transport.sendMessage(
        sessionId,
        retryContent,
        (event) => this.dispatchEvent(activeStream.currentSessionId, event.type, event.data),
        abortController.signal,
        cwd ?? undefined,
        {
          clientMessageId: pendingUserId,
          uiState: snapshotUiState(cwd),
        }
      );

      // Retry succeeded
      this.streams.delete(storeId);
      useSessionChatStore.getState().updateSession(storeId, {
        status: 'idle',
        error: null,
        pendingUserId: null,
        retryCount: 0,
      });
      this.cleanupStream(storeId);
      return true;
    } catch (retryErr) {
      if ((retryErr as Error).name === 'AbortError') {
        this.cleanupStream(storeId);
        useSessionChatStore.getState().updateSession(storeId, { status: 'idle' });
        return true; // Abort is handled, no further error display needed
      }

      // Retry failed — remove optimistic message and surface error
      const store = useSessionChatStore.getState();
      const session = store.getSession(storeId);
      store.updateSession(storeId, {
        messages: session.messages.filter((m) => m.id !== pendingUserId),
        error: classifyTransportError(retryErr),
        status: 'error',
        pendingUserId: null,
      });
      this.cleanupStream(storeId);
      return false;
    }
  }

  /** Handle non-retryable or mid-stream error. */
  private handleStreamError(
    sessionId: string,
    errorInfo: TransportErrorInfo,
    hasPartialResponse: boolean,
    pendingUserId: string
  ): void {
    const store = useSessionChatStore.getState();
    const session = store.getSession(sessionId);

    // Remove optimistic user message if it was never delivered
    const updatedMessages = session.messages.filter((m) => m.id !== pendingUserId);

    // Mid-stream interruption: explain that partial response is preserved
    const displayError =
      hasPartialResponse && errorInfo.retryable
        ? {
            heading: 'Response interrupted',
            message:
              'The connection was lost mid-response. The partial response is preserved above.',
            retryable: true,
          }
        : errorInfo;

    store.updateSession(sessionId, {
      messages: updatedMessages,
      error: displayError,
      status: 'error',
      pendingUserId: null,
    });

    this.cleanupStream(sessionId);
  }
}

/** Snapshot the current Zustand UI state for agent awareness. */
function snapshotUiState(activeCwd: string | null): UiState {
  const s = useAppStore.getState();
  return {
    canvas: {
      open: s.canvasOpen,
      contentType: s.canvasContent?.type ?? null,
    },
    panels: {
      settings: s.settingsOpen,
      tasks: s.tasksOpen,
      relay: s.relayOpen,
      mesh: s.meshOpen,
    },
    sidebar: {
      open: s.sidebarOpen,
      activeTab: s.sidebarActiveTab,
    },
    agent: {
      id: null,
      cwd: activeCwd,
    },
  };
}

/** Module-level singleton — one StreamManager coordinates all concurrent streams. */
export const streamManager = new StreamManager();
