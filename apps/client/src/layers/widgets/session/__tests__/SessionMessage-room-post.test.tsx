// @vitest-environment jsdom
/**
 * A room post that opened a turn in a room-attached chat is drawn as its
 * author's, with the room it came from, never as the person's own (DOR-2113,
 * FB-40). Resolved and rendered the way the transcript does it: the author
 * comes from `resolveMessageAuthor`, the row from `SessionMessage`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { RoomMessageStamp } from '@dorkos/shared/chat-messages';
import type { ChatMessage } from '@/layers/shared/model';
import { Conversation } from '@/layers/features/conversation';
import { resolveMessageAuthor } from '@/layers/features/chat/lib/resolve-message-author';
import { SESSION_CAPABILITIES } from '../model/session-capabilities';
import { SessionMessage } from '../ui/SessionMessage';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigate,
}));
vi.mock('@/layers/features/entry-actions/ui/EntryRunWithMenu', () => ({
  EntryRunWithMenu: () => <div data-testid="run-with-menu" />,
}));

const POST = '@dorkos-2 This is my answer on the marketplace cleanup.';

const FROM_AGENT: RoomMessageStamp = {
  roomId: 'room-dorkos',
  entryId: 'entry-1',
  roomLabel: '#dorkos',
  author: {
    id: 'author-marketplace',
    kind: 'agent',
    displayName: 'dorkos-marketplace',
    handle: 'dorkos-marketplace',
    agentId: 'agent-marketplace',
    you: false,
  },
};

function userMessage(roomMessage?: RoomMessageStamp): ChatMessage {
  return {
    id: 'u1',
    role: 'user',
    content: POST,
    parts: [{ type: 'text', text: POST }],
    timestamp: new Date().toISOString(),
    ...(roomMessage ? { roomMessage } : {}),
  };
}

function Session({ children }: { children: ReactNode }) {
  return (
    <Conversation.Root surface="session" capabilities={SESSION_CAPABILITIES}>
      {children}
    </Conversation.Root>
  );
}

function renderRow(message: ChatMessage) {
  const author = resolveMessageAuthor(message, { humanName: 'Dorian', runtime: 'claude-code' });
  render(
    <SessionMessage
      message={message}
      sessionId="s"
      grouping={{ position: 'only' }}
      author={author}
    />,
    { wrapper: Session }
  );
  return author;
}

afterEach(() => {
  cleanup();
  navigate.mockReset();
});

describe('a room post in a room-attached chat', () => {
  it("names the agent that posted it and the room, never the person's name", () => {
    const author = renderRow(userMessage(FROM_AGENT));

    expect(author).toMatchObject({ kind: 'agent', displayName: 'dorkos-marketplace' });
    expect(screen.getAllByText('dorkos-marketplace').length).toBeGreaterThan(0);
    expect(screen.queryByText('Dorian')).toBeNull();
    expect(screen.getByTestId('room-post-mark').textContent).toContain('#dorkos');
    expect(screen.queryByTestId('run-with-menu')).toBeNull();
  });

  it('opens the room from the mark', () => {
    renderRow(userMessage(FROM_AGENT));
    screen.getByRole('button', { name: /#dorkos/ }).click();
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/channels', search: { id: 'room-dorkos' } })
    );
  });

  it("keeps the person's own room post as theirs, with the room beside it", () => {
    const own: RoomMessageStamp = {
      ...FROM_AGENT,
      author: { id: 'local', kind: 'human', displayName: 'You', handle: null, you: true },
    };
    const author = renderRow(userMessage(own));

    expect(author).toMatchObject({ kind: 'human', displayName: 'Dorian' });
    expect(screen.getByTestId('room-post-mark')).toBeDefined();
  });

  it('never draws a post whose author the room lost as the person', () => {
    const author = renderRow(userMessage({ roomId: 'room-dorkos', entryId: 'gone' }));

    expect(author.displayName).toBe('Room member');
    expect(screen.queryByText('Dorian')).toBeNull();
  });

  it('draws a message the person typed in the chat as theirs, with no room mark', () => {
    const author = renderRow(userMessage());

    expect(author).toMatchObject({ kind: 'human', displayName: 'Dorian' });
    expect(screen.queryByTestId('room-post-mark')).toBeNull();
  });
});

describe('a comment the person forwarded from a mini app (DOR-3325)', () => {
  const FORWARDED: RoomMessageStamp = {
    roomId: 'room-dm',
    entryId: 'entry-f',
    roomLabel: 'PM',
    author: {
      id: 'author-you',
      kind: 'human',
      displayName: 'Dorian',
      handle: 'dorian',
      you: true,
    },
    via: {
      extensionId: 'dorian-desk',
      appName: 'Dorian Desk',
      itemId: 'item-7',
      itemTitle: 'Pay the Fly invoice',
    },
  };

  it('reads as the person’s own, with a muted via line above the words', () => {
    const author = renderRow(userMessage(FORWARDED));
    expect(author.kind).toBe('human');
    const line = screen.getByTestId('forward-via-line');
    expect(line).toHaveTextContent('via Dorian Desk');
    // The title is the app's label, quoted, never part of the person's words.
    expect(line.querySelector('q')).toHaveTextContent('Pay the Fly invoice');
    expect(screen.getByText(POST)).not.toContainElement(line);
  });

  it('names the item by id when the app sent no title', () => {
    const { itemTitle: _none, ...via } = FORWARDED.via!;
    renderRow(userMessage({ ...FORWARDED, via }));
    expect(screen.getByTestId('forward-via-line')).toHaveTextContent('item item-7');
  });

  it('draws no via line on a message typed in the chat', () => {
    renderRow(userMessage());
    expect(screen.queryByTestId('forward-via-line')).toBeNull();
  });
});
