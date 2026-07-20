// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRef } from 'react';
import { render, screen, cleanup } from '@testing-library/react';

import { useAgentBirthStore } from '@/layers/shared/model';
import { ChatMessageArea } from '../ui/ChatMessageArea';
import type { MessageListHandle } from '../ui/MessageList';

const RECORD = {
  name: 'aurora',
  displayName: 'Aurora',
  agentId: 'agent_aurora',
  bornAt: '2026-07-20T00:00:00.000Z',
  path: '/agents/aurora',
  runtime: 'claude-code',
  kickoffMessage: '<dork-kickoff>hi</dork-kickoff>',
};

/** Minimal props for an empty-session ChatMessageArea. */
function props(sessionId: string) {
  return {
    messages: [],
    sessionId,
    isLoadingHistory: false,
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

describe('ChatMessageArea — greeting-failed empty state (M4)', () => {
  beforeEach(() => {
    useAgentBirthStore.setState({ records: {} });
  });
  afterEach(cleanup);

  it('shows an honest, actionable line (and NO Retry button) when the greeting failed', () => {
    useAgentBirthStore.getState().register('s1', RECORD);
    useAgentBirthStore.getState().markGreetingFailed('s1');

    render(<ChatMessageArea {...props('s1')} />);

    const line = screen.getByTestId('greeting-failed-empty');
    expect(line).toHaveTextContent('Aurora couldn’t say hello just now');
    expect(line).toHaveTextContent('Send a message to get started.');
    // The dishonest part — a dead Retry — must never appear.
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    // It replaces the generic empty copy, not stacks with it.
    expect(screen.queryByText('Start a conversation')).toBeNull();
  });

  it('shows the generic empty copy for a normal session (no birth record)', () => {
    render(<ChatMessageArea {...props('ordinary')} />);
    expect(screen.getByText('Start a conversation')).toBeInTheDocument();
    expect(screen.queryByTestId('greeting-failed-empty')).toBeNull();
  });

  it('shows the generic empty copy before the kickoff fires (birth recorded, not yet fired)', () => {
    // A birth record exists but its opening turn has not fired — first light and
    // the failure line both wait for the birth-store latches, so the neutral
    // empty copy holds in this pre-fire window.
    useAgentBirthStore.getState().register('s1', RECORD);
    render(<ChatMessageArea {...props('s1')} />);
    expect(screen.getByText('Start a conversation')).toBeInTheDocument();
    expect(screen.queryByTestId('greeting-failed-empty')).toBeNull();
    expect(screen.queryByTestId('first-light')).toBeNull();
  });
});
