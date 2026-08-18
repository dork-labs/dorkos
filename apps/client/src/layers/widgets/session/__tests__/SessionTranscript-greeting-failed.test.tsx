// @vitest-environment jsdom
import type React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, cleanup } from '@testing-library/react';
import { createReadCursorHarness, renderWithTransport } from './session-transcript-test-helpers';

import { useAgentBirthStore } from '@/layers/shared/model';
import { SessionTranscript } from '../ui/SessionTranscript';

// Author identity comes from the working directory's agent and the session's
// runtime, both transport-backed caches. Mocked at their source modules (not at
// the entity barrels) so everything else those barrels export stays real.
vi.mock('@/layers/entities/agent/model/use-current-agent', () => ({
  useCurrentAgent: () => ({ data: null }),
}));
vi.mock('@/layers/entities/session/model/use-session-runtime', () => ({
  useSessionRuntime: () => 'claude-code',
}));

const RECORD = {
  name: 'aurora',
  displayName: 'Aurora',
  agentId: 'agent_aurora',
  bornAt: '2026-07-20T00:00:00.000Z',
  path: '/agents/aurora',
  runtime: 'claude-code',
  kickoffMessage: '<dork-kickoff>hi</dork-kickoff>',
};

/** Minimal props for an empty-session SessionTranscript. */
function props(sessionId: string) {
  return {
    messages: [],
    sessionId,
    isLoadingHistory: false,
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

describe('SessionTranscript — greeting-failed empty state (M4)', () => {
  beforeEach(() => {
    useAgentBirthStore.setState({ records: {} });
  });
  afterEach(cleanup);

  it('shows an honest, actionable line (and NO Retry button) when the greeting failed', () => {
    useAgentBirthStore.getState().register('s1', RECORD);
    useAgentBirthStore.getState().markGreetingFailed('s1');

    render(<SessionTranscript {...props('s1')} />);

    const line = screen.getByTestId('greeting-failed-empty');
    expect(line).toHaveTextContent('Aurora couldn’t say hello just now');
    expect(line).toHaveTextContent('Send a message to get started.');
    // The dishonest part — a dead Retry — must never appear.
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    // It replaces the generic empty copy, not stacks with it.
    expect(screen.queryByText('Start a conversation')).toBeNull();
  });

  it('shows the generic empty copy for a normal session (no birth record)', () => {
    render(<SessionTranscript {...props('ordinary')} />);
    expect(screen.getByText('Start a conversation')).toBeInTheDocument();
    expect(screen.queryByTestId('greeting-failed-empty')).toBeNull();
  });

  it('shows the generic empty copy before the kickoff fires (birth recorded, not yet fired)', () => {
    // A birth record exists but its opening turn has not fired — first light and
    // the failure line both wait for the birth-store latches, so the neutral
    // empty copy holds in this pre-fire window.
    useAgentBirthStore.getState().register('s1', RECORD);
    render(<SessionTranscript {...props('s1')} />);
    expect(screen.getByText('Start a conversation')).toBeInTheDocument();
    expect(screen.queryByTestId('greeting-failed-empty')).toBeNull();
    expect(screen.queryByTestId('first-light')).toBeNull();
  });
});
