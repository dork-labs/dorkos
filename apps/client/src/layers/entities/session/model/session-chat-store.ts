/**
 * Session-keyed chat state store.
 *
 * Stores per-session chat state (messages, status, input drafts, streaming metadata)
 * outside the React component lifecycle. This enables concurrent streaming, instant
 * session resume, and background activity indicators.
 *
 * @module entities/session/model/session-chat-store
 */
import { useCallback } from 'react';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type {
  SessionStatusEvent,
  ContextUsage,
  MessagePart,
  HookPart,
  SdkSessionState,
} from '@dorkos/shared/types';
import type {
  ChatMessage,
  ChatStatus,
  TransportErrorInfo,
  SystemStatusState,
  OperationProgressState,
} from '@/layers/shared/model/chat-message-types';

/** Maximum number of sessions retained in the store before LRU eviction. */
const MAX_RETAINED_SESSIONS = 20;

/**
 * Global monotonic counter for mount generations.
 *
 * Never resets — each `initSession` call for a new (or re-initialized) session
 * claims the next integer. This ensures that stale closures captured by a
 * previous component instance always hold a different generation value than the
 * freshly-initialized session, even across test resets or store wipes.
 */
let globalMountGenerationCounter = 0;

/** Per-session chat state stored in the session chat store. */
export interface SessionState {
  // --- Message state ---
  messages: ChatMessage[];
  currentParts: MessagePart[];
  orphanHooks: Map<string, HookPart[]>;
  assistantId: string;
  assistantCreated: boolean;
  pendingUserId: string | null;

  // --- Input & status ---
  input: string;
  status: ChatStatus;
  error: TransportErrorInfo | null;

  // --- Streaming metadata ---
  streamStartTime: number | null;
  estimatedTokens: number;
  isTextStreaming: boolean;
  thinkingStart: number | null;

  // --- Session metadata ---
  sessionStatus: SessionStatusEvent | null;
  contextUsage: ContextUsage | null;
  systemStatus: SystemStatusState | null;
  operationProgress: OperationProgressState | null;
  promptSuggestions: string[];

  // --- Lifecycle flags ---
  historySeeded: boolean;
  retryCount: number;

  /**
   * Monotonically-increasing counter that increments each time `initSession` creates
   * a fresh entry for this session ID. Captured in per-component closures (e.g.,
   * `setMessages`) so stale closures from a previous component instance can detect
   * that the session has been re-initialized and drop their writes rather than
   * corrupting the new session's state.
   */
  mountGeneration: number;

  // --- SDK state ---
  /** Authoritative SDK session state (supplements inferred `status` field). */
  sdkState: SdkSessionState | null;
}

/** Default state for a freshly initialized session. */
export const DEFAULT_SESSION_STATE: SessionState = {
  messages: [],
  currentParts: [],
  orphanHooks: new Map(),
  assistantId: '',
  assistantCreated: false,
  pendingUserId: null,
  input: '',
  status: 'idle',
  error: null,
  streamStartTime: null,
  estimatedTokens: 0,
  isTextStreaming: false,
  thinkingStart: null,
  sessionStatus: null,
  contextUsage: null,
  systemStatus: null,
  operationProgress: null,
  promptSuggestions: [],
  historySeeded: false,
  retryCount: 0,
  sdkState: null,
  mountGeneration: 0,
};

interface SessionChatStoreState {
  sessions: Record<string, SessionState>;
  sessionAccessOrder: string[];
  /**
   * Session ids that have confirmed entry into the `'auto'` permission mode,
   * keyed for O(1) membership. Client-only and ephemeral — gates the
   * once-per-session confirmation modal so the user only acknowledges the
   * auto-mode research preview once per session. Never persisted to the server.
   *
   * Modeled as a plain record (not a `Set`) so immer's structural-sharing
   * producer handles it natively without the MapSet plugin.
   */
  autoConfirmedSessions: Record<string, true>;
  /**
   * Where each session's trust dial stood when Plan was switched on, so
   * switching Plan off puts it back rather than guessing.
   *
   * Client-only and ephemeral, like the auto confirmation beside it: the server
   * stores one permission mode per session, and "the mode you were in before"
   * is a fact about this person's last few clicks, not about the session. A
   * session with nothing remembered falls back to the runtime's own default,
   * which is what a fresh session would have had.
   */
  modeBeforePlan: Record<string, string>;
  /**
   * Session ids that have acknowledged what Full autonomy means, so the dial's
   * confirmation is asked once rather than on every switch back.
   *
   * Ephemeral like the two above, and deliberately so for now: decision 5 of the
   * `trust-dial` spec makes this a durable user-level acknowledgement the SERVER
   * requires on every autonomy write. Until that lands, this is a client-side
   * courtesy — it may soften the ritual, never the gate.
   */
  autonomyConfirmedSessions: Record<string, true>;
  /**
   * Session ids where a person has waved away the offer to make the stop they
   * just picked the default for every new session (spec `trust-dial`, decision
   * 6C).
   *
   * Per session and ephemeral, which is the whole point: "not now" is an answer
   * about this conversation, not a preference worth storing on the server. It
   * keeps the offer from reappearing every time they move the dial in the
   * session where they already said no, and a new session asks again — by which
   * time they may well want it.
   */
  defaultStopOfferDismissed: Record<string, true>;
}

/**
 * Forget everything keyed by a session id.
 *
 * Every one of these maps is session-keyed and unbounded, and none of them is
 * reachable once the session entry is gone — so a map that is not swept here
 * grows for the life of the tab. Add a session-keyed field above, add it here.
 */
function forgetSession(state: SessionChatStoreState, sessionId: string): void {
  delete state.sessions[sessionId];
  delete state.autoConfirmedSessions[sessionId];
  delete state.modeBeforePlan[sessionId];
  delete state.autonomyConfirmedSessions[sessionId];
  delete state.defaultStopOfferDismissed[sessionId];
}

/**
 * Whether an over-limit session may be dropped by the LRU.
 *
 * Idle is not enough. A session holding an unsent COMPOSER DRAFT must survive
 * too (DOR-480): that draft is text a person typed and never sent, and it is the
 * one thing in this entry the server cannot hand back — everything else
 * re-derives from history on the next visit. Without this, visiting 20 other
 * conversations silently deleted it, which one person running ten agents across
 * five projects does in an ordinary afternoon. (The compose-next QUEUE is
 * guarded by the same rule in the session-stream store, where the queue lives.)
 */
function isEvictable(session: SessionState | undefined): boolean {
  return session !== undefined && session.status === 'idle' && session.input.trim() === '';
}

/**
 * Move `sessionId` to the front of the LRU and drop evictable sessions past the
 * retention cap. Shared by `initSession` and `touchSession` so the two can never
 * disagree about what is safe to delete.
 */
function touchAndEvict(state: SessionChatStoreState, sessionId: string): void {
  const order = [sessionId, ...state.sessionAccessOrder.filter((id: string) => id !== sessionId)];
  for (const id of order.slice(MAX_RETAINED_SESSIONS)) {
    if (isEvictable(state.sessions[id])) forgetSession(state, id);
  }
  state.sessionAccessOrder = order.filter((id: string) => id in state.sessions);
}

interface SessionChatStoreActions {
  /** Create a session entry with default state if not already present. Calls touchSession. */
  initSession: (sessionId: string) => void;
  /** Remove a session and its access order entry. */
  destroySession: (sessionId: string) => void;
  /** Shallow-merge patch into a session. Auto-initializes if not present. */
  updateSession: (sessionId: string, patch: Partial<SessionState>) => void;
  /**
   * Move session to front of access order. Evicts the oldest sessions beyond
   * MAX_RETAINED_SESSIONS that are both idle AND holding no unsent draft — see
   * {@link isEvictable}.
   */
  touchSession: (sessionId: string) => void;
  /** Return session state, or DEFAULT_SESSION_STATE for unknown IDs. */
  getSession: (sessionId: string) => SessionState;
  /** Record that a session has confirmed entry into the `'auto'` permission mode. */
  recordAutoConfirmed: (sessionId: string) => void;
  /** Whether a session has already confirmed the `'auto'` permission-mode preview. */
  hasConfirmedAuto: (sessionId: string) => boolean;
  /** Remember the trust mode a session was in before Plan took over. */
  recordModeBeforePlan: (sessionId: string, mode: string) => void;
  /** Record that a session has acknowledged what Full autonomy means. */
  recordAutonomyConfirmed: (sessionId: string) => void;
  /** Stop offering to make a stop the default in this session. */
  dismissDefaultStopOffer: (sessionId: string) => void;
}

/**
 * Zustand store for session-keyed chat state.
 *
 * Decouples chat state from the React component lifecycle so sessions
 * can stream concurrently, resume instantly on switch, and expose
 * background activity indicators in the sidebar.
 */
export const useSessionChatStore = create<SessionChatStoreState & SessionChatStoreActions>()(
  devtools(
    immer((set, get) => ({
      sessions: {},
      sessionAccessOrder: [],
      autoConfirmedSessions: {},
      modeBeforePlan: {},
      autonomyConfirmedSessions: {},
      defaultStopOfferDismissed: {},

      initSession: (sessionId) => {
        // Skip store mutation if session already exists — prevents setState-during-render
        // warnings when called synchronously during the render phase.
        if (get().sessions[sessionId]) return;
        set(
          (state) => {
            // Double-check inside set() for concurrent call safety
            if (state.sessions[sessionId]) return;
            // Increment mountGeneration so stale closures (e.g. a setMessages callback
            // captured by a previous component instance for the same session ID) can
            // detect they are stale and drop their writes rather than corrupting the
            // newly-initialized session state.
            state.sessions[sessionId] = {
              ...DEFAULT_SESSION_STATE,
              orphanHooks: new Map(),
              mountGeneration: ++globalMountGenerationCounter,
            };
            // Inline touchSession to avoid double-dispatch
            touchAndEvict(state, sessionId);
          },
          false,
          'session-chat/initSession'
        );
      },

      destroySession: (sessionId) =>
        set(
          (state) => {
            forgetSession(state, sessionId);
            state.sessionAccessOrder = state.sessionAccessOrder.filter(
              (id: string) => id !== sessionId
            );
          },
          false,
          'session-chat/destroySession'
        ),

      updateSession: (sessionId, patch) =>
        set(
          (state) => {
            if (!state.sessions[sessionId]) {
              state.sessions[sessionId] = { ...DEFAULT_SESSION_STATE, orphanHooks: new Map() };
            }
            Object.assign(state.sessions[sessionId], patch);
          },
          false,
          'session-chat/updateSession'
        ),

      touchSession: (sessionId) =>
        set(
          (state) => {
            touchAndEvict(state, sessionId);
          },
          false,
          'session-chat/touchSession'
        ),

      getSession: (sessionId) => {
        return get().sessions[sessionId] ?? DEFAULT_SESSION_STATE;
      },

      recordAutoConfirmed: (sessionId) =>
        set(
          (state) => {
            state.autoConfirmedSessions[sessionId] = true;
          },
          false,
          'session-chat/recordAutoConfirmed'
        ),

      hasConfirmedAuto: (sessionId) => {
        return get().autoConfirmedSessions[sessionId] === true;
      },

      recordModeBeforePlan: (sessionId, mode) =>
        set(
          (state) => {
            state.modeBeforePlan[sessionId] = mode;
          },
          false,
          'session-chat/recordModeBeforePlan'
        ),

      recordAutonomyConfirmed: (sessionId) =>
        set(
          (state) => {
            state.autonomyConfirmedSessions[sessionId] = true;
          },
          false,
          'session-chat/recordAutonomyConfirmed'
        ),

      dismissDefaultStopOffer: (sessionId) =>
        set(
          (state) => {
            state.defaultStopOfferDismissed[sessionId] = true;
          },
          false,
          'session-chat/dismissDefaultStopOffer'
        ),
    })),
    { name: 'SessionChatStore', enabled: import.meta.env.DEV }
  )
);

/** Session-scoped selector — only re-renders when this session's state changes. */
export function useSessionChatState(sessionId: string): SessionState {
  return useSessionChatStore(
    useCallback((s) => s.sessions[sessionId] ?? DEFAULT_SESSION_STATE, [sessionId])
  );
}

/** Granular field selector: messages array for a specific session. */
export function useSessionMessages(sessionId: string): ChatMessage[] {
  return useSessionChatStore(
    useCallback((s) => s.sessions[sessionId]?.messages ?? [], [sessionId])
  );
}

/** Granular field selector: chat status for a specific session. */
export function useSessionStatus(sessionId: string): ChatStatus {
  return useSessionChatStore(
    useCallback((s) => s.sessions[sessionId]?.status ?? 'idle', [sessionId])
  );
}

/**
 * Reactive selector: the trust mode this session was in before Plan was switched
 * on, or `undefined` when nothing is remembered (a session that was already in
 * Plan when it was opened, or one the store has since evicted).
 *
 * @param sessionId - The session to ask about.
 */
export function useModeBeforePlan(sessionId: string): string | undefined {
  return useSessionChatStore(useCallback((s) => s.modeBeforePlan[sessionId], [sessionId]));
}

/**
 * Reactive selector: whether a session has already acknowledged what Full
 * autonomy means.
 *
 * @param sessionId - The session to ask about.
 */
export function useHasConfirmedAutonomy(sessionId: string): boolean {
  return useSessionChatStore(
    useCallback((s) => s.autonomyConfirmedSessions[sessionId] === true, [sessionId])
  );
}

/**
 * Reactive selector: whether this session has waved away the offer to make a
 * stop the default. Re-renders only when this session's answer flips.
 */
export function useHasDismissedDefaultStopOffer(sessionId: string): boolean {
  return useSessionChatStore(
    useCallback((s) => s.defaultStopOfferDismissed[sessionId] === true, [sessionId])
  );
}

/**
 * Reactive selector: whether a session has confirmed the `'auto'` permission-mode
 * research-preview entry. Re-renders only when this session's confirmation flips.
 */
export function useHasConfirmedAuto(sessionId: string): boolean {
  return useSessionChatStore(
    useCallback((s) => s.autoConfirmedSessions[sessionId] === true, [sessionId])
  );
}
