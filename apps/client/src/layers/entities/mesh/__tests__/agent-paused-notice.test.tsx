/**
 * @vitest-environment jsdom
 *
 * The composer's paused-agent notice (spec `audit-trail` PR5): it names who is
 * paused, Resume lifts the pause, and it goes away once the agent is no longer
 * paused.
 */
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { AgentPausedNotice } from '../ui/AgentPausedNotice';

vi.mock('sonner', () => ({ toast: vi.fn() }));

const PAUSE = {
  agentId: 'agent-1',
  pausedBy: { accountId: 'p', kind: 'person' as const, name: 'Owner' },
  pausedAt: '2026-10-09T00:00:00.000Z',
};

function renderNotice(transport: ReturnType<typeof createMockTransport>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  render(<AgentPausedNotice agentId="agent-1" agentName="Scout" />, { wrapper: Wrapper });
}

describe('AgentPausedNotice', () => {
  afterEach(cleanup);

  it('names the paused agent and resumes it', async () => {
    let paused = true;
    const transport = createMockTransport({
      listAgentPauses: vi.fn(async () => ({ pauses: paused ? [PAUSE] : [] })),
      resumeAgent: vi.fn(async (agentId: string) => {
        paused = false;
        return { agentId, paused: false, changed: true };
      }),
    });
    renderNotice(transport);

    expect(await screen.findByText('Scout is paused')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));

    await waitFor(() => expect(transport.resumeAgent).toHaveBeenCalledWith('agent-1'));
    await waitFor(() => expect(screen.queryByTestId('agent-paused-notice')).toBeNull());
  });

  it('says nothing once the agent is no longer paused', async () => {
    const transport = createMockTransport({
      listAgentPauses: vi.fn().mockResolvedValue({ pauses: [] }),
    });
    renderNotice(transport);

    await waitFor(() => expect(screen.queryByTestId('agent-paused-notice')).toBeNull());
  });
});
