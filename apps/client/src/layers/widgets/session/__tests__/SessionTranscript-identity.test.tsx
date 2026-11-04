// @vitest-environment jsdom
/**
 * Whose words these are (DOR-3074): a chat never shows the runtime's name in
 * place of an agent's, or before it knows there is no agent.
 */
import type React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { screen, cleanup, waitFor } from '@testing-library/react';
import type { ChatMessage } from '@/layers/shared/model';
import { useAppStore } from '@/layers/shared/model';
import { createReadCursorHarness, renderWithTransport } from './session-transcript-test-helpers';

import { SessionTranscript } from '../ui/SessionTranscript';

const manifest = vi.hoisted(() => ({
  current: { data: null, isPending: false, isError: false } as {
    data: unknown;
    isPending: boolean;
    isError: boolean;
  },
}));

vi.mock('@/layers/entities/agent/model/use-current-agent', () => ({
  useCurrentAgent: () => manifest.current,
}));
vi.mock('@/layers/entities/session/model/query/use-session-runtime', () => ({
  useSessionRuntime: () => 'claude-code',
}));

const REPLY: ChatMessage = {
  id: 'm1',
  role: 'assistant',
  content: 'Hello, I am here.',
  parts: [],
  timestamp: '2026-07-20T00:00:01.000Z',
};

/** Props for an ordinary chat with one reply on screen. */
function props() {
  return {
    messages: [REPLY],
    sessionId: 's1',
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

const readState = createReadCursorHarness();

/** Render inside the transport the read cursor needs. */
function render(ui: React.ReactElement) {
  return renderWithTransport(ui, readState.transport);
}

describe('SessionTranscript — whose words these are', () => {
  beforeEach(() => {
    useAppStore.setState({ selectedCwd: '/agents/tern' });
  });
  afterEach(() => {
    cleanup();
    useAppStore.setState({ selectedCwd: null });
    manifest.current = { data: null, isPending: false, isError: false };
  });

  it('keeps an ordinary chat unseen while its agent is on the way', () => {
    manifest.current = { data: undefined, isPending: true, isError: false };
    render(<SessionTranscript {...props()} />);
    expect(screen.getByTestId('message-list').className).toContain('invisible');
  });

  it('calls the replies "Unknown agent" when the agent could not be read', async () => {
    manifest.current = { data: undefined, isPending: false, isError: true };
    render(<SessionTranscript {...props()} />);
    expect(await screen.findByText('Unknown agent')).toBeTruthy();
    expect(screen.queryByText('Claude Code')).toBeNull();
  });

  it('keeps the runtime’s name for a folder that has no agent', async () => {
    manifest.current = { data: null, isPending: false, isError: false };
    render(<SessionTranscript {...props()} />);
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeTruthy());
    expect(screen.getByTestId('message-list').className).not.toContain('invisible');
  });
});
