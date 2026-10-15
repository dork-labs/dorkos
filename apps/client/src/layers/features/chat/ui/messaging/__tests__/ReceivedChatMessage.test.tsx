/**
 * @vitest-environment jsdom
 *
 * A message another chat sent, as the receiving chat draws it (spec
 * `spin-off-chats` §6): its words, and a link back when it is a reply.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ChatMessageStamp } from '@dorkos/shared/chat-messages';
import { ReceivedChatMessages } from '../ReceivedChatMessage';

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigate,
}));
vi.mock('../../message/StreamingText', () => ({
  StreamingText: ({ content }: { content: string }) => <span>{content}</span>,
}));

const STAMP: ChatMessageStamp = {
  id: 'cm-9',
  kind: 'message',
  from: { chatId: 'chat-b', chatTitle: 'Fix it', agentName: 'Builder' },
  text: 'Found it: a race in the upload test.',
  delivery: 'queue',
  status: 'delivered',
  sentAt: '2026-10-09T10:00:00.000Z',
};

describe('ReceivedChatMessages', () => {
  afterEach(() => {
    cleanup();
    navigate.mockClear();
  });

  it('links a reply back to the message it answers, in this chat', () => {
    render(<ReceivedChatMessages stamps={[{ ...STAMP, replyToId: 'cm-1' }]} sessionId="chat-a" />);
    fireEvent.click(screen.getByRole('button', { name: 'Reply to your message' }));
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({ session: 'chat-a', message: 'cm-1' }),
      })
    );
  });

  it('shows no reply link on a message that answers nothing', () => {
    render(<ReceivedChatMessages stamps={[STAMP]} sessionId="chat-a" />);
    expect(screen.getByText('Found it: a race in the upload test.')).toBeTruthy();
    expect(screen.queryByTestId('chat-reply-to')).toBeNull();
  });
});
