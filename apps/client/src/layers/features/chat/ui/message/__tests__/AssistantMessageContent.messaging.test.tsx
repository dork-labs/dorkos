/**
 * @vitest-environment jsdom
 *
 * Messaging is conversation, not tool use (spec `spin-off-chats` §6): a
 * `chat_send`, `session_start` or `chat_stop` call renders as a Sent card that
 * "Auto-hide tool calls" never hides and a run of tool calls never folds away.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { AssistantMessageContent } from '../AssistantMessageContent';
import type { ChatMessage } from '../../../model/use-chat-session';

vi.mock('../StreamingText', () => ({
  StreamingText: ({ content }: { content: string }) => <span>{content}</span>,
}));
vi.mock('../../tools/ToolCallCard', () => ({
  ToolCallCard: ({ toolCall }: { toolCall: { toolName: string } }) => (
    <div data-testid="tool-call-card">{toolCall.toolName}</div>
  ),
}));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
}));
const { activity } = vi.hoisted(() => ({
  activity: {
    sent: [
      {
        id: 'cm-1',
        kind: 'message',
        to: { chatId: 'chat-b', chatTitle: 'Fix the flaky test', agentName: 'Builder' },
        text: 'Find why the upload test flakes.',
        delivery: 'queue',
        status: 'replied',
        sentAt: '2026-10-09T10:00:00.000Z',
      },
    ] as unknown[],
    stops: [] as unknown[],
  },
}));
vi.mock('../../../model/messaging/use-chat-activity', () => ({
  useChatActivity: () => activity,
}));
vi.mock('../MessageContext', () => ({
  useMessageContext: () => ({
    sessionId: 'chat-a',
    isStreaming: false,
    isFinalMessage: true,
    activeToolCallId: null,
    focusedOptionIndex: -1,
  }),
}));
// The person's preference that hides every finished tool call, switched ON.
vi.mock('@/layers/shared/model', () => ({
  useAppStore: () => ({ expandToolCalls: false, autoHideToolCalls: true }),
}));

const readTool = (id: string) => ({
  type: 'tool_call' as const,
  toolCallId: id,
  toolName: 'Read',
  input: '{}',
  status: 'complete' as const,
});

function message(parts: ChatMessage['parts']): ChatMessage {
  return { id: 'm1', role: 'assistant', content: '', parts, timestamp: '2026-10-09T10:00:00.000Z' };
}

describe('messaging calls stay in the conversation', () => {
  afterEach(cleanup);

  it('draws chat_send as a Sent card with the receiver and its state, tools hidden or not', () => {
    render(
      <AssistantMessageContent
        message={message([
          {
            type: 'tool_call',
            toolCallId: 'send-1',
            toolName: 'mcp__dorkos__chat_send',
            input: JSON.stringify({ to: 'chat-b', message: 'Find why the upload test flakes.' }),
            result: JSON.stringify({
              ok: true,
              messageId: 'cm-1',
              chatId: 'chat-b',
              status: 'queued',
            }),
            status: 'complete',
          },
        ])}
      />
    );
    const card = screen.getByTestId('sent-chat-card');
    expect(card.textContent).toContain('Builder');
    expect(card.textContent).toContain('Fix the flaky test');
    expect(screen.getByTestId('sent-chat-state').textContent).toBe('Replied');
    expect(screen.queryByTestId('tool-call-card')).toBeNull();
  });

  it('never folds a messaging call into a run of tool calls', () => {
    const parts: ChatMessage['parts'] = [
      readTool('a'),
      readTool('b'),
      {
        type: 'tool_call',
        toolCallId: 'start-1',
        toolName: 'mcp__dorkos__session_start',
        input: JSON.stringify({ prompt: 'Cut the release.', cwd: '/w' }),
        result: JSON.stringify({ sessionId: 'chat-new', status: 'started' }),
        status: 'complete',
      },
      readTool('c'),
      readTool('d'),
      readTool('e'),
      readTool('f'),
      readTool('g'),
    ];
    render(<AssistantMessageContent message={message(parts)} />);
    // Visible whatever happens to the runs of ordinary tool calls around it.
    expect(screen.getByTestId('sent-chat-card').dataset.tool).toBe('session_start');
  });

  it('draws a refused send as failed, with the server’s reason on the line and one click away', () => {
    render(
      <AssistantMessageContent
        message={message([
          {
            type: 'tool_call',
            toolCallId: 'send-2',
            toolName: 'chat_send',
            input: JSON.stringify({ to: 'room-chat', message: 'Hello' }),
            result: JSON.stringify({
              ok: false,
              code: 'NOT_ALLOWED',
              error: 'That chat belongs to a room.',
            }),
            status: 'complete',
          },
        ])}
      />
    );
    expect(screen.getByTestId('sent-chat-state').textContent).toBe('Failed');
    expect(screen.getByTestId('sent-chat-aside').textContent).toContain(
      'That chat belongs to a room.'
    );
    const toggle = screen.getByRole('button', { expanded: false });
    expect(toggle.getAttribute('aria-controls')).toBeNull();
    fireEvent.click(toggle);
    const card = screen.getByTestId('sent-chat-card');
    expect(
      screen.getByRole('button', { expanded: true }).getAttribute('aria-controls')
    ).toBeTruthy();
    expect(card.textContent).toContain('Hello');
    expect(card.querySelectorAll('p')[0]?.textContent).toBe('That chat belongs to a room.');
    expect(screen.queryByText('Open chat →')).toBeNull();
  });

  it('draws a call the runtime marked as an error, or a gate denied, as failed', () => {
    render(
      <AssistantMessageContent
        message={message([
          {
            type: 'tool_call',
            toolCallId: 'send-3',
            toolName: 'mcp__dorkos__chat_send',
            input: JSON.stringify({ to: 'chat-b', message: 'Hi' }),
            result: 'The connection dropped.',
            status: 'error',
          },
          {
            type: 'tool_call',
            toolCallId: 'send-4',
            toolName: 'mcp__dorkos__chat_send',
            input: JSON.stringify({ to: 'chat-b', message: 'Hi' }),
            result: JSON.stringify({ status: 'denied', message: 'Messaging is Blocked.' }),
            status: 'complete',
          },
        ])}
      />
    );
    const states = screen.getAllByTestId('sent-chat-state').map((el) => el.textContent);
    expect(states).toEqual(['Failed', 'Failed']);
    const asides = screen.getAllByTestId('sent-chat-aside').map((el) => el.textContent);
    expect(asides[0]).toContain('The connection dropped.');
    expect(asides[1]).toContain('Messaging is Blocked.');
  });

  it('draws a call held for approval as waiting, with no link to a chat yet', () => {
    render(
      <AssistantMessageContent
        message={message([
          {
            type: 'tool_call',
            toolCallId: 'send-5',
            toolName: 'mcp__dorkos__chat_send',
            input: JSON.stringify({ to: 'agent-bo', message: 'Hi' }),
            result: JSON.stringify({ status: 'approval_required', message: 'Waiting.' }),
            status: 'complete',
          },
        ])}
      />
    );
    expect(screen.getByTestId('sent-chat-state').textContent).toBe('Waiting for approval');
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.queryByText('Open chat →')).toBeNull();
  });

  it('offers no "Open chat" while a send to an agent is still on its way', () => {
    render(
      <AssistantMessageContent
        message={message([
          {
            type: 'tool_call',
            toolCallId: 'send-6',
            toolName: 'mcp__dorkos__chat_send',
            input: JSON.stringify({ to: 'agent-bo', message: 'Hi' }),
            status: 'running',
          },
        ])}
      />
    );
    expect(screen.getByTestId('sent-chat-state').textContent).toBe('Sending');
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.queryByText('Open chat →')).toBeNull();
  });

  it('names the chat a stop reached, and says when nothing was running', () => {
    render(
      <AssistantMessageContent
        message={message([
          {
            type: 'tool_call',
            toolCallId: 'stop-1',
            toolName: 'mcp__dorkos__chat_stop',
            input: JSON.stringify({ chat: 'chat-b', reason: 'wrong branch' }),
            result: JSON.stringify({ stopped: true, chatId: 'chat-b', droppedMessages: 0 }),
            status: 'complete',
          },
          {
            type: 'tool_call',
            toolCallId: 'stop-2',
            toolName: 'mcp__dorkos__chat_stop',
            input: JSON.stringify({ chat: 'chat-b' }),
            result: JSON.stringify({ stopped: false, chatId: 'chat-b', droppedMessages: 0 }),
            status: 'complete',
          },
        ])}
      />
    );
    const cards = screen.getAllByTestId('sent-chat-card');
    expect(cards[0]!.textContent).toContain('Stopped Fix the flaky test');
    expect(cards[0]!.textContent).toContain('wrong branch');
    expect(cards[1]!.dataset.state).toBe('Not running');
    expect(cards[1]!.textContent).toContain('Tried to stop Fix the flaky test');
  });

  it('draws an approved send as its Sent card, not an approval receipt', () => {
    render(
      <AssistantMessageContent
        message={message([
          {
            type: 'tool_call',
            toolCallId: 'send-7',
            toolName: 'mcp__dorkos__chat_send',
            input: JSON.stringify({ to: 'chat-b', message: 'Find why the upload test flakes.' }),
            result: JSON.stringify({ ok: true, messageId: 'cm-1', chatId: 'chat-b' }),
            status: 'complete',
            interactiveType: 'approval',
            approvalOutcome: 'allowed',
            approvalResolvedAt: 1,
          },
        ])}
      />
    );
    expect(screen.getByTestId('sent-chat-state').textContent).toBe('Replied');
    expect(screen.queryByTestId('tool-call-card')).toBeNull();
  });

  it('starts a sentence with a capital when it does not know the agent’s name', () => {
    const before = activity.sent;
    activity.sent = [
      {
        id: 'cm-8',
        kind: 'message',
        to: { chatId: 'chat-c' },
        text: 'Hi',
        delivery: 'queue',
        status: 'replied',
        sentAt: '2026-10-09T10:00:00.000Z',
      },
    ];
    try {
      render(
        <AssistantMessageContent
          message={message([
            {
              type: 'tool_call',
              toolCallId: 'send-8',
              toolName: 'chat_send',
              input: JSON.stringify({ to: 'chat-c', message: 'Hi' }),
              result: JSON.stringify({ ok: true, messageId: 'cm-8', chatId: 'chat-c' }),
              status: 'complete',
            },
          ])}
        />
      );
      fireEvent.click(screen.getByRole('button', { expanded: false }));
      expect(screen.getByText('The agent replied.')).toBeTruthy();
    } finally {
      activity.sent = before;
    }
  });
});
