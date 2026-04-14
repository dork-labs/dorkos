import type { ToolCallState } from '../../model/chat-types';
import { ToolApproval } from '../tools/ToolApproval';
import { BatchApprovalBar } from '../tools/BatchApprovalBar';
import { QuestionPrompt } from '../tools/QuestionPrompt';
import type { InteractiveToolHandle } from '../message';

interface InteractiveInputPanelProps {
  sessionId: string;
  /** The active tool call — guaranteed non-null by the parent's mode check. */
  activeInteraction: ToolCallState;
  pendingApprovals: ToolCallState[];
  focusedOptionIndex: number;
  onToolRef: (handle: InteractiveToolHandle | null) => void;
  onToolDecided: (toolCallId: string) => void;
}

/** Renders the interactive input zone (tool approval or question prompt). */
export function InteractiveInputPanel({
  sessionId,
  activeInteraction,
  pendingApprovals,
  focusedOptionIndex,
  onToolRef,
  onToolDecided,
}: InteractiveInputPanelProps) {
  const handleDecided = () => onToolDecided(activeInteraction.toolCallId);

  return (
    <>
      <BatchApprovalBar sessionId={sessionId} pendingApprovals={pendingApprovals} />
      {activeInteraction.interactiveType === 'approval' ? (
        <ToolApproval
          ref={onToolRef}
          sessionId={sessionId}
          toolCallId={activeInteraction.toolCallId}
          toolName={activeInteraction.toolName}
          input={activeInteraction.input || ''}
          isActive
          onDecided={handleDecided}
          timeoutMs={activeInteraction.timeoutMs}
          approvalStartedAt={activeInteraction.approvalStartedAt}
          approvalTitle={activeInteraction.approvalTitle}
          approvalDisplayName={activeInteraction.approvalDisplayName}
          approvalDescription={activeInteraction.approvalDescription}
          approvalBlockedPath={activeInteraction.approvalBlockedPath}
          approvalDecisionReason={activeInteraction.approvalDecisionReason}
          approvalHasSuggestions={activeInteraction.approvalHasSuggestions}
        />
      ) : activeInteraction.interactiveType === 'question' && activeInteraction.questions ? (
        <QuestionPrompt
          ref={onToolRef}
          sessionId={sessionId}
          toolCallId={activeInteraction.toolCallId}
          questions={activeInteraction.questions}
          answers={activeInteraction.answers}
          isActive
          focusedOptionIndex={focusedOptionIndex}
          onDecided={handleDecided}
        />
      ) : null}
    </>
  );
}
