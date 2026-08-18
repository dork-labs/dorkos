// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { createMockTransport } from '@dorkos/test-utils';
import type { ToolCallPart } from '@dorkos/shared/types';
import { TransportProvider } from '@/layers/shared/model';
import { SessionMessage } from '../../message';
import type { MessageAuthor } from '@/layers/shared/model';
import { Conversation } from '@/layers/features/conversation';
import type { ConversationCapabilities } from '@/layers/features/conversation';

/**
 * The session's capability table, declared here rather than imported.
 *
 * `SESSION_CAPABILITIES` moved to `widgets/session/model` with its host in P4,
 * and a feature may not import a widget's model — ESLint refuses it. The
 * shipped table is exercised where it is mounted (`widgets/session`); what this
 * suite needs is a conversation for the row to read, and that is data.
 */
const SESSION_CAPABILITIES: ConversationCapabilities = {
  reactions: false,
  threads: false,
  runWith: true,
  attachments: true,
  mentions: false,
  streamHealth: false,
  presence: false,
  turnStatus: true,
  asks: true,
};

// Streamdown pulls in a full markdown pipeline this suite has no use for.
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => (
    <div data-testid="streamdown">{children}</div>
  ),
}));

// EntryRunWithMenu depends on the router and session queries; this suite is about
// one tool part's rendering, and provides neither.
vi.mock('@/layers/features/entry-actions/ui/EntryRunWithMenu', () => ({
  EntryRunWithMenu: () => <div data-testid="run-with-menu" />,
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
 * through `SessionMessage`, so the branch under test is the real one in
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
      {/* The conversation a session page mounts — the row reads its
          capabilities from it. */}
      <Conversation.Root surface="session" capabilities={SESSION_CAPABILITIES}>
        <SessionMessage
          message={message}
          sessionId="s1"
          grouping={{ position: 'only' }}
          author={AGENT}
        />
      </Conversation.Root>
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

  it('a question the transcript never resolved says exactly that', () => {
    // The orphan: a turn that died between the ask and any result. It is not
    // "expired" (no timer ran out) and certainly not "answered" — the only true
    // thing to say is that no answer was recorded.
    renderQuestionPart({ questionOutcome: 'unresolved' });

    const row = screen.getByTestId('question-prompt-unanswered');
    expect(row).toHaveAttribute('data-outcome', 'unresolved');
    expect(row).toHaveTextContent('No answer was recorded');
    expect(screen.queryByTestId('question-prompt-submitted')).toBeNull();
  });

  it('an unanswered question keeps the transcript’s own words', () => {
    // Whatever the model was told rides under the label. The label is the
    // summary; the result is the evidence, and a reader chasing what an agent
    // actually saw should never have to take the summary's word for it.
    renderQuestionPart({
      status: 'error',
      questionOutcome: 'expired',
      result: 'User did not respond within 10 minutes',
    });

    expect(screen.getByTestId('question-prompt-unanswered')).toHaveTextContent(
      'User did not respond within 10 minutes'
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
    // The LIVE path, which is the only place the field is absent: a question
    // resolved mid-turn has no `interaction_resolved` ending folded onto it yet.
    // History always carries one — claude-code re-derives it on every read, and
    // the log-backed fold stamps `unresolved` on anything it never resolved.
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

  it('a question whose options did not parse still renders as a question', () => {
    // The server routes on tool NAME, so a malformed `AskUserQuestion` arrives
    // marked `interactiveType: 'question'` with no `questions` array. The
    // client used to gate on the array too, dropping it to a plain tool card
    // titled `AskUserQuestion` — no ending, and the reason hidden (DOR-1293).
    renderQuestionPart({
      questions: undefined,
      status: 'error',
      questionOutcome: 'expired',
      result: 'User did not respond within 10 minutes',
    });

    const row = screen.getByTestId('question-prompt-unanswered');
    expect(row).toHaveTextContent('Nobody answered in time');
    expect(screen.queryByTestId('tool-call-card')).toBeNull();
  });

  it('keeps the newlines in a multi-line refusal, and bounds a huge one', () => {
    // A rule refusal quotes the whole blocked command, which is routinely a
    // multi-line pipeline; a `<p>` collapsed it into one run-on line. And an
    // errored result can run to tens of thousands of characters, which a
    // transcript cannot render in place.
    const multiline =
      'Permission to use Bash with command\n  git log \\\n  | head -3\nhas been denied.';
    renderQuestionPart({ status: 'error', questionOutcome: 'denied', result: multiline });

    const output = screen.getByTestId('question-prompt-result').querySelector('pre');
    expect(output?.className).toContain('whitespace-pre-wrap');
    expect(output?.textContent).toBe(multiline);

    cleanup();

    const huge = 'x'.repeat(20_000);
    renderQuestionPart({ status: 'error', questionOutcome: 'errored', result: huge });
    const clamped = screen.getByTestId('question-prompt-result').querySelector('pre');
    expect(clamped?.textContent?.length).toBe(5120);
    expect(screen.getByRole('button', { name: /Show full output/ })).toBeDefined();
  });

  it('a RECOVERED pending question is answerable, whatever history said', () => {
    // The DOR-1269 recovery deliberately re-pends a question from the
    // snapshot's `pendingInteractions`, and history's copy of that same
    // question carries `unresolved` (nothing has resolved it — that is the
    // point). A terminal row drawn over it would be a card nobody can answer.
    renderQuestionPart({ status: 'pending', questionOutcome: 'unresolved' });

    expect(
      screen.getByRole('radiogroup', {
        name: 'Which sorting algorithm do you prefer for general-purpose use?',
      })
    ).toBeDefined();
    expect(screen.queryByTestId('question-prompt-unanswered')).toBeNull();
  });
});
