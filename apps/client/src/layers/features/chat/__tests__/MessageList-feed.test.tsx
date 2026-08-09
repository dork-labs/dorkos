// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, act } from '@testing-library/react';

/**
 * The list holds its unread rule in server state now (team-room-home §D4), so
 * it subscribes to the read-cursor broadcast. Nothing here is about read state
 * — the subscription is stubbed out, and the cursor comes back empty from the
 * harness transport below.
 */
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useEventSubscription: () => {} };
});

import { MessageList } from '../ui/MessageList';
import type { ChatMessage } from '../model/use-chat-session';
import { useAppStore } from '@/layers/shared/model';
import { createReadCursorHarness, renderWithTransport } from './message-list-test-helpers';

/** The read-cursor route, which answers "never read" for every session here. */
const readState = createReadCursorHarness();

/** Render inside the transport the list's unread cursor reads through. */
function render(ui: React.ReactElement) {
  return renderWithTransport(ui, readState.transport);
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  useAppStore.getState().resetPreferences();
});

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => (
    <div data-testid="streamdown">{children}</div>
  ),
}));
vi.mock('../ui/message/RunWithMenu', () => ({
  RunWithMenu: () => <div data-testid="run-with-menu" />,
}));
vi.mock('../ui/ScrollThumb', () => ({ ScrollThumb: () => null }));
vi.mock('@/layers/entities/agent/model/use-current-agent', () => ({
  useCurrentAgent: () => ({ data: null }),
}));
vi.mock('@/layers/entities/session/model/use-session-runtime', () => ({
  useSessionRuntime: () => 'claude-code',
}));

// Everything is rendered: this suite is about what the DOM says, not about
// windowing.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        key: `virt-${i}`,
        index: i,
        start: i * 80,
        size: 80,
      })),
    getTotalSize: () => count * 80,
    measureElement: () => {},
    scrollToEnd: () => {},
    scrollToIndex: () => {},
    isAtEnd: () => true,
  }),
}));

/** Whatever the live region holds, without the invisible change marker. */
function said(region: HTMLElement): string {
  return (region.textContent ?? '').replace(/\u200B/gu, '');
}

/** A message `minutesAgo` back, so grouping is deterministic. */
function message(
  id: string,
  role: ChatMessage['role'],
  text: string,
  minutesAgo: number
): ChatMessage {
  return {
    id,
    role,
    content: text,
    parts: [{ type: 'text', text }],
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  };
}

const conversation = [
  message('1', 'user', 'First question', 30),
  message('2', 'assistant', 'First answer', 29),
  message('3', 'user', 'Second question', 20),
];

describe('the transcript is a feed', () => {
  it('wraps the history in a named feed', () => {
    render(<MessageList sessionId="s" messages={conversation} />);
    const feed = screen.getByRole('feed');
    expect(feed.getAttribute('aria-label')).toBe('Conversation');
    expect(feed.getAttribute('aria-busy')).toBe('false');
  });

  it('makes every message an article that says where it sits', () => {
    render(<MessageList sessionId="s" messages={conversation} />);
    const articles = screen.getAllByRole('article');
    expect(articles).toHaveLength(3);
    expect(articles.map((a) => a.getAttribute('aria-posinset'))).toEqual(['1', '2', '3']);
    expect(articles.every((a) => a.getAttribute('aria-setsize') === '3')).toBe(true);
    // Focusable, because an article is where Page Down puts the reader.
    expect(articles.every((a) => a.getAttribute('tabindex') === '0')).toBe(true);
  });

  it('names each article from the author line already on screen', () => {
    render(<MessageList sessionId="s" messages={conversation} />);
    const [first] = screen.getAllByRole('article');
    const labelledBy = first.getAttribute('aria-labelledby');
    expect(labelledBy).not.toBeNull();
    const header = document.getElementById(labelledBy!);
    expect(header?.textContent).toContain('You');
    // The name is the visible line pointed AT — never a second sentence
    // written for screen readers (the DOR-583 double-speak).
    expect(first.getAttribute('aria-label')).toBeNull();
  });

  it('names a continuation row directly, since it has no author line', () => {
    const run = [message('1', 'user', 'One', 10), message('2', 'user', 'Two', 10)];
    render(<MessageList sessionId="s" messages={run} />);
    const [, second] = screen.getAllByRole('article');
    expect(second.getAttribute('aria-labelledby')).toBeNull();
    expect(second.getAttribute('aria-label')).toContain('You');
  });

  it('moves a message at a time on Page Down and back on Page Up', () => {
    render(<MessageList sessionId="s" messages={conversation} />);
    const feed = screen.getByRole('feed');
    const articles = screen.getAllByRole('article');

    fireEvent.keyDown(feed, { key: 'PageDown' });
    expect(document.activeElement).toBe(articles[0]);
    fireEvent.keyDown(feed, { key: 'PageDown' });
    expect(document.activeElement).toBe(articles[1]);
    fireEvent.keyDown(feed, { key: 'PageUp' });
    expect(document.activeElement).toBe(articles[0]);
  });

  it('leaves the feed for the composer on Ctrl+End', () => {
    render(
      <div>
        <button type="button">Back</button>
        <MessageList sessionId="s" messages={conversation} />
        <button type="button">Send</button>
      </div>
    );
    const feed = screen.getByRole('feed');
    fireEvent.keyDown(feed, { key: 'End', ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Send' }));
    fireEvent.keyDown(feed, { key: 'Home', ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Back' }));
  });
});

describe('the turn in flight', () => {
  it('keeps a live region that says nothing about a finished conversation', () => {
    render(<MessageList sessionId="s" messages={conversation} />);
    const log = screen.getByRole('log');
    expect(log.getAttribute('aria-live')).toBe('polite');
    expect(log.textContent).toBe('');
  });

  it('says each sentence as it arrives, and only the leftover when it settles', () => {
    vi.useFakeTimers();
    const streaming = (text: string): ChatMessage[] => [
      conversation[0],
      message('answer', 'assistant', text, 0),
    ];
    const { rerender } = render(
      <MessageList sessionId="s" messages={streaming('Look')} isTextStreaming />
    );
    const log = screen.getByRole('log');
    expect(log.textContent).toBe('');

    rerender(
      <MessageList sessionId="s" messages={streaming('Looking now. And the')} isTextStreaming />
    );
    expect(said(log)).toBe('Looking now.');

    // The words stop moving — which is what "settled" means here, since the
    // streaming flag drops on every pause mid-answer too.
    rerender(
      <MessageList sessionId="s" messages={streaming('Looking now. And the answer is 4')} />
    );
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    // Settling says the tail, never the answer from the top again.
    expect(said(log)).toBe('And the answer is 4');
    expect(said(log)).not.toContain('Looking now.');
    vi.useRealTimers();
  });

  it('stays silent when a finished transcript is merely opened', () => {
    render(
      <MessageList
        sessionId="s"
        messages={[conversation[0], message('answer', 'assistant', 'All done here.', 1)]}
      />
    );
    expect(screen.getByRole('log').textContent).toBe('');
  });
});
