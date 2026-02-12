import { motion } from 'motion/react';
import { ChevronRight } from 'lucide-react';
import type { ChatMessage, MessageGrouping } from '../../hooks/use-chat-session';
import { StreamingText } from './StreamingText';
import { ToolCallCard } from './ToolCallCard';
import { ToolApproval } from './ToolApproval';
import { QuestionPrompt } from './QuestionPrompt';
import { cn } from '../../lib/utils';

interface MessageItemProps {
  message: ChatMessage;
  grouping: MessageGrouping;
  sessionId: string;
  isNew?: boolean;
  isStreaming?: boolean;
}

function formatTime(timestamp: string): string {
  try {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function MessageItem({ message, grouping, sessionId, isNew = false, isStreaming = false }: MessageItemProps) {
  const isUser = message.role === 'user';
  const { position, groupIndex } = grouping;
  const showIndicator = position === 'only' || position === 'first';
  const isGroupStart = position === 'only' || position === 'first';
  const isGroupEnd = position === 'only' || position === 'last';

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
        <span className="absolute right-4 top-1 text-xs text-muted-foreground/0 group-hover:text-muted-foreground/60 max-md:text-muted-foreground/40 transition-colors duration-150">
          {formatTime(message.timestamp)}
        </span>
      )}
      <div className="flex-shrink-0 w-4 mt-[3px]">
        {showIndicator && (
          isUser ? (
            <ChevronRight className="size-[--size-icon-md] text-muted-foreground" />
          ) : (
            <span className="flex items-center justify-center size-[--size-icon-md] text-muted-foreground text-[10px]">●</span>
          )
        )}
      </div>
      <div className="flex-1 min-w-0 max-w-[80ch]">
        {isUser ? (
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
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
              return (
                <ToolApproval
                  key={part.toolCallId}
                  sessionId={sessionId}
                  toolCallId={part.toolCallId}
                  toolName={part.toolName}
                  input={part.input || ''}
                />
              );
            }
            if (part.interactiveType === 'question' && part.questions) {
              return (
                <QuestionPrompt
                  key={part.toolCallId}
                  sessionId={sessionId}
                  toolCallId={part.toolCallId}
                  questions={part.questions}
                  answers={part.answers}
                />
              );
            }
            return (
              <ToolCallCard
                key={part.toolCallId}
                toolCall={{
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  input: part.input || '',
                  result: part.result,
                  status: part.status,
                }}
              />
            );
          })
        )}
      </div>
    </motion.div>
  );
}
