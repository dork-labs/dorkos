/**
 * Submission, streaming, and tool-interaction logic for a single chat session.
 *
 * Delegates stream scratch refs and event handler wiring to `useStreamHandler`.
 * Manages submission flow, abort handling, and optimistic tool-call state.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { Session } from '@dorkos/shared/types';
import { useTransport } from '@/layers/shared/model';
import { TIMING } from '@/layers/shared/lib';
import { insertOptimisticSession } from '@/layers/entities/session';
import { deriveFromParts } from './stream-event-helpers';
import { streamManager } from './stream-manager';
import { useStreamHandler } from './use-stream-handler';
import type { SessionStoreActions } from './use-session-store-actions';
import type { ChatSessionOptions, ChatStatus } from './chat-types';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

interface UseSessionSubmitParams {
  sessionId: string | null;
  input: string;
  status: ChatStatus;
  transport: ReturnType<typeof useTransport>;
  queryClient: QueryClient;
  selectedCwd: string | null;
  // Option callbacks from ChatSessionOptions — refs are managed internally
  onTaskEvent: ChatSessionOptions['onTaskEvent'];
  onSessionIdChange: ChatSessionOptions['onSessionIdChange'];
  onStreamingDone: ChatSessionOptions['onStreamingDone'];
  transformContent: ChatSessionOptions['transformContent'];
  // Store setters (sourced from useSessionStoreActions)
  setMessages: SessionStoreActions['setMessages'];
  setInput: SessionStoreActions['setInput'];
  setError: SessionStoreActions['setError'];
  setStatus: SessionStoreActions['setStatus'];
  setSessionBusy: SessionStoreActions['setSessionBusy'];
  setSessionStatus: SessionStoreActions['setSessionStatus'];
  setEstimatedTokens: SessionStoreActions['setEstimatedTokens'];
  setStreamStartTime: SessionStoreActions['setStreamStartTime'];
  setIsTextStreaming: SessionStoreActions['setIsTextStreaming'];
  setRateLimitRetryAfter: SessionStoreActions['setRateLimitRetryAfter'];
  setIsRateLimited: SessionStoreActions['setIsRateLimited'];
  /** Pass `setSystemStatusWithClear` here (the version with auto-dismiss). */
  setSystemStatus: SessionStoreActions['setSystemStatusWithClear'];
  setPromptSuggestions: SessionStoreActions['setPromptSuggestions'];
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Submission, streaming, and optimistic tool-call state for a chat session.
 *
 * @returns Stable callbacks for the UI layer.
 */
export function useSessionSubmit({
  sessionId,
  input,
  status,
  transport,
  queryClient,
  selectedCwd,
  onTaskEvent,
  onSessionIdChange,
  onStreamingDone,
  transformContent,
  setMessages,
  setInput,
  setError,
  setStatus,
  setSessionBusy,
  setSessionStatus,
  setEstimatedTokens,
  setStreamStartTime,
  setIsTextStreaming,
  setRateLimitRetryAfter,
  setIsRateLimited,
  setSystemStatus,
  setPromptSuggestions,
}: UseSessionSubmitParams) {
  // ---------------------------------------------------------------------------
  // Stream handler (scratch refs + event handler wiring)
  // ---------------------------------------------------------------------------

  const {
    streamEventHandler,
    currentPartsRef,
    assistantIdRef,
    assistantCreatedRef,
    streamStartTimeRef,
    estimatedTokensRef,
    textStreamingTimerRef,
    isTextStreamingRef,
    onSessionIdChangeRef,
    onStreamingDoneRef,
  } = useStreamHandler({
    sessionId,
    onTaskEvent,
    onSessionIdChange,
    onStreamingDone,
    setMessages,
    setError,
    setStatus,
    setSessionStatus,
    setEstimatedTokens,
    setStreamStartTime,
    setIsTextStreaming,
    setRateLimitRetryAfter,
    setIsRateLimited,
    setSystemStatus,
    setPromptSuggestions,
  });

  // selectedCwd ref — avoids stale closures in async callbacks
  const selectedCwdRef = useRef(selectedCwd);
  useEffect(() => {
    selectedCwdRef.current = selectedCwd;
  }, [selectedCwd]);

  // transformContent ref — option callback kept current each render
  const transformContentRef = useRef(transformContent);
  useEffect(() => {
    transformContentRef.current = transformContent;
  });

  const sessionBusyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup session-busy timer on unmount
  useEffect(() => {
    return () => {
      if (sessionBusyTimerRef.current) clearTimeout(sessionBusyTimerRef.current);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Submission
  // ---------------------------------------------------------------------------

  /** Reset text-streaming and rate-limit state after a stream ends or fails. */
  const resetStreamingState = useCallback(() => {
    if (textStreamingTimerRef.current) clearTimeout(textStreamingTimerRef.current);
    isTextStreamingRef.current = false;
    setIsTextStreaming(false);
    setIsRateLimited(false);
    setRateLimitRetryAfter(null);
  }, [
    setIsTextStreaming,
    setIsRateLimited,
    setRateLimitRetryAfter,
    isTextStreamingRef,
    textStreamingTimerRef,
  ]);

  /**
   * Core submission logic shared by `handleSubmit` and `submitContent`.
   *
   * @param content - The trimmed message text to send.
   * @param clearInput - When true, clears the input state after enqueueing.
   * @param restoreContentOnLock - Content to restore if the session is locked.
   */
  const executeSubmission = useCallback(
    async (content: string, clearInput: boolean, restoreContentOnLock: string) => {
      const targetSessionId = sessionId!;
      // Optimistically insert a placeholder session if not yet in the cache
      const sessions =
        queryClient.getQueryData<Session[]>(['sessions', selectedCwdRef.current]) ?? [];
      if (!sessions.some((s) => s.id === targetSessionId)) {
        const now = new Date().toISOString();
        insertOptimisticSession(queryClient, selectedCwdRef.current, {
          id: targetSessionId,
          title: `Session ${targetSessionId.slice(0, 8)}`,
          createdAt: now,
          updatedAt: now,
          permissionMode: 'default',
        });
      }

      if (clearInput) setInput('');
      setPromptSuggestions([]);
      setError(null);
      currentPartsRef.current = [];
      streamStartTimeRef.current = Date.now();
      estimatedTokensRef.current = 0;
      assistantIdRef.current = crypto.randomUUID();
      assistantCreatedRef.current = false;

      try {
        await streamManager.start({
          transport,
          sessionId: targetSessionId,
          content,
          cwd: selectedCwdRef.current,
          transformContent: transformContentRef.current ?? undefined,
          onEvent: (type, data) => streamEventHandler(type, data, assistantIdRef.current),
          onSessionIdChange: onSessionIdChangeRef.current,
          onStreamingDone: onStreamingDoneRef.current,
        });
        resetStreamingState();
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          resetStreamingState();
          return;
        }

        if ((err as { code?: string }).code === 'SESSION_LOCKED') {
          if (clearInput) setInput(restoreContentOnLock);
          if (sessionBusyTimerRef.current) clearTimeout(sessionBusyTimerRef.current);
          sessionBusyTimerRef.current = setTimeout(() => {
            setSessionBusy(false);
            setError(null);
            sessionBusyTimerRef.current = null;
          }, TIMING.SESSION_BUSY_CLEAR_MS);
          resetStreamingState();
          return;
        }

        resetStreamingState();
      }
    },
    [
      sessionId,
      transport,
      queryClient,
      resetStreamingState,
      setInput,
      setPromptSuggestions,
      setError,
      setSessionBusy,
      streamEventHandler,
      assistantCreatedRef,
      assistantIdRef,
      currentPartsRef,
      estimatedTokensRef,
      onSessionIdChangeRef,
      onStreamingDoneRef,
      streamStartTimeRef,
    ]
  );

  const handleSubmit = useCallback(async () => {
    if (!input.trim() || status === 'streaming') return;
    const userContent = input.trim();
    await executeSubmission(userContent, true, userContent);
  }, [input, status, executeSubmission]);

  /**
   * Submit a message by content string directly, without clearing the input state.
   * Used by the auto-flush mechanism for queued messages.
   */
  const submitContent = useCallback(
    async (content: string) => {
      if (!content.trim() || status === 'streaming') return;
      await executeSubmission(content.trim(), false, '');
    },
    [status, executeSubmission]
  );

  const stop = useCallback(() => {
    if (sessionId) streamManager.abort(sessionId);
    resetStreamingState();
    setStatus('idle');
  }, [sessionId, resetStreamingState, setStatus]);

  /** Retry a failed message submission, resetting the retry counter. */
  const retryMessage = useCallback(
    async (content: string) => {
      setError(null);
      await executeSubmission(content, false, '');
    },
    [executeSubmission, setError]
  );

  /** Optimistically mark a tool call as responded (approved/denied/answered). */
  const markToolCallResponded = useCallback(
    (toolCallId: string) => {
      const part = currentPartsRef.current.find(
        (p) => p.type === 'tool_call' && p.toolCallId === toolCallId
      );
      if (part && part.type === 'tool_call') {
        part.status = 'running';
        const parts = currentPartsRef.current.map((p) => ({ ...p }));
        const derived = deriveFromParts(parts);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantIdRef.current
              ? {
                  ...m,
                  content: derived.content,
                  toolCalls: derived.toolCalls.length > 0 ? derived.toolCalls : [],
                  parts,
                }
              : m
          )
        );
      }
    },
    [setMessages, assistantIdRef, currentPartsRef]
  );

  return { handleSubmit, submitContent, stop, retryMessage, markToolCallResponded };
}
