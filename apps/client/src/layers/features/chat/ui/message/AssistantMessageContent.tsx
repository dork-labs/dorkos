import { useRef, useState, useEffect, useCallback } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { ChatMessage } from '../../model/use-chat-session';
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

/**
 * Determines whether a tool call should be visible based on auto-hide settings.
 * If autoHide is enabled, tool calls that were already complete on mount are hidden immediately.
 * Tool calls that transition to complete are hidden after TIMING.TOOL_CALL_AUTO_HIDE_MS.
 */
function useToolCallVisibility(status: string, autoHide: boolean): boolean {
  const initialStatusRef = useRef(status);
  // eslint-disable-next-line react-hooks/refs -- Intentional: useState initializer runs once on mount
  const [visible, setVisible] = useState(!(autoHide && initialStatusRef.current === 'complete'));

  useEffect(() => {
    if (autoHide && status === 'complete' && initialStatusRef.current !== 'complete') {
      const timer = setTimeout(() => setVisible(false), TIMING.TOOL_CALL_AUTO_HIDE_MS);
      return () => clearTimeout(timer);
    }
  }, [status, autoHide]);

  if (!autoHide) return true;
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
    status: 'pending' | 'running' | 'complete' | 'error';
  };
  autoHide: boolean;
  expandToolCalls: boolean;
}) {
  const visible = useToolCallVisibility(part.status, autoHide);

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
              status: part.status,
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
  const { sessionId, isStreaming, activeToolCallId, onToolRef, focusedOptionIndex, onToolDecided } =
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
              />
            </div>
          );
        }
        if (part.type === 'subagent') {
          return <SubagentBlock key={part.taskId} part={part} />;
        }
        if (part.interactiveType === 'approval') {
          const isActive = part.toolCallId === activeToolCallId;
          return (
            <ToolApproval
              key={part.toolCallId}
              ref={isActive ? approvalRefCallback : undefined}
              sessionId={sessionId}
              toolCallId={part.toolCallId}
              toolName={part.toolName}
              input={part.input || ''}
              isActive={isActive}
              onDecided={onToolDecided ? () => onToolDecided(part.toolCallId) : undefined}
            />
          );
        }
        if (part.interactiveType === 'question' && part.questions) {
          const isActive = part.toolCallId === activeToolCallId;
          return (
            <QuestionPrompt
              key={part.toolCallId}
              ref={isActive ? questionRefCallback : undefined}
              sessionId={sessionId}
              toolCallId={part.toolCallId}
              questions={part.questions}
              answers={part.answers}
              isActive={isActive}
              focusedOptionIndex={isActive ? focusedOptionIndex : -1}
            />
          );
        }
        return (
          <AutoHideToolCall
            key={part.toolCallId}
            part={part}
            autoHide={autoHideToolCalls}
            expandToolCalls={expandToolCalls}
          />
        );
      })}
    </>
  );
}
