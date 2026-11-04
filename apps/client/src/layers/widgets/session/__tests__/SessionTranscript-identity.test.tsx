// @vitest-environment jsdom
/**
 * Whose words these are (DOR-3074): a chat never shows the runtime's name in
 * place of an agent's, or before it knows there is no agent.
 */
import type React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act, screen, cleanup, waitFor } from '@testing-library/react';
import type { ChatMessage } from '@/layers/shared/model';
import { AGENT_IDENTITY_LIMIT_MS } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import { createReadCursorHarness, renderWithTransport } from './session-transcript-test-helpers';

import { SessionTranscript } from '../ui/SessionTranscript';

// Sending this row through another agent is outside the identity assertion.
vi.mock('@/layers/features/entry-actions/ui/EntryRunWithMenu', () => ({
  EntryRunWithMenu: () => null,
}));

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

  describe('while the server has not said whether this is a DM', () => {
    const UNDECIDED = { agent: null, humanName: null, settled: false };

    /** Past both limits, it says it is loading and has named nobody. */
    async function expectLoadingWithNoName() {
      render(<SessionTranscript {...props()} directMessage={UNDECIDED} />);
      expect(await screen.findByText('Loading chat…', {}, { timeout: 2_000 })).toBeTruthy();
      expect(screen.queryByText('Claude Code')).toBeNull();
      expect(screen.queryByText('Unknown agent')).toBeNull();
    }

    it('does not take a folder with no agent to mean the runtime wrote this', async () => {
      manifest.current = { data: null, isPending: false, isError: false };
      await expectLoadingWithNoName();
    });

    it('waits the same with no folder selected', async () => {
      useAppStore.setState({ selectedCwd: null });
      manifest.current = { data: undefined, isPending: true, isError: false };
      await expectLoadingWithNoName();
    });

    it('waits the same when the folder’s agent could not be read', async () => {
      manifest.current = { data: undefined, isPending: false, isError: true };
      await expectLoadingWithNoName();
    });

    it('still lets go at the limit once it has an agent to name', async () => {
      manifest.current = {
        data: { id: 'tern', name: 'tern', displayName: 'Tern' },
        isPending: false,
        isError: false,
      };
      render(<SessionTranscript {...props()} directMessage={UNDECIDED} />);
      await waitFor(
        () => expect(screen.getByTestId('message-list').className).not.toContain('invisible'),
        { timeout: 2_000 }
      );
      expect(screen.getByText('Tern')).toBeTruthy();
    });
  });

  describe('when an answer never comes', () => {
    const UNDECIDED = { agent: null, humanName: null, settled: false };

    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Move the clock on, letting what it wakes finish. */
    const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

    it('shows the chat under "Unknown agent" at the limit, never the runtime', async () => {
      manifest.current = { data: null, isPending: false, isError: false };
      render(<SessionTranscript {...props()} directMessage={UNDECIDED} />);

      await wait(AGENT_IDENTITY_LIMIT_MS - 200);
      expect(screen.getByText('Loading chat…')).toBeTruthy();

      await wait(400);
      await waitFor(() => expect(screen.getByText('Unknown agent')).toBeTruthy());
      expect(screen.queryByText('Loading chat…')).toBeNull();
      expect(screen.queryByText('Claude Code')).toBeNull();
      await waitFor(() =>
        expect(screen.getByTestId('message-list').className).not.toContain('invisible')
      );
    });

    it('does the same for a manifest that hangs', async () => {
      manifest.current = { data: undefined, isPending: true, isError: false };
      render(<SessionTranscript {...props()} />);

      await wait(AGENT_IDENTITY_LIMIT_MS + 200);
      await waitFor(() => expect(screen.getByText('Unknown agent')).toBeTruthy());
      expect(screen.queryByText('Claude Code')).toBeNull();
    });

    it('never falls back to the folder’s agent in a DM whose own name hangs', async () => {
      manifest.current = {
        data: { id: 'other', name: 'other', displayName: 'Someone else' },
        isPending: false,
        isError: false,
      };
      const directMessage = { agent: null, humanName: null, settled: true, agentPending: true };
      render(<SessionTranscript {...props()} directMessage={directMessage} />);

      await wait(AGENT_IDENTITY_LIMIT_MS + 200);
      await waitFor(() => expect(screen.getByText('Unknown agent')).toBeTruthy());
      expect(screen.queryByText('Someone else')).toBeNull();
    });

    it('swaps the name in place when a late answer comes', async () => {
      manifest.current = { data: null, isPending: false, isError: false };
      const view = render(<SessionTranscript {...props()} directMessage={UNDECIDED} />);
      await wait(AGENT_IDENTITY_LIMIT_MS + 200);
      await waitFor(() => expect(screen.getByText('Unknown agent')).toBeTruthy());

      manifest.current = {
        data: { id: 'tern', name: 'tern', displayName: 'Tern' },
        isPending: false,
        isError: false,
      };
      view.rerender(<SessionTranscript {...props()} directMessage={UNDECIDED} />);
      await wait(100);
      expect(screen.getByText('Tern')).toBeTruthy();
      expect(screen.queryByText('Unknown agent')).toBeNull();
      expect(screen.getByTestId('message-list').className).not.toContain('invisible');
    });
  });

  it.each([null, 'Tern'])(
    'releases the unresolved transcript immediately on failure, kept name %s',
    async (name) => {
      manifest.current = { data: null, isPending: false, isError: false };
      render(
        <SessionTranscript
          {...props()}
          messages={[
            REPLY,
            {
              id: 'sent',
              role: 'user',
              content: 'A sent message.',
              parts: [],
              timestamp: '2026-07-20T00:00:02.000Z',
            },
          ]}
          lookupFailed
          directMessage={{
            settled: false,
            humanName: null,
            agent: name ? { id: 'tern', displayName: name } : null,
          }}
        />
      );
      expect(await screen.findByText(name ?? 'Unknown agent')).toBeTruthy();
      expect(screen.getByText('A sent message.')).toBeTruthy();
      await waitFor(() =>
        expect(screen.getByTestId('message-list').className).not.toContain('invisible')
      );
      expect(screen.queryByText('Claude Code')).toBeNull();
      expect(screen.queryByText('Loading chat…')).toBeNull();
    }
  );

  it('keeps the runtime’s name for a folder that has no agent', async () => {
    manifest.current = { data: null, isPending: false, isError: false };
    render(<SessionTranscript {...props()} />);
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeTruthy());
    expect(screen.getByTestId('message-list').className).not.toContain('invisible');
  });
});
