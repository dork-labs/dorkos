/**
 * @vitest-environment jsdom
 */
/**
 * The Work queue page (DOR-3462): a person sees the list, reorders it, turns it off,
 * sets its limits and can stop every queue.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import type { WorkItem, WorkQueue } from '@dorkos/shared/work-queue-schemas';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';
import { TransportProvider } from '@/layers/shared/model';
import { WorkQueuePage } from '../ui/pages/WorkQueuePage';

afterEach(() => cleanup());

const MEMBER: TeamMember = MOCK_TEAM_ROSTER.find((member) => member.id === 'agent-warden')!;

/** An item in the given state. */
function item(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    agentId: MEMBER.agent!.manifestId,
    title: id,
    prompt: `Do ${id}`,
    cwd: null,
    state: 'queued',
    outcome: null,
    note: null,
    sessionId: null,
    accountId: null,
    addedBy: 'person',
    createdAt: '2026-10-30T09:00:00.000Z',
    startedAt: null,
    endedAt: null,
    ...over,
  };
}

/** Draw the page over a queue, and hand back the transport. */
function renderPage(queue: Partial<WorkQueue>) {
  const transport = createMockTransport();
  const full: WorkQueue = {
    agentId: MEMBER.agent!.manifestId,
    enabled: true,
    target: 1,
    dailyStartCap: 20,
    startsToday: 0,
    allStopped: false,
    hold: null,
    items: [],
    recent: [],
    ...queue,
  };
  vi.mocked(transport.getWorkQueue).mockResolvedValue(full);
  vi.mocked(transport.reorderWorkQueue).mockResolvedValue(full);
  vi.mocked(transport.updateWorkQueue).mockResolvedValue(full);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TransportProvider transport={transport}>
        <WorkQueuePage member={MEMBER} roster={MOCK_TEAM_ROSTER} onPush={() => undefined} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

describe('WorkQueuePage', () => {
  it('shows what waits, in order, and what runs', async () => {
    renderPage({
      items: [item('next'), item('after'), item('busy', { state: 'running' })],
    });
    await screen.findByText('next');
    expect(screen.getByText('busy')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move up: next' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move down: after' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Remove: busy' })).not.toBeInTheDocument();
  });

  it('moves an item down', async () => {
    const transport = renderPage({ items: [item('next'), item('after')] });
    fireEvent.click(await screen.findByRole('button', { name: 'Move down: next' }));
    await waitFor(() =>
      expect(transport.reorderWorkQueue).toHaveBeenCalledWith(MEMBER.agent!.manifestId, [
        'after',
        'next',
      ])
    );
  });

  it('turns the queue off', async () => {
    const transport = renderPage({ items: [item('next')] });
    fireEvent.click(await screen.findByRole('switch', { name: 'Start the next item on its own' }));
    await waitFor(() =>
      expect(transport.updateWorkQueue).toHaveBeenCalledWith(MEMBER.agent!.manifestId, {
        enabled: false,
      })
    );
  });

  it('stops every queue', async () => {
    const transport = renderPage({ items: [item('next')] });
    vi.mocked(transport.setWorkQueuesStopped).mockResolvedValue({ stopped: true });
    fireEvent.click(await screen.findByRole('switch', { name: "Stop every agent's queue" }));
    await waitFor(() => expect(transport.setWorkQueuesStopped).toHaveBeenCalled());
    expect(vi.mocked(transport.setWorkQueuesStopped).mock.calls[0]?.[0]).toBe(true);
  });

  it('sets the daily start limit when focus leaves it', async () => {
    const transport = renderPage({ startsToday: 3 });
    const input = await screen.findByLabelText('Starts per day (3 today)');
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(transport.updateWorkQueue).toHaveBeenCalledWith(MEMBER.agent!.manifestId, {
        dailyStartCap: 5,
      })
    );
  });

  it('says what is holding the next start', async () => {
    renderPage({ hold: 'load', items: [item('next')] });
    expect(await screen.findByText('Waiting: this computer is too busy.')).toBeInTheDocument();
  });

  it('says nothing about a hold while off', async () => {
    renderPage({ hold: 'load', enabled: false, items: [item('next')] });
    await screen.findByText('next');
    expect(screen.queryByText('Waiting: this computer is too busy.')).not.toBeInTheDocument();
  });

  it('says how an item ended, and offers to queue it again', async () => {
    renderPage({
      recent: [item('done', { state: 'ended', outcome: 'interrupted' })],
    });
    expect(await screen.findByText('Interrupted by a restart')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Queue again' })).toBeInTheDocument();
  });
});
