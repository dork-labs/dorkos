// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render as renderBare, screen, fireEvent, cleanup } from '@testing-library/react';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import type { ToolCallState } from '../../../model/chat-types';
import { InteractiveInputPanel } from '../InteractiveInputPanel';

// The panel answers a whole burst itself — the batch bar's two transport calls,
// now behind the stacked card — so it needs a transport the way it always did.
const transport = createMockTransport();
const render = (ui: React.ReactElement) =>
  renderBare(<TransportProvider transport={transport}>{ui}</TransportProvider>);

// Stub the heavy children so the test focuses on the panel's callback wiring.
// One mock now, because the whole card family lives in one slice.
vi.mock('@/layers/features/ask', () => ({
  ApprovalPrompt: ({ onDecided }: { onDecided?: () => void }) => (
    <button data-testid="approve" onClick={() => onDecided?.()} />
  ),
  QuestionPrompt: ({ onDecided }: { onDecided?: (a: Record<string, string>) => void }) => (
    <button data-testid="submit-answers" onClick={() => onDecided?.({ '0': 'Blue' })} />
  ),
  AskStack: () => null,
}));

// Nothing is waiting on the fleet in these cases: the panel reads the shared
// list only to decide whether to draw the burst card above the active one.
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

  describe('queued messages behind the card', () => {
    // This panel replaces the ENTIRE composer, queue panel included, for as
    // long as an approval card is up. The messages survive, but the only mark
    // that said so vanished at exactly the moment it reassures.
    function renderWithQueue(queueDepth: number) {
      render(
        <InteractiveInputPanel
          sessionId="session-1"
          activeInteraction={approvalInteraction}
          pendingApprovals={[]}
          focusedOptionIndex={-1}
          onToolRef={() => {}}
          onToolDecided={vi.fn()}
          queueDepth={queueDepth}
        />
      );
    }

    it('says how many messages are waiting', () => {
      renderWithQueue(3);
      expect(screen.getByText('3 messages are waiting — they send once you answer.')).toBeDefined();
    });

    it('reads naturally for a single message', () => {
      renderWithQueue(1);
      expect(screen.getByText('1 message is waiting — it sends once you answer.')).toBeDefined();
    });

    it('says nothing when the queue is empty', () => {
      renderWithQueue(0);
      expect(screen.queryByText(/waiting/)).toBeNull();
    });
  });
});
