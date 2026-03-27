/**
 * Factory for stream event handlers that process SSE events into chat messages.
 *
 * Tool, hook, and background task cases are delegated to `stream-tool-handlers.ts`.
 * Types live in `stream-event-types.ts`, helpers in `stream-event-helpers.ts`.
 *
 * @module features/chat/model/stream-event-handler
 */
import type {
  TextDelta,
  ThinkingDelta,
  DoneEvent,
  ErrorEvent,
  SessionStatusEvent,
  TaskUpdateEvent,
  MessagePart,
  SystemStatusEvent,
  PromptSuggestionEvent,
  UiCommand,
} from '@dorkos/shared/types';
import { TIMING, executeUiCommand } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import type { StreamEventDeps, StreamingTextPart } from './stream-event-types';
import { createStreamHelpers, deriveFromParts } from './stream-event-helpers';
import {
  handleToolCallStart,
  handleToolCallDelta,
  handleToolProgress,
  handleToolCallEnd,
  handleToolResult,
  handleApprovalRequired,
  handleQuestionPrompt,
  handleSubagentStarted,
  handleSubagentProgress,
  handleSubagentDone,
  handleHookStarted,
  handleHookProgress,
  handleHookResponse,
} from './stream-tool-handlers';

export type { StreamEventDeps } from './stream-event-types';

/** Create a stream event handler that processes SSE events into chat messages. */
export function createStreamEventHandler(deps: StreamEventDeps) {
  const {
    currentPartsRef,
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
    rateLimitClearRef,
    setSystemStatus,
    setPromptSuggestions,
    sessionId,
    onTaskEventRef,
    onSessionIdChangeRef,
    onStreamingDoneRef,
  } = deps;

  const helpers = createStreamHelpers(deps);

  return function handleStreamEvent(type: string, data: unknown, assistantId: string) {
    // Auto-clear rate limit on any non-rate-limit event (SDK resumed)
    if (type !== 'rate_limit') {
      rateLimitClearRef.current?.();
    }

    switch (type) {
      case 'thinking_delta': {
        const { text } = data as ThinkingDelta;
        const parts = currentPartsRef.current;
        const lastPart = parts[parts.length - 1];
        if (lastPart && lastPart.type === 'thinking') {
          currentPartsRef.current = [
            ...parts.slice(0, -1),
            { ...lastPart, text: lastPart.text + text },
          ];
        } else {
          // First thinking delta — record start time and create part
          thinkingStartRef.current = Date.now();
          currentPartsRef.current = [
            ...parts,
            { type: 'thinking', text, isStreaming: true } as MessagePart,
          ];
        }
        helpers.updateAssistantMessage(assistantId);
        break;
      }
      case 'text_delta': {
        // Finalize any streaming thinking part — thinking phase is over
        if (thinkingStartRef.current !== null) {
          const elapsedMs = Date.now() - thinkingStartRef.current;
          thinkingStartRef.current = null;
          const updatedParts = currentPartsRef.current.map((p) =>
            p.type === 'thinking' && p.isStreaming ? { ...p, isStreaming: false, elapsedMs } : p
          );
          currentPartsRef.current = updatedParts;
        }
        const { text } = data as TextDelta;
        const parts = currentPartsRef.current;
        const lastPart = parts[parts.length - 1];
        if (lastPart && lastPart.type === 'text') {
          // Immutable update — avoid mid-mutation reads under concurrent rendering.
          // The spread { ...lastPart, text: ... } preserves _partId automatically.
          currentPartsRef.current = [
            ...parts.slice(0, -1),
            { ...lastPart, text: lastPart.text + text },
          ];
        } else {
          // NEW TEXT PART: assign _partId once at creation.
          // parts.length is the stable position of this part in the array at the moment
          // of creation — deterministic, cheap, and sufficient for key stability within
          // a single streaming session.
          const partId = `text-part-${parts.length}`;
          const newPart: StreamingTextPart = { type: 'text', text, _partId: partId };
          currentPartsRef.current = [...parts, newPart as MessagePart];
        }
        estimatedTokensRef.current += text.length / 4;
        setEstimatedTokens(estimatedTokensRef.current);
        if (!isTextStreamingRef.current) {
          isTextStreamingRef.current = true;
          setIsTextStreaming(true);
        }
        if (textStreamingTimerRef.current) clearTimeout(textStreamingTimerRef.current);
        textStreamingTimerRef.current = setTimeout(() => {
          isTextStreamingRef.current = false;
          setIsTextStreaming(false);
        }, 500);
        helpers.updateAssistantMessage(assistantId);
        break;
      }
      case 'tool_call_start':
        handleToolCallStart(helpers, data, assistantId);
        break;
      case 'tool_call_delta':
        handleToolCallDelta(helpers, data, assistantId);
        break;
      case 'tool_progress':
        handleToolProgress(helpers, data, assistantId);
        break;
      case 'tool_call_end':
        handleToolCallEnd(helpers, data, assistantId);
        break;
      case 'tool_result':
        handleToolResult(helpers, data, assistantId);
        break;
      case 'approval_required':
        handleApprovalRequired(helpers, data, assistantId);
        break;
      case 'question_prompt':
        handleQuestionPrompt(helpers, data, assistantId);
        break;
      case 'error': {
        const errorData = data as ErrorEvent;
        // SDK result errors with a category render inline in the message stream.
        // The stream may continue after these (e.g. SDK recovery), so keep status
        // as 'streaming' to preserve inference indicators until the done event.
        if (errorData.category) {
          currentPartsRef.current.push({
            type: 'error',
            message: errorData.message,
            category: errorData.category,
            details: errorData.details,
          });
          helpers.updateAssistantMessage(assistantId);
        } else {
          // Transport-level errors (no category) use the banner and kill streaming
          // status — no more events will follow.
          setError({
            heading: 'Error',
            message: errorData.message,
            retryable: false,
          });
          setStatus('error');
        }
        break;
      }
      case 'rate_limit': {
        const { retryAfter } = data as { retryAfter?: number };
        setRateLimitRetryAfter(retryAfter ?? null);
        setIsRateLimited(true);
        break;
      }
      case 'session_status': {
        const incoming = data as SessionStatusEvent;
        const merged: SessionStatusEvent = {
          ...sessionStatusRef.current,
          ...incoming,
          model: incoming.model ?? sessionStatusRef.current?.model,
          costUsd: incoming.costUsd ?? sessionStatusRef.current?.costUsd,
          contextTokens: incoming.contextTokens ?? sessionStatusRef.current?.contextTokens,
          contextMaxTokens: incoming.contextMaxTokens ?? sessionStatusRef.current?.contextMaxTokens,
          outputTokens: incoming.outputTokens ?? sessionStatusRef.current?.outputTokens,
        };
        sessionStatusRef.current = merged;
        setSessionStatus(merged);
        break;
      }
      case 'task_update': {
        const taskEvent = data as TaskUpdateEvent;
        onTaskEventRef.current?.(taskEvent);
        break;
      }
      case 'background_task_started':
        handleSubagentStarted(helpers, data, assistantId);
        break;
      case 'background_task_progress':
        handleSubagentProgress(helpers, data, assistantId);
        break;
      case 'background_task_done':
        handleSubagentDone(helpers, data, assistantId);
        break;
      case 'hook_started':
        handleHookStarted(helpers, data, assistantId);
        break;
      case 'hook_progress':
        handleHookProgress(helpers, data, assistantId);
        break;
      case 'hook_response':
        handleHookResponse(helpers, data, assistantId);
        break;
      case 'system_status': {
        const { message } = data as SystemStatusEvent;
        setSystemStatus(message);
        break;
      }
      case 'prompt_suggestion': {
        const { suggestions } = data as PromptSuggestionEvent;
        setPromptSuggestions(suggestions);
        break;
      }
      case 'ui_command': {
        const { command } = data as { command: UiCommand };
        const store = useAppStore.getState();
        executeUiCommand(
          {
            store: {
              ...store,
              setSidebarActiveTab: store.setSidebarActiveTab as (tab: string) => void,
            },
            setTheme: deps.themeRef.current,
            scrollToMessage: deps.scrollToMessageRef?.current,
            switchAgent: deps.switchAgentRef?.current,
          },
          command
        );
        break;
      }
      case 'compact_boundary': {
        setMessages((prev) => [
          ...prev,
          {
            id: `compaction-${Date.now()}`,
            role: 'user' as const,
            content: '',
            parts: [],
            timestamp: new Date().toISOString(),
            messageType: 'compaction' as const,
          },
        ]);
        break;
      }
      case 'done': {
        const doneData = data as DoneEvent;
        if (doneData.sessionId && doneData.sessionId !== sessionId) {
          // Flush current streaming state to messages before clearing parts for remap.
          // This prevents the queueMicrotask race in handleToolResult from reading
          // an empty currentPartsRef after we clear it below.
          if (assistantCreatedRef.current && currentPartsRef.current.length > 0) {
            const parts = currentPartsRef.current.map((p) => ({ ...p }));
            const derived = deriveFromParts(parts);
            setMessages((prev) =>
              prev.map((m) =>
                m._streaming && m.role === 'assistant'
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
          currentPartsRef.current = [];
          assistantCreatedRef.current = false;
          // Signal that this sessionId change is a remap — the session change effect
          // must NOT clear messages (ref is read synchronously before the next render).
          deps.isRemappingRef.current = true;
          onSessionIdChangeRef.current?.(doneData.sessionId);
        }

        // Phase 3: remap client-generated IDs to server-assigned IDs immediately.
        // When messageIds is absent (older server), tagged-dedup in the seed effect
        // handles reconciliation via content/position matching.
        if (doneData.messageIds) {
          const { user: serverUserId, assistant: serverAssistantId } = doneData.messageIds;
          setMessages((prev) =>
            prev.map((m) => {
              if (m._streaming && m.role === 'user' && serverUserId) {
                return { ...m, id: serverUserId, _streaming: false };
              }
              if (m._streaming && m.role === 'assistant' && serverAssistantId) {
                return { ...m, id: serverAssistantId, _streaming: false };
              }
              return m;
            })
          );
        }

        if (streamStartTimeRef.current) {
          const elapsed = Date.now() - streamStartTimeRef.current;
          if (elapsed >= TIMING.MIN_STREAM_DURATION_MS) {
            onStreamingDoneRef.current?.();
          }
        }
        streamStartTimeRef.current = null;
        estimatedTokensRef.current = 0;
        // Finalize any still-streaming thinking part (edge case: thinking with no following text_delta)
        if (thinkingStartRef.current !== null) {
          const elapsedMs = Date.now() - thinkingStartRef.current;
          currentPartsRef.current = currentPartsRef.current.map((p) =>
            p.type === 'thinking' && p.isStreaming ? { ...p, isStreaming: false, elapsedMs } : p
          );
        }
        thinkingStartRef.current = null;
        setStreamStartTime(null);
        setEstimatedTokens(0);
        if (textStreamingTimerRef.current) clearTimeout(textStreamingTimerRef.current);
        isTextStreamingRef.current = false;
        setIsTextStreaming(false);
        setSystemStatus(null);

        // Safety net: force-complete any interactive tool calls still marked 'pending'.
        // This handles races where tool_result's queueMicrotask hasn't flushed,
        // or where the transcript parser loaded stale data after a remap.
        setMessages((prev) =>
          prev.map((m) => {
            if (!m.toolCalls?.some((tc) => tc.interactiveType && tc.status === 'pending')) return m;
            return {
              ...m,
              toolCalls: m.toolCalls!.map((tc) =>
                tc.interactiveType && tc.status === 'pending'
                  ? { ...tc, status: 'complete' as const }
                  : tc
              ),
              parts: m.parts.map((p) =>
                p.type === 'tool_call' && p.interactiveType && p.status === 'pending'
                  ? { ...p, status: 'complete' as const }
                  : p
              ),
            };
          })
        );

        setStatus('idle');
        break;
      }
      default: {
        console.warn('[stream] unknown event type:', type, data);
        break;
      }
    }
  };
}
