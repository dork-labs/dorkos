/**
 * Type definitions for stream event handling.
 *
 * @module features/chat/model/stream-event-types
 */
import type { MessagePart, HookPart, ToolCallPart, BackgroundTaskPart } from '@dorkos/shared/types';
import type { ChatMessage, TransportErrorInfo } from './chat-types';

/**
 * Client-only streaming text part with a stable identity key.
 *
 * `_partId` is never serialized or sent over the wire. It provides a stable
 * React key for text parts during streaming — the parts array is rebuilt on
 * every `text_delta` event, so without a persistent ID React would remount
 * every text node on each delta.
 */
export type StreamingTextPart = { type: 'text'; text: string; _partId: string };

export interface StreamEventDeps {
  currentPartsRef: React.MutableRefObject<MessagePart[]>;
  /** Buffer for hook events that arrive before their owning tool_call_start. */
  orphanHooksRef: React.MutableRefObject<Map<string, HookPart[]>>;
  assistantCreatedRef: React.MutableRefObject<boolean>;
  sessionStatusRef: React.MutableRefObject<
    import('@dorkos/shared/types').SessionStatusEvent | null
  >;
  streamStartTimeRef: React.MutableRefObject<number | null>;
  estimatedTokensRef: React.MutableRefObject<number>;
  textStreamingTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  isTextStreamingRef: React.MutableRefObject<boolean>;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setError: (error: TransportErrorInfo | null) => void;
  setStatus: (status: 'idle' | 'streaming' | 'error') => void;
  setSessionStatus: (status: import('@dorkos/shared/types').SessionStatusEvent | null) => void;
  setEstimatedTokens: (tokens: number) => void;
  setStreamStartTime: (time: number | null) => void;
  setIsTextStreaming: (streaming: boolean) => void;
  setRateLimitRetryAfter: (retryAfter: number | null) => void;
  setIsRateLimited: (limited: boolean) => void;
  rateLimitClearRef: React.MutableRefObject<(() => void) | null>;
  setSystemStatus: (message: string | null) => void;
  setPromptSuggestions: (suggestions: string[]) => void;
  thinkingStartRef: React.MutableRefObject<number | null>;
  sessionId: string;
  onTaskEventRef: React.MutableRefObject<
    ((event: import('@dorkos/shared/types').TaskUpdateEvent) => void) | undefined
  >;
  onSessionIdChangeRef: React.MutableRefObject<((newSessionId: string) => void) | undefined>;
  onStreamingDoneRef: React.MutableRefObject<(() => void) | undefined>;
  /** Set to true before `onSessionIdChange` in done handler to signal that the session change is a remap, not navigation. */
  isRemappingRef: React.MutableRefObject<boolean>;

  // UI command dispatch dependencies
  /** Theme setter ref — wired from useTheme() so ui_command/set_theme works without a React context. */
  themeRef: React.MutableRefObject<(theme: 'light' | 'dark') => void>;
  /** Optional scroll-to-message handler ref. */
  scrollToMessageRef: React.MutableRefObject<((messageId?: string) => void) | undefined>;
  /** Optional agent-switching handler ref — maps to setDir from useDirectoryState. */
  switchAgentRef: React.MutableRefObject<((cwd: string) => void) | undefined>;
}

/** Context object passed to extracted handler functions. */
export interface StreamHandlerHelpers {
  findToolCallPart: (toolCallId: string) => ToolCallPart | undefined;
  findHookById: (hookId: string) => HookPart | undefined;
  findBackgroundTaskPart: (taskId: string) => BackgroundTaskPart | undefined;
  updateAssistantMessage: (assistantId: string) => void;
  currentPartsRef: React.MutableRefObject<MessagePart[]>;
  orphanHooksRef: React.MutableRefObject<Map<string, HookPart[]>>;
}
