import { useRef, useState, useEffect, useCallback } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { ChatMessage, HookState } from '../../model/use-chat-session';
import { useAppStore } from '@/layers/shared/model';
import { TIMING } from '@/layers/shared/lib';
import { StreamingText } from '../StreamingText';
import { ToolCallCard } from '../ToolCallCard';
import { ToolApproval } from '../ToolApproval';
import type { ToolApprovalHandle } from '../ToolApproval';
import { QuestionPrompt } from '../QuestionPrompt';
import type { QuestionPromptHandle } from '../QuestionPrompt';
import { useMessageContext } from './MessageContext';
import { SubagentBlock } from '../SubagentBlock';
import { ThinkingBlock } from '../ThinkingBlock';
import { ErrorMessageBlock } from '../ErrorMessageBlock';
import { CompactPendingRow } from '../primitives';

/**
 * Determines whether a tool call should be visible based on auto-hide settings.
 * If autoHide is enabled, tool calls that were already complete on mount are hidden immediately.
 * Tool calls that transition to complete are hidden after TIMING.TOOL_CALL_AUTO_HIDE_MS.
 */
function useToolCallVisibility(
  status: string,
  autoHide: boolean,
  hasFailedHook: boolean
): boolean {
  const initialStatusRef = useRef(status);
  // eslint-disable-next-line react-hooks/refs -- Intentional: useState initializer runs once on mount
  const [visible, setVisible] = useState(!(autoHide && initialStatusRef.current === 'complete'));

  useEffect(() => {
    if (autoHide && status === 'complete' && initialStatusRef.current !== 'complete' && !hasFailedHook) {
      const timer = setTimeout(() => setVisible(false), TIMING.TOOL_CALL_AUTO_HIDE_MS);
      return () => clearTimeout(timer);
    }
  }, [status, autoHide, hasFailedHook]);

  if (!autoHide) return true;
  // Keep visible when a hook has failed, even if tool call is complete
  if (hasFailedHook) return true;
  return visible;
}

/**
 * Wraps a ToolCallCard with auto-hide animation behavior.
 * Uses AnimatePresence for exit animation when hiding.
 */
function AutoHideToolCall({
  part,
  autoHide,
  expandToolCalls,
}: {
  part: {
    toolCallId: string;
    toolName: string;
    input?: string;
    result?: string;
    progressOutput?: string;
    status: 'pending' | 'running' | 'complete' | 'error';
    hooks?: HookState[];
  };
  autoHide: boolean;
  expandToolCalls: boolean;
}) {
  const hasFailedHook = part.hooks?.some((h) => h.status === 'error') ?? false;
  const visible = useToolCallVisibility(part.status, autoHide, hasFailedHook);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key={part.toolCallId}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
          className="overflow-hidden"
        >
          <ToolCallCard
            toolCall={{
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input || '',
              result: part.result,
              progressOutput: part.progressOutput,
              status: part.status,
              hooks: part.hooks,
            }}
            defaultExpanded={expandToolCalls}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * Renders assistant message content by mapping over message parts.
 * Handles text parts (via StreamingText), tool call parts (via AutoHideToolCall),
 * approval parts (via ToolApproval), and question parts (via QuestionPrompt).
 * Reads session/interaction state from MessageContext instead of props.
 */
export function AssistantMessageContent({ message }: { message: ChatMessage }) {
  const { sessionId, isStreaming, activeToolCallId, onToolRef, focusedOptionIndex, onToolDecided, onRetry, inputZoneToolCallId, textEffect } =
    useMessageContext();
  const { expandToolCalls, autoHideToolCalls } = useAppStore();
  const parts = message.parts ?? [];

  const approvalRefCallback = useCallback(
    (handle: ToolApprovalHandle | null) => {
      onToolRef?.(handle);
    },
    [onToolRef]
  );

  const questionRefCallback = useCallback(
    (handle: QuestionPromptHandle | null) => {
      onToolRef?.(handle);
    },
    [onToolRef]
  );

  // Find the last text part for streaming cursor placement
  let lastTextPartIndex = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].type === 'text') {
      lastTextPartIndex = i;
      break;
    }
  }

  return (
    <>
      {parts.map((part, i) => {
        if (part.type === 'text') {
          return (
            <div key={(part as { _partId?: string })._partId ?? `text-${i}`} className="msg-assistant">
              <StreamingText
                content={part.text}
                isStreaming={isStreaming && i === lastTextPartIndex}
                textEffect={textEffect}
              />
            </div>
          );
        }
        if (part.type === 'subagent') {
          return <SubagentBlock key={part.taskId} part={part} />;
        }
        if (part.type === 'error') {
          return (
            <ErrorMessageBlock
              key={`error-${i}`}
              message={part.message}
              category={part.category}
              details={part.details}
              onRetry={onRetry}
            />
          );
        }
        if (part.type === 'thinking') {
          return (
            <ThinkingBlock
              key={`thinking-${i}`}
              text={part.text}
              isStreaming={part.isStreaming ?? false}
              elapsedMs={part.elapsedMs}
            />
          );
        }
        // At this point part.type === 'tool_call' — all other variants have been handled above.
        const toolPart = part;
        if (toolPart.interactiveType === 'approval') {
          // When this tool call is being handled in the input zone, show a compact placeholder
          if (toolPart.toolCallId === inputZoneToolCallId) {
            return <CompactPendingRow key={toolPart.toolCallId} type="approval" />;
          }
          const isActive = toolPart.toolCallId === activeToolCallId;
          return (
            <ToolApproval
              key={toolPart.toolCallId}
              ref={isActive ? approvalRefCallback : undefined}
              sessionId={sessionId}
              toolCallId={toolPart.toolCallId}
              toolName={toolPart.toolName}
              input={toolPart.input || ''}
              timeoutMs={toolPart.timeoutMs}
              isActive={isActive}
              onDecided={onToolDecided ? () => onToolDecided(toolPart.toolCallId) : undefined}
            />
          );
        }
        if (toolPart.interactiveType === 'question' && toolPart.questions) {
          // When this tool call is being handled in the input zone, show a compact placeholder
          if (toolPart.toolCallId === inputZoneToolCallId) {
            return <CompactPendingRow key={toolPart.toolCallId} type="question" />;
          }
          const isActive = toolPart.toolCallId === activeToolCallId;
          return (
            <QuestionPrompt
              key={toolPart.toolCallId}
              ref={isActive ? questionRefCallback : undefined}
              sessionId={sessionId}
              toolCallId={toolPart.toolCallId}
              questions={toolPart.questions}
              answers={toolPart.answers ?? (toolPart.status !== 'pending' ? {} : undefined)}
              isActive={isActive}
              focusedOptionIndex={isActive ? focusedOptionIndex : -1}
            />
          );
        }
        return (
          <AutoHideToolCall
            key={toolPart.toolCallId}
            part={toolPart}
            autoHide={autoHideToolCalls}
            expandToolCalls={expandToolCalls}
          />
        );
      })}
    </>
  );
}
