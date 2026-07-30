// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { useRoomDraftStore, useRoomReplyTargetStore } from '@/layers/entities/room';
import { TooltipProvider } from '@/layers/shared/ui';
import { RoomEntryRow } from '../ui/RoomEntryRow';

/** A desktop: `useIsMobile` reads matchMedia, and the menu branches on it. */
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  useRoomDraftStore.setState({ drafts: {} });
  useRoomReplyTargetStore.setState({ targets: {}, focusRequests: {} });
});

function entry(overrides: Partial<RoomEntry> = {}): RoomEntry {
  return {
    roomId: 'room-1',
    seq: 1,
    id: 'entry-1',
    authorId: 'ana',
    kind: 'post',
    body: { text: 'why is the build slow?' },
    mentions: [],
    sessionId: null,
    cascadeRoot: 'entry-1',
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-07-26T10:00:00.000Z',
    ...overrides,
  };
}

function renderRow(target: RoomEntry = entry()) {
  return render(
    <RoomEntryRow
      roomId="room-1"
      entry={target}
      author={{ id: 'ana', kind: 'agent', displayName: 'Ana', color: '#888' }}
      authorRef={{ id: 'ana', kind: 'agent', displayName: 'Ana', mentionHandle: 'ana' }}
      viewerAuthorId="author-you"
      grouping={{ position: 'only' }}
    />,
    { wrapper: ({ children }) => <TooltipProvider>{children}</TooltipProvider> }
  );
}

describe('RoomEntryRow — the action surface', () => {
  it('draws every action as a button named by the action set', () => {
    renderRow();
    const toolbar = screen.getByTestId('entry-actions');

    expect(
      within(toolbar)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual(['Reply in thread', 'Copy text', 'Mention Ana']);
  });

  it('makes the message itself the one tab stop', () => {
    // The keyboard path starts here: reaching the toolbar means reaching the
    // message first, which is also the only stop a room costs per message.
    renderRow();

    expect(screen.getByTestId('room-entry')).toHaveAttribute('tabindex', '0');
  });

  it('does not repeat the author, who is already on screen', () => {
    // Naming the article "Message from Ana" over a row that visibly says "Ana"
    // makes a screen reader say it twice — the DOR-583 shape. Session chat gives
    // its rows no name for the same reason.
    renderRow();

    expect(screen.getByTestId('room-entry')).not.toHaveAccessibleName();
  });

  it('keeps every action out of the tab order, always', () => {
    // The tab order has to be CLOSED for a room to cost one press per message.
    // Opening it while the row has focus reads like it would work and does not:
    // focusing the row makes its buttons tabbable in the same tick, so the next
    // Tab lands on the first one anyway and fifty messages still cost a hundred
    // and fifty presses.
    renderRow();
    const toolbar = screen.getByTestId('entry-actions');

    for (const button of within(toolbar).getAllByRole('button')) {
      expect(button).toHaveAttribute('tabindex', '-1');
    }
  });

  it('announces the actions as a toolbar', () => {
    renderRow();

    expect(screen.getByRole('toolbar', { name: 'Message actions' })).toBeInTheDocument();
  });

  it('moves into the actions on an arrow key', () => {
    renderRow();
    const row = screen.getByTestId('room-entry');
    row.focus();
    fireEvent.keyDown(row, { key: 'ArrowRight' });

    expect(screen.getByRole('button', { name: 'Reply in thread' })).toHaveFocus();
  });

  it('moves into the actions on Enter', () => {
    renderRow();
    const row = screen.getByTestId('room-entry');
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });

    expect(screen.getByRole('button', { name: 'Reply in thread' })).toHaveFocus();
  });

  it('steps along the actions with arrows, wrapping at the ends', () => {
    renderRow();
    const row = screen.getByTestId('room-entry');
    row.focus();
    fireEvent.keyDown(row, { key: 'ArrowRight' });

    const reply = screen.getByRole('button', { name: 'Reply in thread' });
    const copy = screen.getByRole('button', { name: 'Copy text' });
    const mention = screen.getByRole('button', { name: 'Mention Ana' });

    fireEvent.keyDown(reply, { key: 'ArrowRight' });
    expect(copy).toHaveFocus();

    fireEvent.keyDown(copy, { key: 'ArrowRight' });
    expect(mention).toHaveFocus();

    // Wraps rather than dead-ending, so the set can be cycled without looking.
    fireEvent.keyDown(mention, { key: 'ArrowRight' });
    expect(reply).toHaveFocus();

    fireEvent.keyDown(reply, { key: 'ArrowLeft' });
    expect(mention).toHaveFocus();
  });

  it('gives the message back its focus on Escape', () => {
    // The way out. Without it, a keyboard reader who stepped into the toolbar
    // has to Tab forward and come all the way back around.
    renderRow();
    const row = screen.getByTestId('room-entry');
    row.focus();
    fireEvent.keyDown(row, { key: 'ArrowRight' });

    fireEvent.keyDown(screen.getByRole('button', { name: 'Reply in thread' }), { key: 'Escape' });

    expect(row).toHaveFocus();
  });

  it('leaves an arrow pressed inside the message text alone', () => {
    // Only the row itself opens the toolbar. Otherwise an arrow key used to move
    // a caret through selected text would yank focus away mid-selection.
    renderRow();
    const content = document.querySelector('[data-slot="message-content"]')!;
    fireEvent.keyDown(content, { key: 'ArrowRight', bubbles: true });

    expect(screen.getByRole('button', { name: 'Reply in thread' })).not.toHaveFocus();
  });

  it('renders links as safety-gated buttons, so no native link menu is at stake', () => {
    // Pins the premise behind having NO carve-out for a right-click on a link:
    // `MarkdownContent` never emits an `<a href>`, so the browser's own menu has
    // no "Copy link address" to offer and our menu is taking nothing away. If
    // this ever fails, the carve-out has to be reconsidered.
    renderRow(entry({ body: { text: 'see [the run](https://example.com/run)' } }));
    const row = screen.getByTestId('room-entry');

    expect(within(row).queryByRole('link')).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'the run' })).toBeInTheDocument();
  });

  it('aims the composer at the thread when the reply button is pressed', () => {
    renderRow(entry({ id: 'reply-9', parentEntryId: 'root-1', threadRootEntryId: 'root-1' }));

    fireEvent.click(screen.getByRole('button', { name: 'Reply in thread' }));

    // The root, not the reply that was pressed — see `replyRootFor`.
    expect(useRoomReplyTargetStore.getState().targets['room-1']).toBe('root-1');
  });

  it('gives a notice no actions at all', () => {
    // Nobody said it, so there is no author to mention and nothing to answer.
    renderRow(entry({ kind: 'notice', body: { text: 'Ana stopped replying here' } }));

    expect(screen.queryByTestId('entry-actions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('room-entry')).not.toBeInTheDocument();
  });
});
