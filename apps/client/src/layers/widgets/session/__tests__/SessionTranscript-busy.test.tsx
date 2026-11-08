// @vitest-environment jsdom
import type React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, screen, cleanup } from '@testing-library/react';
import { createReadCursorHarness, renderWithTransport } from './session-transcript-test-helpers';

import { TRANSCRIPT_LOADING_MS } from '../model/use-transcript-hold';
import { SessionTranscript } from '../ui/SessionTranscript';

// Author identity comes from the working directory's agent and the session's
// runtime, both transport-backed caches. Mocked at their source modules (not at
// the entity barrels) so everything else those barrels export stays real.
vi.mock('@/layers/entities/agent/model/use-current-agent', () => ({
  useCurrentAgent: () => ({ data: null }),
}));
vi.mock('@/layers/entities/session/model/query/use-session-runtime', () => ({
  useSessionRuntime: () => 'claude-code',
}));

/** Props for a message area in the given loading state. */
function props(isLoadingHistory: boolean) {
  return {
    messages: [],
    sessionId: 's1',
    isLoadingHistory,
    hydrated: true,
    isTextStreaming: false,
    activeToolCallId: null,
    onToolRef: vi.fn(),
    focusedOptionIndex: -1,
    onToolDecided: vi.fn(),
    onRetry: vi.fn(),
    inputZoneToolCallId: null,
  };
}

/** The transcript reads its unread cursor over the transport, so it needs one. */
const readState = createReadCursorHarness();

/** Render inside that transport and the conversation every row reads. */
function render(ui: React.ReactElement) {
  return renderWithTransport(ui, readState.transport);
}

describe('SessionTranscript — the wait for a conversation', () => {
  afterEach(cleanup);

  it('says the feed is busy while the history loads', () => {
    render(<SessionTranscript {...props(true)} />);
    const feed = screen.getByRole('feed');
    expect(feed.getAttribute('aria-busy')).toBe('true');
    expect(feed.getAttribute('aria-label')).toBe('Conversation');
  });

  it('keeps "Loading chat…" back until the wait has gone on too long', () => {
    vi.useFakeTimers();
    try {
      render(<SessionTranscript {...props(true)} />);
      expect(screen.queryByText('Loading chat…')).toBeNull();
      act(() => void vi.advanceTimersByTime(TRANSCRIPT_LOADING_MS));
      expect(screen.getByText('Loading chat…')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops saying so once there is nothing left to wait for', () => {
    render(<SessionTranscript {...props(false)} />);
    expect(screen.queryByRole('feed')).toBeNull();
  });
});
