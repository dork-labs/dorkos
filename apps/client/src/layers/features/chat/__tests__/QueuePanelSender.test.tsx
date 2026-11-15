// @vitest-environment jsdom
/**
 * A queued message another chat sent names its sender above its words, so it
 * never reads as the person's own (DOR-3060; designer copy).
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigate,
}));

import { QueuePanel } from '../ui/input/QueuePanel';
import type { QueueItem } from '../model/use-message-queue';
import { queueHeaderCount, queueSenderOf } from '../lib/queue-sender';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
});
afterEach(() => {
  cleanup();
  navigate.mockReset();
  actions.sendNow.mockReset();
  actions.dontDeliver.mockReset();
});

const SECURITY = {
  agentName: 'Security',
  agentId: 'agent-security',
  chatId: 'chat-1',
  chatTitle: 'Dependency audit for 0.121',
};

const mine = (id: string, content: string): QueueItem => ({
  id,
  content,
  mine: true,
  fromChat: false,
  notice: null,
});
const fromChat = (id: string, content: string, sender: QueueItem['sender']): QueueItem => ({
  id,
  content,
  mine: false,
  fromChat: true,
  sender,
  notice: null,
});

const actions = {
  sendNow: vi.fn(),
  dontDeliver: vi.fn(),
  notices: {} as Record<string, string>,
  sending: new Set<string>(),
};

function panel(
  queue: QueueItem[],
  notices: Record<string, string> = {},
  onFocusComposer: () => void = () => {}
) {
  return (
    <QueuePanel
      queue={queue}
      editingId={null}
      onEdit={vi.fn()}
      onRemove={vi.fn()}
      onSend={vi.fn()}
      onMoveUp={vi.fn()}
      statusNote="Sending one at a time"
      agentActions={{ ...actions, notices }}
      onFocusComposer={onFocusComposer}
    />
  );
}

function renderPanel(queue: QueueItem[], notices: Record<string, string> = {}) {
  return render(
    <QueuePanel
      queue={queue}
      editingId={null}
      onEdit={vi.fn()}
      onRemove={vi.fn()}
      onSend={vi.fn()}
      onMoveUp={vi.fn()}
      statusNote="Sending one at a time"
      agentActions={{ ...actions, notices }}
    />
  );
}

describe('QueuePanel: who sent a queued message', () => {
  it('names an agent sender above its words and links its chat', () => {
    renderPanel([fromChat('a', 'Please hold PR #12.', SECURITY)]);
    const row = screen.getByRole('group', {
      name: 'Queued message from Security, from Dependency audit for 0.121',
    });
    expect(within(row).getByText('Please hold PR #12.')).toBeInTheDocument();
    expect(within(row).getByText('Security')).toHaveClass('font-semibold');
    const link = within(row).getByRole('link', { name: 'Dependency audit for 0.121' });
    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ search: expect.anything() }));
    expect(screen.queryByRole('button', { name: /Please hold/ })).not.toBeInTheDocument();
    expect(screen.getByText('1 from Security')).toBeInTheDocument();
  });

  it("says can't open, with no link, when the chat cannot be read", () => {
    const { chatTitle: _gone, ...noTitle } = SECURITY;
    renderPanel([fromChat('a', 'Hi', noTitle)]);
    expect(screen.getByText('from another chat · can’t open')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('reads "Another chat" for an unknown sender, with no link', () => {
    renderPanel([fromChat('a', 'Hi', null)]);
    expect(
      screen.getByRole('group', {
        name: 'Queued message from Another chat',
      })
    ).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it("keeps a person's own message a plain, editable row", () => {
    renderPanel([mine('a', 'my words')]);
    expect(screen.getByRole('button', { name: /my words/ })).toBeEnabled();
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(screen.getByText('Queued (1)')).toBeInTheDocument();
  });

  it('counts a mixed queue by who sent what', () => {
    renderPanel([mine('a', 'mine'), fromChat('b', 'theirs', SECURITY)]);
    expect(screen.getByText('2 queued · 1 yours, 1 from Security')).toBeInTheDocument();
  });
});

describe('QueuePanel: focus after a row leaves (DOR-3060)', () => {
  const a = fromChat('a', 'first', SECURITY);
  const b = fromChat('b', 'second', { ...SECURITY, agentName: 'QA' });

  it('moves to the row now in its place after Don’t deliver', () => {
    const view = render(panel([a, b]));
    const rowA = screen.getByRole('group', { name: /from Security/ });
    fireEvent.click(within(rowA).getByRole('button', { name: 'Don’t deliver' }));
    const confirm = within(rowA).getAllByRole('button', { name: 'Don’t deliver' }).at(-1)!;
    confirm.focus();
    fireEvent.click(confirm);

    view.rerender(panel([b]));

    const rowB = screen.getByRole('group', { name: /from QA/ });
    expect(rowB.contains(document.activeElement)).toBe(true);
  });

  it('moves to the row before it when the last row in line leaves', () => {
    const view = render(panel([a, b]));
    const rowB = screen.getByRole('group', { name: /from QA/ });
    const sendB = within(rowB).getByRole('button', { name: /^Send now/ });
    sendB.focus();
    fireEvent.click(sendB);

    view.rerender(panel([a]));

    const rowA = screen.getByRole('group', { name: /from Security/ });
    expect(rowA.contains(document.activeElement)).toBe(true);
  });

  it('moves to the composer when the only row leaves', () => {
    const onFocusComposer = vi.fn();
    const view = render(panel([a], {}, onFocusComposer));
    const send = screen.getByRole('button', { name: /^Send now/ });
    send.focus();
    fireEvent.click(send);

    view.rerender(panel([], {}, onFocusComposer));

    expect(onFocusComposer).toHaveBeenCalledOnce();
  });

  it('forgets the row when Send now fails, so a later drain never moves focus', () => {
    const onFocusComposer = vi.fn();
    actions.sendNow.mockImplementationOnce((_id: string, onFailed?: () => void) => onFailed?.());
    const view = render(panel([a], {}, onFocusComposer));
    const send = screen.getByRole('button', { name: /^Send now/ });
    send.focus();
    fireEvent.click(send);

    // The row ran later, as its own turn, while focus had fallen to the page.
    send.blur();
    view.rerender(panel([], {}, onFocusComposer));
    view.unmount();

    expect(onFocusComposer).not.toHaveBeenCalled();
  });

  it('stays put when Send now could only move the row first', () => {
    const onFocusComposer = vi.fn();
    const view = render(panel([a], {}, onFocusComposer));
    const send = screen.getByRole('button', { name: /^Send now/ });
    send.focus();
    fireEvent.click(send);

    view.rerender(panel([a], { a: 'Sends next.' }, onFocusComposer));
    view.unmount();

    expect(onFocusComposer).not.toHaveBeenCalled();
  });
});

describe('queueHeaderCount', () => {
  const row = (agentName: string | null) => ({
    fromChat: true,
    sender: agentName === null ? null : { ...SECURITY, agentName },
  });
  it('says the top sender and how many others, across three or more senders', () => {
    expect(
      queueHeaderCount([
        row('Security'),
        row('Security'),
        row('Security'),
        row('Designer'),
        row('QA'),
      ])
    ).toBe('3 from Security and 2 others');
    expect(queueHeaderCount([row('Security'), row('QA')])).toBe('1 from Security and 1 other');
    expect(queueHeaderCount([row(null)])).toBe('1 from Another chat');
  });
});

describe('queueSenderOf', () => {
  it('reads the first sender, and none for a legacy row', () => {
    const entry = {
      id: 'm1',
      kind: 'message' as const,
      from: { chatId: 'c', agentName: 'Security', chatTitle: 'T' },
      text: 'x',
    };
    expect(queueSenderOf([entry] as never)).toEqual({
      agentName: 'Security',
      chatId: 'c',
      chatTitle: 'T',
    });
    expect(queueSenderOf([{ ...entry, legacy: true }] as never)).toBeNull();
    expect(queueSenderOf(undefined)).toBeNull();
  });
});
