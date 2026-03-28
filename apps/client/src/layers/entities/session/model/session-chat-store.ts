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
  MessagePart,
  PresenceUpdateEvent,
  HookPart,
} from '@dorkos/shared/types';
import type {
  ChatMessage,
  ChatStatus,
  TransportErrorInfo,
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
  sessionBusy: boolean;

  // --- Streaming metadata ---
  streamStartTime: number | null;
  estimatedTokens: number;
  isTextStreaming: boolean;
  thinkingStart: number | null;

  // --- Session metadata ---
  sessionStatus: SessionStatusEvent | null;
  rateLimitRetryAfter: number | null;
  isRateLimited: boolean;
  systemStatus: string | null;
  promptSuggestions: string[];

  // --- Presence ---
  presenceInfo: PresenceUpdateEvent | null;
  presencePulse: boolean;

  // --- Lifecycle flags ---
  historySeeded: boolean;
  retryCount: number;
  isRemapping: boolean;

  /**
   * Monotonically-increasing counter that increments each time `initSession` creates
   * a fresh entry for this session ID. Captured in per-component closures (e.g.,
   * `setMessages`) so stale closures from a previous component instance can detect
   * that the session has been re-initialized and drop their writes rather than
   * corrupting the new session's state.
   */
  mountGeneration: number;

  // --- Background activity ---
  hasUnseenActivity: boolean;
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
  sessionBusy: false,
  streamStartTime: null,
  estimatedTokens: 0,
  isTextStreaming: false,
  thinkingStart: null,
  sessionStatus: null,
  rateLimitRetryAfter: null,
  isRateLimited: false,
  systemStatus: null,
  promptSuggestions: [],
  presenceInfo: null,
  presencePulse: false,
  historySeeded: false,
  retryCount: 0,
  isRemapping: false,
  hasUnseenActivity: false,
  mountGeneration: 0,
};

interface SessionChatStoreState {
  sessions: Record<string, SessionState>;
  sessionAccessOrder: string[];
}

interface SessionChatStoreActions {
  /** Create a session entry with default state if not already present. Calls touchSession. */
  initSession: (sessionId: string) => void;
  /** Remove a session and its access order entry. */
  destroySession: (sessionId: string) => void;
  /** Atomic key swap — copies state from oldId to newId, removes oldId, updates sessionAccessOrder. */
  renameSession: (oldId: string, newId: string) => void;
  /** Shallow-merge patch into a session. Auto-initializes if not present. */
  updateSession: (sessionId: string, patch: Partial<SessionState>) => void;
  /** Move session to front of access order. Evicts oldest idle sessions beyond MAX_RETAINED_SESSIONS. */
  touchSession: (sessionId: string) => void;
  /** Return session state, or DEFAULT_SESSION_STATE for unknown IDs. */
  getSession: (sessionId: string) => SessionState;
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

      initSession: (sessionId) =>
        set(
          (state) => {
            if (!state.sessions[sessionId]) {
              // Increment mountGeneration so stale closures (e.g. a setMessages callback
              // captured by a previous component instance for the same session ID) can
              // detect they are stale and drop their writes rather than corrupting the
              // newly-initialized session state.
              state.sessions[sessionId] = {
                ...DEFAULT_SESSION_STATE,
                orphanHooks: new Map(),
                mountGeneration: ++globalMountGenerationCounter,
              };
            }
            // Inline touchSession to avoid double-dispatch
            const order = [
              sessionId,
              ...state.sessionAccessOrder.filter((id: string) => id !== sessionId),
            ];
            const toEvict = order.slice(MAX_RETAINED_SESSIONS);
            for (const id of toEvict) {
              if (state.sessions[id]?.status === 'idle') {
                delete state.sessions[id];
              }
            }
            state.sessionAccessOrder = order.filter((id: string) => id in state.sessions);
          },
          false,
          'session-chat/initSession'
        ),

      destroySession: (sessionId) =>
        set(
          (state) => {
            delete state.sessions[sessionId];
            state.sessionAccessOrder = state.sessionAccessOrder.filter(
              (id: string) => id !== sessionId
            );
          },
          false,
          'session-chat/destroySession'
        ),

      renameSession: (oldId, newId) =>
        set(
          (state) => {
            const existing = state.sessions[oldId];
            if (!existing) return;
            state.sessions[newId] = existing;
            delete state.sessions[oldId];
            state.sessionAccessOrder = state.sessionAccessOrder.map((id: string) =>
              id === oldId ? newId : id
            );
          },
          false,
          'session-chat/renameSession'
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
            const order = [
              sessionId,
              ...state.sessionAccessOrder.filter((id: string) => id !== sessionId),
            ];
            const toEvict = order.slice(MAX_RETAINED_SESSIONS);
            for (const id of toEvict) {
              if (state.sessions[id]?.status === 'idle') {
                delete state.sessions[id];
              }
            }
            state.sessionAccessOrder = order.filter((id: string) => id in state.sessions);
          },
          false,
          'session-chat/touchSession'
        ),

      getSession: (sessionId) => {
        return get().sessions[sessionId] ?? DEFAULT_SESSION_STATE;
      },
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
