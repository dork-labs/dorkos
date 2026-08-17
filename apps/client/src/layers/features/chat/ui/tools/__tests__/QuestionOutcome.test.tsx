// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { createMockTransport } from '@dorkos/test-utils';
import type { ToolCallPart } from '@dorkos/shared/types';
import { TransportProvider } from '@/layers/shared/model';
import { MessageItem } from '../../message';
import type { MessageAuthor } from '@/layers/shared/model';

// Streamdown pulls in a full markdown pipeline this suite has no use for.
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => (
    <div data-testid="streamdown">{children}</div>
  ),
}));

// RunWithMenu depends on the router and session queries; this suite is about
// one tool part's rendering, and provides neither.
vi.mock('../../message/RunWithMenu', () => ({
  RunWithMenu: () => <div data-testid="run-with-menu" />,
}));

afterEach(cleanup);

const AGENT: MessageAuthor = { kind: 'agent', id: 'dorkbot', displayName: 'DorkBot' };

const QUESTIONS = [
  {
    header: 'Sorting Algorithm',
    question: 'Which sorting algorithm do you prefer for general-purpose use?',
    options: [{ label: 'Quicksort' }, { label: 'Mergesort' }],
    multiSelect: false,
  },
];

/**
 * Render one `AskUserQuestion` tool part exactly as history hands it over —
 * through `MessageItem`, so the branch under test is the real one in
 * `AssistantMessageContent` rather than a hand-picked prop set.
 */
function renderQuestionPart(overrides: Partial<ToolCallPart>) {
  const part: ToolCallPart = {
    type: 'tool_call',
    toolCallId: 'tool-q',
    toolName: 'AskUserQuestion',
    status: 'complete',
    interactiveType: 'question',
    questions: QUESTIONS,
    ...overrides,
  };
  const message = {
    id: 'm1',
    role: 'assistant' as const,
    content: '',
    parts: [part],
    timestamp: '2026-08-15T21:21:34.000Z',
  };
  return render(
    <TransportProvider transport={createMockTransport()}>
      <MessageItem
        message={message}
        sessionId="s1"
        grouping={{ position: 'only' }}
        author={AGENT}
      />
    </TransportProvider>
  );
}

describe('a question that ended in history (DOR-1293)', () => {
  it('an expired question says nobody answered, and claims no answer', () => {
    renderQuestionPart({ status: 'error', questionOutcome: 'expired' });

    const row = screen.getByTestId('question-prompt-unanswered');
    expect(row).toHaveAttribute('data-outcome', 'expired');
    expect(row).toHaveTextContent('Nobody answered in time');
    // The lie this replaced. Its test id is the answered summary's, so its
    // absence is what proves the green receipt is gone rather than merely
    // reworded.
    expect(screen.queryByTestId('question-prompt-submitted')).toBeNull();
    expect(screen.queryByText(/answered/i)?.textContent).not.toMatch(/Question answered/);
  });

  it('a withdrawn question says so, and a dismissed one says so', () => {
    renderQuestionPart({ status: 'error', questionOutcome: 'cancelled' });
    expect(screen.getByTestId('question-prompt-unanswered')).toHaveTextContent(
      'Question withdrawn'
    );

    cleanup();

    renderQuestionPart({ status: 'error', questionOutcome: 'denied' });
    expect(screen.getByTestId('question-prompt-unanswered')).toHaveTextContent(
      'Question dismissed'
    );
  });

  it('a failed question shows what the transcript actually recorded', () => {
    renderQuestionPart({
      status: 'error',
      questionOutcome: 'errored',
      result: 'MCP server "asker" is not connected',
    });

    const row = screen.getByTestId('question-prompt-unanswered');
    expect(row).toHaveTextContent("The question didn't go through");
    // The reason is the one thing the label cannot supply.
    expect(row).toHaveTextContent('MCP server "asker" is not connected');
  });

  it('an answered question still shows the answer it was given', () => {
    renderQuestionPart({ questionOutcome: 'answered', answers: { '0': 'Mergesort' } });

    const row = screen.getByTestId('question-prompt-submitted');
    expect(row).toHaveTextContent('Sorting Algorithm: Mergesort');
    expect(screen.queryByTestId('question-prompt-unanswered')).toBeNull();
  });

  it('an answered question nobody here answered still collapses', () => {
    // The observing-client case: settled, but this browser never held the
    // answers. It keeps the generic summary — the empty-answers fallback exists
    // for exactly this, and the fix must not take it away.
    renderQuestionPart({ questionOutcome: 'answered' });

    expect(screen.getByTestId('question-prompt-submitted')).toHaveTextContent('Question answered');
  });

  it('a question with no recorded outcome falls back to the old rule', () => {
    // A transcript written before this field existed, or a path nothing has
    // taught to set it. Settled-means-answered is wrong in the expired case and
    // right in every other, which is why the field had to be added rather than
    // the rule inverted.
    renderQuestionPart({});

    expect(screen.getByTestId('question-prompt-submitted')).toHaveTextContent('Question answered');
  });

  it('a pending question still renders the form to answer', () => {
    renderQuestionPart({ status: 'pending' });

    expect(
      screen.getByRole('radiogroup', {
        name: 'Which sorting algorithm do you prefer for general-purpose use?',
      })
    ).toBeDefined();
    expect(screen.queryByTestId('question-prompt-unanswered')).toBeNull();
  });
});
