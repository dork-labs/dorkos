// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, cleanup, fireEvent } from '@testing-library/react';

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

import { SessionTranscript } from '../ui/SessionTranscript';
import type { ChatMessage } from '@/layers/shared/model';
import { useAppStore } from '@/layers/shared/model';
import { createReadCursorHarness, renderWithTransport } from './session-transcript-test-helpers';

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
vi.mock('@/layers/features/entry-actions/ui/EntryRunWithMenu', () => ({
  EntryRunWithMenu: () => <div data-testid="run-with-menu" />,
}));
vi.mock('@/layers/features/conversation', async () => ({
  ...(await vi.importActual<object>('@/layers/features/conversation')),
  ScrollThumb: () => null,
}));
vi.mock('@/layers/entities/agent/model/use-current-agent', () => ({
  useCurrentAgent: () => ({ data: null }),
}));
vi.mock('@/layers/entities/session/model/use-session-runtime', () => ({
  useSessionRuntime: () => 'claude-code',
}));

/** How many rows the fake virtualizer keeps in the DOM at once. */
const WINDOW_ROWS = 10;

// A virtualizer that genuinely WINDOWS: ten rows in the DOM, and `scrollToIndex`
// moves the window and re-renders, exactly as the real one does. This is the
// shape the nav has to survive — a feed whose articles mostly do not exist.
vi.mock('@tanstack/react-virtual', async () => {
  const { useState, useCallback } = await import('react');
  return {
    useVirtualizer: ({ count }: { count: number }) => {
      const [start, setStart] = useState(0);
      const end = Math.min(count, start + WINDOW_ROWS);
      const scrollToIndex = useCallback(
        (index: number) =>
          setStart((prev) => {
            if (index < prev) return index;
            if (index >= prev + WINDOW_ROWS) return index - WINDOW_ROWS + 1;
            return prev;
          }),
        []
      );
      return {
        getVirtualItems: () =>
          Array.from({ length: Math.max(0, end - start) }, (_, i) => ({
            key: `virt-${start + i}`,
            index: start + i,
            start: (start + i) * 80,
            size: 80,
          })),
        getTotalSize: () => count * 80,
        measureElement: () => {},
        scrollToEnd: () => setStart(Math.max(0, count - WINDOW_ROWS)),
        scrollToIndex,
        isAtEnd: () => true,
      };
    },
  };
});

/** A thirty-message conversation, one message a minute. */
const MESSAGES: ChatMessage[] = Array.from({ length: 30 }, (_, i) => ({
  id: `m${i + 1}`,
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: `Message ${i + 1}`,
  parts: [{ type: 'text', text: `Message ${i + 1}` }],
  timestamp: new Date(Date.now() - (30 - i) * 60_000).toISOString(),
}));

/** Where the reader is standing, as the set counts it. */
function focusedPosition(): number | null {
  const value = document.activeElement?.getAttribute('aria-posinset');
  return value === null || value === undefined ? null : Number(value);
}

describe('crossing a transcript wider than its window', () => {
  it('renders only a window of the conversation', () => {
    render(<SessionTranscript sessionId="s" messages={MESSAGES} />);
    const articles = screen.getAllByRole('article');
    expect(articles.length).toBeLessThan(MESSAGES.length);
    expect(articles[0].getAttribute('aria-setsize')).toBe('30');
  });

  it('reaches the last message with Page Down, through the edge of the window', () => {
    render(<SessionTranscript sessionId="s" messages={MESSAGES} />);
    const feed = screen.getByRole('feed');

    // Start at the top: Page Up out of the window the list opened on, which is
    // the same edge in the other direction.
    screen.getAllByRole('article')[0].focus();
    for (let i = 0; i < 40 && focusedPosition() !== 1; i++) {
      fireEvent.keyDown(feed, { key: 'PageUp' });
    }
    expect(focusedPosition()).toBe(1);

    // Then all the way down. Twenty-nine presses is the honest count for thirty
    // messages; the loop allows a few more so a failure reports WHERE it stalled
    // rather than just that it did.
    for (let i = 0; i < 40 && focusedPosition() !== 30; i++) {
      fireEvent.keyDown(feed, { key: 'PageDown' });
    }
    expect(focusedPosition()).toBe(30);
  });

  it('stops at the ends rather than wrapping', () => {
    render(<SessionTranscript sessionId="s" messages={MESSAGES} />);
    const feed = screen.getByRole('feed');
    screen.getAllByRole('article')[0].focus();
    for (let i = 0; i < 40; i++) fireEvent.keyDown(feed, { key: 'PageUp' });
    expect(focusedPosition()).toBe(1);
    for (let i = 0; i < 60; i++) fireEvent.keyDown(feed, { key: 'PageDown' });
    expect(focusedPosition()).toBe(30);
  });
});
