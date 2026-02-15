import { useRef, useState, useEffect, useCallback } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronRight } from 'lucide-react';
import type { ChatMessage, MessageGrouping } from '../model/use-chat-session';
import { StreamingText } from './StreamingText';
import { ToolCallCard } from './ToolCallCard';
import { ToolApproval } from './ToolApproval';
import type { ToolApprovalHandle } from './ToolApproval';
import { QuestionPrompt } from './QuestionPrompt';
import type { QuestionPromptHandle } from './QuestionPrompt';
import { useAppStore } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';

export type InteractiveToolHandle = ToolApprovalHandle | QuestionPromptHandle;

function useToolCallVisibility(
  status: string,
  autoHide: boolean,
): boolean {
  const initialStatusRef = useRef(status);
  const [visible, setVisible] = useState(
    !(autoHide && initialStatusRef.current === 'complete')
  );

  useEffect(() => {
    if (
      autoHide &&
      status === 'complete' &&
      initialStatusRef.current !== 'complete'
    ) {
      const timer = setTimeout(() => setVisible(false), 5_000);
      return () => clearTimeout(timer);
    }
  }, [status, autoHide]);

  if (!autoHide) return true;

  return visible;
}

function AutoHideToolCall({
  part,
  autoHide,
  expandToolCalls,
}: {
  part: { toolCallId: string; toolName: string; input?: string; result?: string; status: 'pending' | 'running' | 'complete' | 'error' };
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

interface MessageItemProps {
  message: ChatMessage;
  grouping: MessageGrouping;
  sessionId: string;
  isNew?: boolean;
  isStreaming?: boolean;
  /** The toolCallId of the currently active interactive tool (for keyboard shortcuts) */
  activeToolCallId?: string | null;
  /** Callback to register the active tool's imperative handle */
  onToolRef?: (handle: InteractiveToolHandle | null) => void;
  /** Index of keyboard-focused option in QuestionPrompt */
  focusedOptionIndex?: number;
}

function formatTime(timestamp: string): string {
  try {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function MessageItem({ message, grouping, sessionId, isNew = false, isStreaming = false, activeToolCallId, onToolRef, focusedOptionIndex = -1 }: MessageItemProps) {
  const isUser = message.role === 'user';
  const { showTimestamps, expandToolCalls, autoHideToolCalls } = useAppStore();
  const [compactionExpanded, setCompactionExpanded] = useState(false);
  const { position, groupIndex } = grouping;
  const showIndicator = position === 'only' || position === 'first';
  const isGroupStart = position === 'only' || position === 'first';
  const isGroupEnd = position === 'only' || position === 'last';

  // Ref callbacks to report active interactive tool handle up to ChatPanel
  const approvalRefCallback = useCallback((handle: ToolApprovalHandle | null) => {
    onToolRef?.(handle);
  }, [onToolRef]);

  const questionRefCallback = useCallback((handle: QuestionPromptHandle | null) => {
    onToolRef?.(handle);
  }, [onToolRef]);

  const parts = message.parts ?? [];

  // Find the index of the last text part for cursor placement during streaming
  let lastTextPartIndex = -1;
  if (!isUser) {
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].type === 'text') {
        lastTextPartIndex = i;
        break;
      }
    }
  }

  return (
    <motion.div
      initial={isNew ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
      className={cn(
        'group relative flex gap-3 px-4 transition-colors duration-150',
        isGroupStart ? 'pt-4' : 'pt-0.5',
        isGroupEnd ? 'pb-3' : 'pb-0.5',
        isUser ? 'bg-user-msg hover:bg-user-msg/90' : 'hover:bg-muted/20'
      )}
    >
      {isGroupStart && groupIndex > 0 && (
        <div className="absolute inset-x-0 top-0 h-px bg-border/20" />
      )}
      {message.timestamp && (
        <span className={cn(
          'hidden sm:inline absolute right-4 top-1 text-xs transition-colors duration-150',
          showTimestamps
            ? 'text-muted-foreground/60'
            : 'text-muted-foreground/0 group-hover:text-muted-foreground/60'
        )}>
          {formatTime(message.timestamp)}
        </span>
      )}
      <div className="flex-shrink-0 w-4 mt-[3px]">
        {showIndicator && (
          isUser ? (
            <ChevronRight className="size-(--size-icon-md) text-muted-foreground" />
          ) : (
            <span className="flex items-center justify-center size-(--size-icon-md) text-muted-foreground text-[10px]">●</span>
          )
        )}
      </div>
      <div className="flex-1 min-w-0 max-w-[80ch]">
        {isUser ? (
          message.messageType === 'command' ? (
            <div className="font-mono text-sm text-muted-foreground truncate">
              {message.content}
            </div>
          ) : message.messageType === 'compaction' ? (
            <div className="w-full">
              <button
                onClick={() => setCompactionExpanded(!compactionExpanded)}
                className="flex items-center gap-2 text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors w-full"
              >
                <div className="h-px flex-1 bg-border/40" />
                <ChevronRight className={cn(
                  'size-3 transition-transform duration-200',
                  compactionExpanded && 'rotate-90'
                )} />
                <span>Context compacted</span>
                <div className="h-px flex-1 bg-border/40" />
              </button>
              {compactionExpanded && (
                <div className="mt-2 text-xs text-muted-foreground/60 whitespace-pre-wrap">
                  {message.content}
                </div>
              )}
            </div>
          ) : (
            <div className="whitespace-pre-wrap break-words">{message.content}</div>
          )
        ) : (
          parts.map((part, i) => {
            if (part.type === 'text') {
              return (
                <div key={`text-${i}`} className="msg-assistant">
                  <StreamingText
                    content={part.text}
                    isStreaming={isStreaming && i === lastTextPartIndex}
                  />
                </div>
              );
            }
            // tool_call part
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
          })
        )}
      </div>
    </motion.div>
  );
}
