import { useRef, useState, useEffect, useCallback, Fragment } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronRight } from 'lucide-react';
import type { ChatMessage, HookState } from '../../model/use-chat-session';
import { useAppStore } from '@/layers/shared/model';
import { TIMING } from '@/layers/shared/lib';
import { StreamingText } from './StreamingText';
import { ToolCallCard } from '../tools/ToolCallCard';
import { ToolApproval } from '../tools/ToolApproval';
import type { ToolApprovalHandle } from '../tools/ToolApproval';
import { QuestionPrompt } from '../tools/QuestionPrompt';
import type { QuestionPromptHandle } from '../tools/QuestionPrompt';
import { ElicitationPrompt } from '../tools/ElicitationPrompt';
import { useMessageContext } from './MessageContext';
import { SubagentBlock } from './SubagentBlock';
import { ThinkingBlock } from './ThinkingBlock';
import { ErrorMessageBlock } from './ErrorMessageBlock';
import { CompactPendingRow, CollapsibleCard } from '../primitives';

/**
 * Determines whether a tool call should be visible based on auto-hide settings.
 * If autoHide is enabled, tool calls that were already complete on mount are hidden immediately.
 * Tool calls that transition to complete are hidden after TIMING.TOOL_CALL_AUTO_HIDE_MS.
 */
function useToolCallVisibility(status: string, autoHide: boolean, hasFailedHook: boolean): boolean {
  const initialStatusRef = useRef(status);
  // eslint-disable-next-line react-hooks/refs -- Intentional: useState initializer runs once on mount
  const [visible, setVisible] = useState(!(autoHide && initialStatusRef.current === 'complete'));

  useEffect(() => {
    if (
      autoHide &&
      status === 'complete' &&
      initialStatusRef.current !== 'complete' &&
      !hasFailedHook
    ) {
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
    startedAt?: number;
    completedAt?: number;
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
              startedAt: part.startedAt,
              completedAt: part.completedAt,
            }}
            defaultExpanded={expandToolCalls}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * Wraps a ThinkingBlock with auto-hide animation behavior.
 * Reuses useToolCallVisibility by mapping isStreaming to a status string.
 */
function AutoHideThinking({
  part,
  autoHide,
  index,
}: {
  part: { text: string; isStreaming?: boolean; elapsedMs?: number };
  autoHide: boolean;
  index: number;
}) {
  const status = part.isStreaming ? 'running' : 'complete';
  const visible = useToolCallVisibility(status, autoHide, false);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key={`thinking-${index}`}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
          className="overflow-hidden"
        >
          <ThinkingBlock
            text={part.text}
            isStreaming={part.isStreaming ?? false}
            elapsedMs={part.elapsedMs}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Minimum run length before the "N more" collapse kicks in. */
const COLLAPSE_THRESHOLD = 4;
/** Number of items shown before the collapse button. */
const VISIBLE_COUNT = 2;

/**
 * Wraps a run of consecutive tool/thinking elements with a "show N more" collapse.
 * Runs shorter than COLLAPSE_THRESHOLD render all children directly.
 * Uses CollapsibleCard as the visual base to stay in the same family as tool calls and thinking.
 */
export function CollapsibleRun({ children }: { children: React.ReactNode[] }) {
  const [expanded, setExpanded] = useState(false);

  if (children.length <= COLLAPSE_THRESHOLD || expanded) {
    return <>{children}</>;
  }

  const hiddenCount = children.length - VISIBLE_COUNT;

  return (
    <>
      {children.slice(0, VISIBLE_COUNT)}
      <CollapsibleCard
        expanded={false}
        onToggle={() => setExpanded(true)}
        hideChevron
        className="border-l-muted-foreground/15"
        header={
          <>
            <ChevronRight className="text-muted-foreground size-(--size-icon-xs)" />
            <span className="text-3xs text-muted-foreground font-mono">
              and {hiddenCount} more steps&hellip;
            </span>
          </>
        }
      >
        <></>
      </CollapsibleCard>
    </>
  );
}

/**
 * Renders assistant message content by mapping over message parts.
 * Handles text parts (via StreamingText), tool call parts (via AutoHideToolCall),
 * approval parts (via ToolApproval), and question parts (via QuestionPrompt).
 * Reads session/interaction state from MessageContext instead of props.
 */
export function AssistantMessageContent({ message }: { message: ChatMessage }) {
  const {
    sessionId,
    isStreaming,
    activeToolCallId,
    onToolRef,
    focusedOptionIndex,
    onToolDecided,
    onRetry,
    inputZoneToolCallId,
    textEffect,
  } = useMessageContext();
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

  /** Render a single part by index. */
  function renderPart(part: (typeof parts)[number], i: number): React.ReactNode {
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
    if (part.type === 'background_task') {
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
        <AutoHideThinking
          key={`thinking-${i}`}
          part={part}
          autoHide={autoHideToolCalls}
          index={i}
        />
      );
    }
    if (part.type === 'elicitation') {
      return (
        <ElicitationPrompt
          key={`elicitation-${part.interactionId}`}
          sessionId={sessionId}
          interactionId={part.interactionId}
          serverName={part.serverName}
          message={part.message}
          mode={part.mode}
          url={part.url}
          requestedSchema={part.requestedSchema}
          status={part.status}
          action={part.action}
        />
      );
    }
    // At this point part.type === 'tool_call' — all other variants have been handled above.
    const toolPart = part;
    if (toolPart.interactiveType === 'approval') {
      if (toolPart.toolCallId === inputZoneToolCallId) {
        return (
          <CompactPendingRow
            key={toolPart.toolCallId}
            type="approval"
            toolName={toolPart.toolName}
            toolInput={toolPart.input}
          />
        );
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
          approvalStartedAt={toolPart.approvalStartedAt}
          approvalTitle={toolPart.approvalTitle}
          approvalDisplayName={toolPart.approvalDisplayName}
          approvalDescription={toolPart.approvalDescription}
          approvalBlockedPath={toolPart.approvalBlockedPath}
          approvalDecisionReason={toolPart.approvalDecisionReason}
          approvalHasSuggestions={toolPart.approvalHasSuggestions}
          isActive={isActive}
          onDecided={onToolDecided ? () => onToolDecided(toolPart.toolCallId) : undefined}
        />
      );
    }
    if (toolPart.interactiveType === 'question' && toolPart.questions) {
      if (toolPart.toolCallId === inputZoneToolCallId) {
        return (
          <CompactPendingRow
            key={toolPart.toolCallId}
            type="question"
            toolName={toolPart.toolName}
            toolInput={toolPart.input}
          />
        );
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
  }

  // Group consecutive collapsible parts (thinking + non-interactive tool calls) into runs.
  // Runs exceeding COLLAPSE_THRESHOLD get wrapped in CollapsibleRun.
  type Segment = { type: 'single'; index: number } | { type: 'run'; indices: number[] };
  const segments: Segment[] = [];
  let currentRun: number[] = [];

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const isCollapsible = p.type === 'thinking' || (p.type === 'tool_call' && !p.interactiveType);
    if (isCollapsible) {
      currentRun.push(i);
    } else {
      if (currentRun.length > 0) {
        segments.push(
          currentRun.length === 1
            ? { type: 'single', index: currentRun[0] }
            : { type: 'run', indices: [...currentRun] }
        );
        currentRun = [];
      }
      segments.push({ type: 'single', index: i });
    }
  }
  if (currentRun.length > 0) {
    segments.push(
      currentRun.length === 1
        ? { type: 'single', index: currentRun[0] }
        : { type: 'run', indices: [...currentRun] }
    );
  }

  return (
    <>
      {segments.map((seg) => {
        if (seg.type === 'single') {
          const part = parts[seg.index];
          const isCollapsible =
            part.type === 'thinking' || (part.type === 'tool_call' && !part.interactiveType);
          if (isCollapsible) {
            // Single collapsible item still gets vertical breathing room from text
            return (
              <div key={`spacer-${seg.index}`} className="my-3">
                {renderPart(part, seg.index)}
              </div>
            );
          }
          return renderPart(part, seg.index);
        }
        const elements = seg.indices.map((i) => renderPart(parts[i], i));
        return (
          <div key={`run-${seg.indices[0]}`} className="my-3">
            <CollapsibleRun>{elements}</CollapsibleRun>
          </div>
        );
      })}
    </>
  );
}
