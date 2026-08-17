import { useRef, useState, useEffect, useCallback, Fragment } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronRight } from 'lucide-react';
import type { MessagePart } from '@dorkos/shared/types';
import type { ChatMessage, HookState } from '../../model/use-chat-session';
import { useAppStore } from '@/layers/shared/model';
import { TIMING } from '@/layers/shared/lib';
import { groupApprovalReceipts } from '../../lib/group-approval-receipts';
import { isSettledQuestion, questionEnding } from '../../lib/question-state';
import { StreamingText } from './StreamingText';
import { ToolCallCard } from '../tools/ToolCallCard';
import { ToolApproval } from '../tools/ToolApproval';
import type { ToolApprovalHandle } from '../tools/ToolApproval';
import { ApprovalReceiptGroup } from '../tools/ApprovalReceiptGroup';
import { QuestionPrompt } from '../tools/QuestionPrompt';
import type { QuestionPromptHandle } from '../tools/QuestionPrompt';
import { ElicitationPrompt } from '../tools/ElicitationPrompt';
import { useMessageContext } from './MessageContext';
import { SubagentBlock } from './SubagentBlock';
import { ThinkingBlock } from './ThinkingBlock';
import { ErrorMessageBlock } from './ErrorMessageBlock';
import { MemoryRecallBlock } from './MemoryRecallBlock';
import { PermissionDeniedChip } from './PermissionDeniedChip';
import { CapabilityApprovalTimedOut } from './CapabilityApprovalTimedOut';
import { McpSigninCard } from './McpSigninCard';
import { CompactBoundaryRow } from './CompactBoundaryRow';
import { CompactPendingRow, CollapsibleCard } from '../primitives';
import { TouchChipStrip } from '../chips';
import { McpAppBlock } from '@/layers/features/mcp-apps';
import { ApprovalCard } from '@/layers/features/approvals';

/**
 * Derive the MCP server name from a namespaced MCP tool name
 * (`mcp__<server>__<tool>`). Returns undefined for non-MCP tools.
 */
function mcpServerFromToolName(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp__')) return undefined;
  return toolName.split('__')[1] || undefined;
}

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
 * A tool card plus the inline MCP App its result points at (SEP-1865), when it
 * has one.
 *
 * Shared by the plain tool path and the approval-receipt path: an MCP tool that
 * had to ask permission first is still an MCP tool, and gating it must not cost
 * it its App. Renders exactly the card alone when there is no `ui://` reference
 * or the tool has not completed.
 */
function ToolCallWithApp({
  part,
  sessionId,
  autoHide,
  expandToolCalls,
}: {
  part: Extract<MessagePart, { type: 'tool_call' }>;
  sessionId: string;
  autoHide: boolean;
  expandToolCalls: boolean;
}) {
  const mcpServer = part.ui ? mcpServerFromToolName(part.toolName) : undefined;
  const card = (
    <AutoHideToolCall part={part} autoHide={autoHide} expandToolCalls={expandToolCalls} />
  );
  if (!part.ui || part.status !== 'complete' || !mcpServer) return card;
  return (
    <div className="flex flex-col gap-2">
      {card}
      <McpAppBlock sessionId={sessionId} serverName={mcpServer} uri={part.ui.resourceUri} />
    </div>
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
    isLatestWidgetMessage,
    activeToolCallId,
    onToolRef,
    focusedOptionIndex,
    onToolDecided,
    onRetry,
    inputZoneToolCallId,
    textEffect,
    runtimeLabel,
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

  // Which receipt speaks for each answered approval — computed once per render
  // so a batch answer collapses to a single line instead of one line per ask.
  const receiptGroups = groupApprovalReceipts(parts);

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
        <div key={`text-${i}`} className="msg-assistant">
          <StreamingText
            content={part.text}
            isStreaming={isStreaming && i === lastTextPartIndex}
            textEffect={textEffect}
            sessionId={sessionId}
            isLatestWidgetMessage={isLatestWidgetMessage}
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
          runtimeLabel={runtimeLabel}
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
    if (part.type === 'memory_recall') {
      return (
        <MemoryRecallBlock
          key={`memory-recall-${i}`}
          mode={part.mode}
          memories={part.memories}
          isStreaming={part.isStreaming ?? false}
        />
      );
    }
    if (part.type === 'permission_denied') {
      return (
        <PermissionDeniedChip
          key={`permission-denied-${part.toolCallId}-${i}`}
          toolName={part.toolName}
          reasonType={part.reasonType}
          reason={part.reason}
          message={part.message}
        />
      );
    }
    if (part.type === 'compact_boundary') {
      return (
        <CompactBoundaryRow
          key={`compact-boundary-${i}`}
          trigger={part.trigger}
          preTokens={part.preTokens}
          postTokens={part.postTokens}
          failed={part.failed}
          error={part.error}
        />
      );
    }
    if (part.type === 'capability_approval') {
      // An agent's held destructive capability call (DOR-939). The same card a
      // person answers on the dashboard, rendered inline — approving it resolves
      // the same approval through the capability decision route, and the agent's
      // held call resumes in this turn. Once the agent has stopped waiting, the
      // card becomes a terminal note: the request outlives the hold (DOR-987).
      if (part.outcome === 'timeout') {
        return (
          <CapabilityApprovalTimedOut
            key={`capability-approval-${part.approval.approvalId}`}
            title={part.approval.capabilityTitle}
          />
        );
      }
      return (
        <ApprovalCard
          key={`capability-approval-${part.approval.approvalId}`}
          approval={part.approval}
        />
      );
    }
    if (part.type === 'mcp_signin') {
      // An OAuth sign-in the agent asked for (DOR-1004). The link and its custody
      // disclosure live here, on a card, instead of in the agent's prose — and
      // the card is what brings the agent back once the sign-in lands.
      return <McpSigninCard key={`mcp-signin-${part.agentId}-${part.flowId}`} part={part} />;
    }
    // At this point part.type === 'tool_call' — all other variants have been handled above.
    const toolPart = part;
    if (toolPart.interactiveType === 'approval' && toolPart.status === 'pending') {
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
          approvalRemainingMs={toolPart.approvalRemainingMs}
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
    // An answered approval leaves a record where it was asked. The record is
    // the point, so the line renders regardless of what the tool-call auto-hide
    // setting does to the tool card beneath it.
    const receipt = receiptGroups.get(i);
    if (receipt) {
      if (receipt.leadIndex !== i) return null; // Its lead already speaks for it.
      const members = receipt.indices
        .map((index) => parts[index])
        .filter((member) => member.type === 'tool_call');
      return (
        <ApprovalReceiptGroup
          key={`approval-receipt-${toolPart.toolCallId}`}
          group={receipt}
          members={members}
          lead={toolPart}
        >
          {members.map((member) => (
            <ToolCallWithApp
              key={member.toolCallId}
              part={member}
              sessionId={sessionId}
              autoHide={autoHideToolCalls}
              expandToolCalls={expandToolCalls}
            />
          ))}
        </ApprovalReceiptGroup>
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
          // The empty-record fallback is what collapses the card for a client
          // that did not submit the answer itself — it has no answers to show,
          // but the question is over. It must NOT survive a question that ended
          // WITHOUT one: an empty record reads as "answered, details unknown",
          // and that is how a question nobody answered came back green
          // (DOR-1293). `questionOutcome` is the one field that can tell the two
          // apart; where nothing set it, the old rule stands.
          answers={toolPart.answers ?? (isSettledQuestion(toolPart) ? {} : undefined)}
          outcome={questionEnding(toolPart)}
          result={toolPart.result}
          isActive={isActive}
          focusedOptionIndex={isActive ? focusedOptionIndex : -1}
          onDecided={
            onToolDecided ? (answers) => onToolDecided(toolPart.toolCallId, answers) : undefined
          }
        />
      );
    }
    // A plain tool call: its card, plus the inline MCP App (SEP-1865) when its
    // completed result carries a `ui://` reference.
    return (
      <ToolCallWithApp
        key={toolPart.toolCallId}
        part={toolPart}
        sessionId={sessionId}
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
      {/* The turn's own record of what it touched. It sits after the parts, at
          the turn level, because that is what lets it outlive the tool cards
          above it once they auto-hide.

          `_streaming` marks the in-progress bubble — the turn that is running
          right now — which is what keeps the strip's live row up through the
          gaps between tool calls instead of collapsing and reopening on each
          one. A message read back from history never carries it, so a reopened
          transcript shows the settled summary and nothing moves. */}
      <TouchChipStrip
        parts={parts}
        sessionId={sessionId}
        turnActive={message._streaming === true}
      />
    </>
  );
}
