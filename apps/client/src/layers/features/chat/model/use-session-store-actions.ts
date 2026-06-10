/**
 * Store write actions for a single chat session.
 *
 * Extracts the 14 per-session `useSessionChatStore.updateSession` callbacks from
 * `useChatSession` so the orchestrating hook stays focused on wiring.  Each setter
 * is stable across renders (deps: only `sid`).
 */
import { useCallback, useEffect, useRef } from 'react';
import type { SessionStatusEvent } from '@dorkos/shared/types';
import { useSessionChatStore } from '@/layers/entities/session';
import { TIMING } from '@/layers/shared/lib';
import type { ChatMessage, ChatStatus, TransportErrorInfo, SystemStatusState } from './chat-types';

// ---------------------------------------------------------------------------
// Return type (exported so callers can be typed without reconstructing it)
// ---------------------------------------------------------------------------

export interface SessionStoreActions {
  setMessages: (update: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
  setInput: (value: string) => void;
  setStatus: (nextStatus: ChatStatus) => void;
  setError: (nextError: TransportErrorInfo | null) => void;
  setSessionBusy: (busy: boolean) => void;
  setSessionStatus: (s: SessionStatusEvent | null) => void;
  setEstimatedTokens: (tokens: number) => void;
  setStreamStartTime: (time: number | null) => void;
  setIsTextStreaming: (streaming: boolean) => void;
  setRateLimitRetryAfter: (retryAfter: number | null) => void;
  setIsRateLimited: (limited: boolean) => void;
  /** Writes systemStatus immediately. */
  setSystemStatus: (payload: SystemStatusState | null) => void;
  /** Writes systemStatus with auto-dismiss after SYSTEM_STATUS_DISMISS_MS. */
  setSystemStatusWithClear: (payload: SystemStatusState | null) => void;
  setPromptSuggestions: (suggestions: string[]) => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * All per-session store write callbacks for `useChatSession`.
 *
 * @param sid - Active session ID string (`sessionId ?? ''`).
 * @param isAliveRef - Ref that is `true` while the hook is mounted; prevents
 *   `setMessages` from firing after unmount.
 * @param mountGenerationMapRef - Per-session mount generation map used by
 *   `setMessages` to reject stale-closure writes.
 */
export function useSessionStoreActions(
  sid: string,
  isAliveRef: React.RefObject<boolean>,
  mountGenerationMapRef: React.RefObject<Map<string, number>>
): SessionStoreActions {
  const systemStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup auto-dismiss timer on unmount
  useEffect(() => {
    return () => {
      if (systemStatusTimerRef.current) clearTimeout(systemStatusTimerRef.current);
    };
  }, []);

  const setMessages = useCallback(
    (update: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
      if (!sid || !isAliveRef.current) return;
      const store = useSessionChatStore.getState();
      // Guard against stale closures from a previous component instance that
      // mounted for the same session ID. Uses a per-session Map so background
      // session callbacks still hold the correct generation for THEIR session.
      const expectedGen = mountGenerationMapRef.current?.get(sid);
      if (expectedGen !== undefined) {
        const currentGen = store.getSession(sid).mountGeneration;
        if (currentGen !== expectedGen) return;
      }
      const next = typeof update === 'function' ? update(store.getSession(sid).messages) : update;
      store.updateSession(sid, { messages: next });
    },
    [sid, isAliveRef, mountGenerationMapRef]
  );

  const setInput = useCallback(
    (value: string) => {
      if (!sid) return;
      useSessionChatStore.getState().updateSession(sid, { input: value });
    },
    [sid]
  );

  const setStatus = useCallback(
    (nextStatus: ChatStatus) => {
      if (!sid) return;
      useSessionChatStore.getState().updateSession(sid, { status: nextStatus });
    },
    [sid]
  );

  const setError = useCallback(
    (nextError: TransportErrorInfo | null) => {
      if (!sid) return;
      useSessionChatStore.getState().updateSession(sid, { error: nextError });
    },
    [sid]
  );

  const setSessionBusy = useCallback(
    (busy: boolean) => {
      if (!sid) return;
      useSessionChatStore.getState().updateSession(sid, { sessionBusy: busy });
    },
    [sid]
  );

  const setSessionStatus = useCallback(
    (s: SessionStatusEvent | null) => {
      if (!sid) return;
      useSessionChatStore.getState().updateSession(sid, { sessionStatus: s });
    },
    [sid]
  );

  const setEstimatedTokens = useCallback(
    (tokens: number) => {
      if (!sid) return;
      useSessionChatStore.getState().updateSession(sid, { estimatedTokens: tokens });
    },
    [sid]
  );

  const setStreamStartTime = useCallback(
    (time: number | null) => {
      if (!sid) return;
      useSessionChatStore.getState().updateSession(sid, { streamStartTime: time });
    },
    [sid]
  );

  const setIsTextStreaming = useCallback(
    (streaming: boolean) => {
      if (!sid) return;
      useSessionChatStore.getState().updateSession(sid, { isTextStreaming: streaming });
    },
    [sid]
  );

  const setRateLimitRetryAfter = useCallback(
    (retryAfter: number | null) => {
      if (!sid) return;
      useSessionChatStore.getState().updateSession(sid, { rateLimitRetryAfter: retryAfter });
    },
    [sid]
  );

  const setIsRateLimited = useCallback(
    (limited: boolean) => {
      if (!sid) return;
      useSessionChatStore.getState().updateSession(sid, { isRateLimited: limited });
    },
    [sid]
  );

  const setSystemStatus = useCallback(
    (payload: SystemStatusState | null) => {
      if (!sid) return;
      useSessionChatStore.getState().updateSession(sid, { systemStatus: payload });
    },
    [sid]
  );

  const setSystemStatusWithClear = useCallback(
    (payload: SystemStatusState | null) => {
      if (systemStatusTimerRef.current) {
        clearTimeout(systemStatusTimerRef.current);
        systemStatusTimerRef.current = null;
      }
      setSystemStatus(payload);
      if (payload) {
        systemStatusTimerRef.current = setTimeout(() => {
          setSystemStatus(null);
          systemStatusTimerRef.current = null;
        }, TIMING.SYSTEM_STATUS_DISMISS_MS);
      }
    },
    [setSystemStatus]
  );

  const setPromptSuggestions = useCallback(
    (suggestions: string[]) => {
      if (!sid) return;
      useSessionChatStore.getState().updateSession(sid, { promptSuggestions: suggestions });
    },
    [sid]
  );

  return {
    setMessages,
    setInput,
    setStatus,
    setError,
    setSessionBusy,
    setSessionStatus,
    setEstimatedTokens,
    setStreamStartTime,
    setIsTextStreaming,
    setRateLimitRetryAfter,
    setIsRateLimited,
    setSystemStatus,
    setSystemStatusWithClear,
    setPromptSuggestions,
  };
}
