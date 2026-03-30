/**
 * Stream scratch refs and event handler wiring for a single streaming session.
 *
 * Declares all per-stream mutable refs and wires them into `createStreamEventHandler`.
 * Returned refs are consumed by `useSessionSubmit` for submission setup and
 * `markToolCallResponded`.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { MessagePart, HookPart } from '@dorkos/shared/types';
import { useTheme } from '@/layers/shared/model';
import { createStreamEventHandler } from './stream-event-handler';
import { streamManager } from './stream-manager';
import type { SessionStoreActions } from './use-session-store-actions';
import type { ChatSessionOptions } from './chat-types';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

interface UseStreamHandlerParams {
  sessionId: string | null;
  onTaskEvent: ChatSessionOptions['onTaskEvent'];
  onSessionIdChange: ChatSessionOptions['onSessionIdChange'];
  onStreamingDone: ChatSessionOptions['onStreamingDone'];
  setMessages: SessionStoreActions['setMessages'];
  setError: SessionStoreActions['setError'];
  setStatus: SessionStoreActions['setStatus'];
  setSessionStatus: SessionStoreActions['setSessionStatus'];
  setEstimatedTokens: SessionStoreActions['setEstimatedTokens'];
  setStreamStartTime: SessionStoreActions['setStreamStartTime'];
  setIsTextStreaming: SessionStoreActions['setIsTextStreaming'];
  setRateLimitRetryAfter: SessionStoreActions['setRateLimitRetryAfter'];
  setIsRateLimited: SessionStoreActions['setIsRateLimited'];
  setSystemStatus: SessionStoreActions['setSystemStatusWithClear'];
  setPromptSuggestions: SessionStoreActions['setPromptSuggestions'];
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Per-stream scratch refs and the memoized stream event handler.
 *
 * Returns refs consumed by `useSessionSubmit` for submission setup and optimistic
 * tool-call updates. All refs are stable across re-renders.
 */
export function useStreamHandler({
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
}: UseStreamHandlerParams) {
  // Per-stream scratch buffers — mutated synchronously on every stream event
  const sessionStatusRef = useRef(null);
  const currentPartsRef = useRef<MessagePart[]>([]);
  // Buffer for hook events that arrive before their owning tool_call_start
  const orphanHooksRef = useRef<Map<string, HookPart[]>>(new Map());
  const assistantIdRef = useRef<string>('');
  const assistantCreatedRef = useRef(false);
  const streamStartTimeRef = useRef<number | null>(null);
  const estimatedTokensRef = useRef<number>(0);
  const textStreamingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTextStreamingRef = useRef(false);
  const thinkingStartRef = useRef<number | null>(null);
  const rateLimitClearRef = useRef<(() => void) | null>(null);

  // Called synchronously in the done handler so StreamManager can remap its
  // ActiveStream + timer entries before React re-renders with the new session ID.
  const onRemapRef = useRef<((oldId: string, newId: string) => void) | undefined>(
    (oldId: string, newId: string) => streamManager.remapSession(oldId, newId)
  );

  // UI command dispatch refs — stable so the stream handler never goes stale
  const { setTheme } = useTheme();
  const themeRef = useRef<(theme: 'light' | 'dark') => void>(setTheme);
  const scrollToMessageRef = useRef<((messageId?: string) => void) | undefined>(undefined);
  const switchAgentRef = useRef<((cwd: string) => void) | undefined>(undefined);

  // Option callback refs — updated each render to avoid stale closures
  const onTaskEventRef = useRef(onTaskEvent);
  const onSessionIdChangeRef = useRef(onSessionIdChange);
  const onStreamingDoneRef = useRef(onStreamingDone);

  // Sync callback refs after commit so the stream handler always calls the latest version
  useEffect(() => {
    themeRef.current = setTheme;
    onTaskEventRef.current = onTaskEvent;
    onSessionIdChangeRef.current = onSessionIdChange;
    onStreamingDoneRef.current = onStreamingDone;
    rateLimitClearRef.current = () => {
      setIsRateLimited(false);
      setRateLimitRetryAfter(null);
    };
  });

  const streamEventHandler = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs -- refs captured in closure, .current only read during event handling
      createStreamEventHandler({
        currentPartsRef,
        orphanHooksRef,
        assistantCreatedRef,
        sessionStatusRef,
        streamStartTimeRef,
        estimatedTokensRef,
        textStreamingTimerRef,
        isTextStreamingRef,
        thinkingStartRef,
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
        rateLimitClearRef,
        sessionId: sessionId ?? '',
        onTaskEventRef,
        onSessionIdChangeRef,
        onStreamingDoneRef,
        onRemapRef,
        themeRef,
        scrollToMessageRef,
        switchAgentRef,
      }),
    [
      sessionId,
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
    ]
  );

  return {
    streamEventHandler,
    // Refs consumed by useSessionSubmit
    currentPartsRef,
    assistantIdRef,
    assistantCreatedRef,
    streamStartTimeRef,
    estimatedTokensRef,
    textStreamingTimerRef,
    isTextStreamingRef,
    onSessionIdChangeRef,
    onStreamingDoneRef,
  } as const;
}

/** Inferred return type for consumers. */
export type StreamHandlerResult = ReturnType<typeof useStreamHandler>;
