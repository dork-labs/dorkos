/**
 * @vitest-environment jsdom
 *
 * Messaging is conversation, not tool use (spec `spin-off-chats` §6): a
 * `chat_send`, `session_start` or `chat_stop` call renders as a Sent card that
 * "Auto-hide tool calls" never hides and a run of tool calls never folds away.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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
vi.mock('../../../model/messaging/use-chat-activity', () => ({
  useChatActivity: () => ({
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
    ],
    stops: [],
  }),
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

  it('draws a refused send as failed, with the server’s reason one click away', () => {
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
    screen.getByRole('button', { expanded: false }).click();
  });
});
