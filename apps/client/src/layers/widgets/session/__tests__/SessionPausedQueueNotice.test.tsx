// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { QueuedMessage } from '@dorkos/shared/schemas';
import { TransportProvider } from '@/layers/shared/model';
import { useSessionStreamStore } from '@/layers/entities/session';
import { SessionPausedQueueNotice } from '../ui/SessionPausedQueueNotice';

vi.mock('sonner', () => ({ toast: vi.fn() }));

const PAUSE = {
  agentId: 'agent-1',
  pausedBy: { accountId: 'owner', kind: 'person' as const, name: 'Owner' },
  pausedAt: '2026-11-14T00:00:00.000Z',
};
const MESSAGE: QueuedMessage = {
  id: 'queued-1',
  content: 'Keep these words',
  disposition: 'queue',
  enqueuedAt: 1,
  enqueuedBy: 'window-1',
};

function seedQueue(queue: QueuedMessage[]) {
  useSessionStreamStore.getState().applyEvent('session-1', {
    seq: 1,
    type: 'queue_update',
    queue,
  });
}

function setup(queue: QueuedMessage[], pausedAgentId: string | null = 'agent-1') {
  seedQueue(queue);
  let paused = pausedAgentId !== null;
  const transport = createMockTransport({
    listAgentPauses: vi.fn(async () => ({
      pauses: paused ? [{ ...PAUSE, agentId: pausedAgentId! }] : [],
    })),
    resumeAgent: vi.fn(async (agentId: string) => {
      paused = false;
      return { agentId, paused: false, changed: true };
    }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  render(<SessionPausedQueueNotice sessionId="session-1" agentId="agent-1" agentName="Scout" />, {
    wrapper: Wrapper,
  });
  return { transport, client };
}

afterEach(() => {
  cleanup();
  useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
});

describe('a person’s queued message held by pause (DOR-4348)', () => {
  it('shows the idle queue’s hidden head and keeps its words when Resume is pressed', async () => {
    const { transport } = setup([MESSAGE]);
    const notice = await screen.findByRole('status');
    // The designer's exact words (DOR-4348).
    expect(screen.getByText('Scout is paused.')).toBeInTheDocument();
    expect(
      screen.getByText('Your message waits here until you resume it and press Send.')
    ).toBeInTheDocument();
    expect(notice).toContainElement(screen.getByText('Scout is paused.'));
    await userEvent.click(screen.getByRole('button', { name: 'Resume Scout' }));
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(transport.resumeAgent).toHaveBeenCalledWith('agent-1');
    expect(useSessionStreamStore.getState().getSession('session-1').queuedMessages).toEqual([
      MESSAGE,
    ]);
    expect(transport.postMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['no queued message', [], 'agent-1'],
    ['only another chat’s message', [{ ...MESSAGE, enqueuedBy: 'chat:sender' }], 'agent-1'],
    ['a different agent paused', [MESSAGE], 'agent-2'],
    ['the agent resumed', [MESSAGE], null],
  ] as const)('says nothing for %s', async (_label, queue, pausedAgentId) => {
    const { transport, client } = setup([...queue], pausedAgentId);
    await waitFor(() => {
      expect(transport.listAgentPauses).toHaveBeenCalled();
      expect(client.isFetching()).toBe(0);
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('stops announcing a held message once the queue is emptied', async () => {
    setup([MESSAGE]);
    await screen.findByRole('status');
    act(() =>
      useSessionStreamStore.getState().applyEvent('session-1', {
        seq: 2,
        type: 'queue_update',
        queue: [],
      })
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
