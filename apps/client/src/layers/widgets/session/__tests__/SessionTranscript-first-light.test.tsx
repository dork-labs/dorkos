// @vitest-environment jsdom
import type React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, cleanup, within } from '@testing-library/react';
import { createReadCursorHarness, renderWithTransport } from './session-transcript-test-helpers';

import { useAgentBirthStore, type AgentBirthRecord } from '@/layers/shared/model';
import { SessionTranscript } from '../ui/SessionTranscript';
import type { ChatMessage } from '@/layers/shared/model';

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
  icon: '🦊',
  bornAt: '2026-07-20T00:00:00.000Z',
  path: '/agents/aurora',
  runtime: 'claude-code',
  kickoffMessage: '<dork-kickoff>hi</dork-kickoff>',
};

/** A single greetable assistant message (content has landed). */
function assistantMessage(): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: 'Hello, I am here.',
    parts: [],
    timestamp: '2026-07-20T00:00:01.000Z',
  };
}

/** Props for a SessionTranscript in the given hydration + content state. */
function props(sessionId: string, overrides?: { messages?: ChatMessage[]; hydrated?: boolean }) {
  return {
    messages: overrides?.messages ?? [],
    sessionId,
    isLoadingHistory: false,
    hydrated: overrides?.hydrated ?? true,
    isTextStreaming: false,
    activeToolCallId: null,
    onToolRef: vi.fn(),
    focusedOptionIndex: -1,
    onToolDecided: vi.fn(),
    onRetry: vi.fn(),
    inputZoneToolCallId: null,
  };
}

/** Register a birth and mark its kickoff fired (the in-flight opening turn). */
function registerFired(sessionId: string, record: Omit<AgentBirthRecord, 'fired'> = RECORD) {
  useAgentBirthStore.getState().register(sessionId, record);
  useAgentBirthStore.getState().markFired(sessionId);
}

/** The transcript reads its unread cursor over the transport, so it needs one. */
const readState = createReadCursorHarness();

/** Render inside that transport and the conversation every row reads. */
function render(ui: React.ReactElement) {
  return renderWithTransport(ui, readState.transport);
}

describe('SessionTranscript — first light (newborn waking state, M4)', () => {
  beforeEach(() => {
    useAgentBirthStore.setState({ records: {} });
  });
  afterEach(cleanup);

  it('shows the agent waking up — face, name, and dots — while the fired greeting is in flight', () => {
    registerFired('s1');
    render(<SessionTranscript {...props('s1')} />);

    const firstLight = screen.getByTestId('first-light');
    expect(firstLight).toHaveTextContent('Aurora is waking up');
    // The agent's own face (the create-flow icon pick), via the shared avatar.
    expect(firstLight).toHaveTextContent('🦊');
    // The quiet typing-dots affordance is present.
    expect(within(firstLight).getByTestId('typing-dots')).toBeInTheDocument();
    // First light stands in for the generic empty copy, never stacks with it.
    expect(screen.queryByText('Start a conversation')).toBeNull();
  });

  it('falls back to a graceful name when the birth record carries no display name', () => {
    registerFired('s1', { ...RECORD, displayName: '' });
    render(<SessionTranscript {...props('s1')} />);
    expect(screen.getByTestId('first-light')).toHaveTextContent('Your agent is waking up');
  });

  it('steps aside the moment real content lands (message list takes over)', () => {
    registerFired('s1');
    render(<SessionTranscript {...props('s1', { messages: [assistantMessage()] })} />);

    expect(screen.queryByTestId('first-light')).toBeNull();
    expect(screen.getByTestId('message-list')).toBeInTheDocument();
  });

  it('never shows first light once the greeting failed — the honest line wins', () => {
    registerFired('s1');
    useAgentBirthStore.getState().markGreetingFailed('s1');
    render(<SessionTranscript {...props('s1')} />);

    expect(screen.queryByTestId('first-light')).toBeNull();
    expect(screen.getByTestId('greeting-failed-empty')).toHaveTextContent(
      'Aurora couldn’t say hello just now'
    );
  });

  it('shows the generic empty copy for an ordinary session (no birth record)', () => {
    render(<SessionTranscript {...props('ordinary')} />);
    expect(screen.getByText('Start a conversation')).toBeInTheDocument();
    expect(screen.queryByTestId('first-light')).toBeNull();
  });

  it('never shows first light for a first-message handoff (not a birth)', () => {
    // A first-message record carries the user's own words into an existing
    // agent's session — no newborn "waking up" ceremony (ADR 260722-111316).
    registerFired('s1', { ...RECORD, kind: 'first-message' });
    render(<SessionTranscript {...props('s1')} />);
    expect(screen.queryByTestId('first-light')).toBeNull();
    expect(screen.getByText('Start a conversation')).toBeInTheDocument();
  });

  it('does not claim "waking up" on an unhydrated revisit (empty but snapshot not yet landed)', () => {
    registerFired('s1');
    render(<SessionTranscript {...props('s1', { hydrated: false })} />);
    // Before hydration confirms the emptiness is real, first light stays hidden —
    // the neutral empty treatment holds rather than falsely announcing a wake.
    expect(screen.queryByTestId('first-light')).toBeNull();
    expect(screen.getByText('Start a conversation')).toBeInTheDocument();
  });

  it('a revisited birth session shows its landed greeting, never first light (hydration false → true)', () => {
    registerFired('s1');
    // Revisited before the snapshot lands: empty and unhydrated — no wake claim.
    const { rerender } = render(<SessionTranscript {...props('s1', { hydrated: false })} />);
    expect(screen.queryByTestId('first-light')).toBeNull();

    // The snapshot lands: hydration flips true and the greeting content arrives
    // together. The message list takes over — first light never appears.
    rerender(
      <SessionTranscript {...props('s1', { hydrated: true, messages: [assistantMessage()] })} />
    );
    expect(screen.getByTestId('message-list')).toBeInTheDocument();
    expect(screen.queryByTestId('first-light')).toBeNull();
  });
});
