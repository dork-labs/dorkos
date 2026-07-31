// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRef } from 'react';
import { render, screen, cleanup } from '@testing-library/react';

import { ChatMessageArea } from '../ui/ChatMessageArea';
import type { MessageListHandle } from '../ui/MessageList';

vi.mock('../ui/MessageList', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui/MessageList')>();
  return { ...actual, MessageList: () => <div data-testid="message-list" /> };
});

/** Props for a message area in the given loading state. */
function props(isLoadingHistory: boolean) {
  return {
    messages: [],
    sessionId: 's1',
    isLoadingHistory,
    hydrated: true,
    isTextStreaming: false,
    isAtBottom: true,
    hasNewMessages: false,
    scrollToBottom: vi.fn(),
    onScrollStateChange: vi.fn(),
    activeToolCallId: null,
    onToolRef: vi.fn(),
    focusedOptionIndex: -1,
    onToolDecided: vi.fn(),
    onRetry: vi.fn(),
    inputZoneToolCallId: null,
    messageListRef: createRef<MessageListHandle>(),
  };
}

describe('ChatMessageArea — the wait for a conversation', () => {
  afterEach(cleanup);

  it('says the feed is busy while the history loads', () => {
    render(<ChatMessageArea {...props(true)} />);
    const feed = screen.getByRole('feed');
    expect(feed.getAttribute('aria-busy')).toBe('true');
    expect(feed.getAttribute('aria-label')).toBe('Conversation');
  });

  it('stops saying so once there is nothing left to wait for', () => {
    render(<ChatMessageArea {...props(false)} />);
    expect(screen.queryByRole('feed')).toBeNull();
  });
});
