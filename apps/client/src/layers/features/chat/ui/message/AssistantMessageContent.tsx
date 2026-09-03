import { useCallback, Fragment } from 'react';
import type { ChatMessage } from '../../model/use-chat-session';
import { useAppStore } from '@/layers/shared/model';
import { groupApprovalReceipts } from '../../lib/group-approval-receipts';
import { isSettledQuestion, questionEnding } from '../../lib/question-state';
import { StreamingText } from './StreamingText';
import {
  ApprovalPrompt,
  AskReceiptRow,
  QuestionPrompt,
  ElicitationPrompt,
  type ApprovalPromptHandle,
  type QuestionPromptHandle,
} from '@/layers/features/ask';
import { useMessageContext } from './MessageContext';
import { SubagentBlock } from './SubagentBlock';
import { ErrorMessageBlock } from './ErrorMessageBlock';
import { MemoryRecallBlock } from './MemoryRecallBlock';
import { PermissionDeniedChip } from './PermissionDeniedChip';
import { CapabilityApprovalTimedOut } from './CapabilityApprovalTimedOut';
import { McpSigninCard } from './McpSigninCard';
import { CompactBoundaryRow } from './CompactBoundaryRow';
import { MessageImage } from './MessageImage';
import { CompactPendingRow } from '../primitives';
import { AutoHideThinking, ToolCallWithApp } from './auto-hiding-parts';
import { CollapsibleRun } from './CollapsibleRun';
import { TouchChipStrip } from '../chips';
import { ApprovalCard } from '@/layers/features/approvals';

/**
 * Renders assistant message content by mapping over message parts.
 * Handles text parts (via StreamingText), tool call parts (via AutoHideToolCall),
 * approval parts (via ApprovalPrompt), and question parts (via QuestionPrompt).
 * Reads session/interaction state from MessageContext instead of props.
 */
export function AssistantMessageContent({ message }: { message: ChatMessage }) {
  const {
    sessionId,
    isStreaming,
    isLatestWidgetMessage,
    isFinalMessage,
    activeToolCallId,
    onToolRef,
    focusedOptionIndex,
    onToolDecided,
    onRetry,
    inputZoneToolCallId,
    textEffect,
    runtimeLabel,
    allowsDenyReason,
  } = useMessageContext();
  const { expandToolCalls, autoHideToolCalls } = useAppStore();
  const parts = message.parts ?? [];

  const approvalRefCallback = useCallback(
    (handle: ApprovalPromptHandle | null) => {
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
          // Retry inside the transcript re-sends the session's LAST user
          // message, so a card only earns the button by passing BOTH tests
          // below. Neither is the other in disguise, and each was found the
          // hard way.
          //
          // LAST (DOR-1677). The prompt Retry would send is the newest one, not
          // the one this card is about — those are the same message only while
          // nothing has come after it. A failure six turns back offering
          // "Retry" re-sends whatever was typed since, without warning, and
          // that includes the case where the person already moved on. Anything
          // following the card takes the offer away: the next prompt, a steer
          // that split the turn, even a quiet staged note, because every one of
          // them changes what "the last user message" means.
          //
          // CLASSIFIABLE (DOR-1649). An UNCATEGORISED part is one nothing could
          // classify — the CLI's own limit and connection notices arrive that
          // way — so there is no `retryable` answer to trust and no way to tell
          // whether re-sending would help or just spend the same limit again.
          //
          // Withholding the button is honest either way: the card still says
          // what went wrong, and the composer is right there. Categorised parts
          // on the final message keep their category's own `retryable` answer.
          // Two other Retry buttons are deliberately NOT gated here, because
          // both are panel-scoped and structurally about the turn that just
          // failed: `TurnFailedNotice` and the transport-error card `ChatPanel`
          // renders under the composer.
          onRetry={isFinalMessage && part.category !== undefined ? onRetry : undefined}
          runtimeLabel={runtimeLabel}
          sessionId={sessionId}
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
          agentId={part.agentId}
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
    if (part.type === 'image') {
      return <MessageImage key={`image-${part.attachmentId}-${i}`} part={part} />;
    }
    // Everything below is a tool call. The narrowing is asserted rather than
    // assumed: this used to be a bare comment saying "at this point
    // part.type === 'tool_call'", and the day a member was added to
    // `MessagePartSchema` that comment became false — an unhandled part fell
    // through and rendered as a broken tool card reading properties it does not
    // have. A guard costs one branch and turns that class of bug into nothing
    // on screen, which is the right outcome for a part a client is too old to
    // understand (ADR 260901-135657).
    if (part.type !== 'tool_call') return null;
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
        <ApprovalPrompt
          key={toolPart.toolCallId}
          ref={isActive ? approvalRefCallback : undefined}
          sessionId={sessionId}
          toolCallId={toolPart.toolCallId}
          toolName={toolPart.toolName}
          input={toolPart.input || ''}
          timeoutMs={toolPart.timeoutMs}
          approvalStartedAt={toolPart.approvalStartedAt}
          approvalRemainingMs={toolPart.approvalRemainingMs}
          approvalParked={toolPart.approvalParked}
          approvalTitle={toolPart.approvalTitle}
          approvalDisplayName={toolPart.approvalDisplayName}
          approvalDescription={toolPart.approvalDescription}
          approvalBlockedPath={toolPart.approvalBlockedPath}
          approvalDecisionReason={toolPart.approvalDecisionReason}
          approvalHasSuggestions={toolPart.approvalHasSuggestions}
          approvalAlwaysAllowScope={toolPart.approvalAlwaysAllowScope}
          isActive={isActive}
          onDecided={onToolDecided ? () => onToolDecided(toolPart.toolCallId) : undefined}
          allowsDenyReason={allowsDenyReason}
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
        <AskReceiptRow
          key={`approval-receipt-${toolPart.toolCallId}`}
          outcome={receipt.outcome}
          reasonGiven={receipt.reasonGiven}
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
        </AskReceiptRow>
      );
    }
    // Gated on `interactiveType` ALONE. A question whose `questions` array
    // failed to parse is still a question — the producers decide that, by tool
    // name — and gating on the array sent it to the plain tool card, where it
    // rendered as `AskUserQuestion` with raw JSON input and no ending at all
    // (DOR-1293). It has no options to offer, which is what `?? []` says.
    if (toolPart.interactiveType === 'question') {
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
          questions={toolPart.questions ?? []}
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
