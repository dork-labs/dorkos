// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { ToolCallState } from '../../../model/chat-types';
import { InteractiveInputPanel } from '../InteractiveInputPanel';

// Stub the heavy children so the test focuses on the panel's callback wiring.
vi.mock('../../tools/BatchApprovalBar', () => ({ BatchApprovalBar: () => null }));
vi.mock('../../tools/ToolApproval', () => ({
  ToolApproval: ({ onDecided }: { onDecided?: () => void }) => (
    <button data-testid="approve" onClick={() => onDecided?.()} />
  ),
}));
vi.mock('../../tools/QuestionPrompt', () => ({
  QuestionPrompt: ({ onDecided }: { onDecided?: (a: Record<string, string>) => void }) => (
    <button data-testid="submit-answers" onClick={() => onDecided?.({ '0': 'Blue' })} />
  ),
}));

afterEach(cleanup);

const questionInteraction: ToolCallState = {
  toolCallId: 'tc-1',
  toolName: 'AskUserQuestion',
  input: '',
  status: 'pending',
  interactiveType: 'question',
  questions: [
    {
      header: 'Color',
      question: 'Favorite color?',
      options: [{ label: 'Blue' }],
      multiSelect: false,
    },
  ],
};

const approvalInteraction: ToolCallState = {
  toolCallId: 'tc-2',
  toolName: 'Bash',
  input: '{}',
  status: 'pending',
  interactiveType: 'approval',
};

describe('InteractiveInputPanel', () => {
  it('forwards submitted question answers to onToolDecided', () => {
    const onToolDecided = vi.fn();
    render(
      <InteractiveInputPanel
        sessionId="session-1"
        activeInteraction={questionInteraction}
        pendingApprovals={[]}
        focusedOptionIndex={-1}
        onToolRef={() => {}}
        onToolDecided={onToolDecided}
      />
    );

    fireEvent.click(screen.getByTestId('submit-answers'));

    // The answers must reach onToolDecided so they can be persisted onto the
    // tool-call part immediately (no "N questions answered" flicker).
    expect(onToolDecided).toHaveBeenCalledWith('tc-1', { '0': 'Blue' });
  });

  it('calls onToolDecided without answers for tool approvals', () => {
    const onToolDecided = vi.fn();
    render(
      <InteractiveInputPanel
        sessionId="session-1"
        activeInteraction={approvalInteraction}
        pendingApprovals={[]}
        focusedOptionIndex={-1}
        onToolRef={() => {}}
        onToolDecided={onToolDecided}
      />
    );

    fireEvent.click(screen.getByTestId('approve'));

    expect(onToolDecided).toHaveBeenCalledWith('tc-2', undefined);
  });
});
