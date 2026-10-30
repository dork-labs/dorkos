/**
 * The person's own author line: their name, then a muted "(you)" that never
 * truncates (FB-38/55).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { MessageAuthor } from '@/layers/shared/model';
import type { ConversationCapabilities } from '../model/capabilities';
import { Conversation, Message } from '../index';

afterEach(cleanup);

const AT = '2026-08-18T09:45:00.000Z';

const NOTHING: ConversationCapabilities = {
  reactions: false,
  threads: false,
  runWith: false,
  attachments: false,
  mentions: false,
  streamHealth: false,
  presence: false,
  turnStatus: false,
  asks: false,
};

function renderAuthor(author: MessageAuthor, isSelf?: boolean) {
  return render(
    <Conversation.Root surface="room" capabilities={NOTHING}>
      <Message.Root position="first">
        <Message.Body>
          <Message.Author id="author-line" author={author} at={AT} isSelf={isSelf} />
        </Message.Body>
      </Message.Root>
    </Conversation.Root>
  );
}

describe('Message.Author — the person reading', () => {
  it('adds a muted "(you)" after their name when the resolver says it is them', () => {
    renderAuthor({ kind: 'human', id: 'human', displayName: 'Dorian', isSelf: true });
    const mark = screen.getByText('(you)');
    expect(screen.getByText('Dorian')).toBeInTheDocument();
    expect(mark).toHaveClass('text-muted-foreground', 'font-normal', 'shrink-0');
    expect(mark).not.toHaveClass('truncate');
    expect(document.getElementById('author-line')).toHaveTextContent('Dorian(you)');
  });

  it('takes the flag from the host, as a room passes it from its viewer id', () => {
    renderAuthor({ kind: 'human', id: 'author-dorian', displayName: 'Dorian' }, true);
    expect(screen.getByText('(you)')).toBeInTheDocument();
  });

  it('says a plain "You", once, when they have not given a name', () => {
    renderAuthor({ kind: 'human', id: 'human', displayName: 'You', isSelf: true });
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.queryByText('(you)')).toBeNull();
  });

  it('adds nothing for anyone else', () => {
    renderAuthor({ kind: 'human', id: 'author-ana', displayName: 'Ana' });
    expect(screen.queryByText('(you)')).toBeNull();
  });
});
