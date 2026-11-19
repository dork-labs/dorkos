/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LoadGateWaitingJob } from '@dorkos/shared/load-gate-queue';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TooltipProvider } from '@/layers/shared/ui';
import { TransportProvider } from '@/layers/shared/model';
import { LoadGateQueueCard } from '../ui/LoadGateQueueCard';

const NOW = Date.now();

function job(overrides: Partial<LoadGateWaitingJob> = {}): LoadGateWaitingJob {
  return {
    id: 'aaaaaaaaaaaaaaaa',
    position: 1,
    ownedHere: true,
    agentName: 'Scout',
    chatTitle: 'Fix login',
    label: 'pnpm',
    waitingSinceMs: NOW - 5 * 60_000,
    urgent: false,
    front: false,
    letThrough: false,
    ...overrides,
  };
}

const OTHER = job({
  id: 'bbbbbbbbbbbbbbbb',
  position: 2,
  ownedHere: false,
  agentName: undefined,
  chatTitle: undefined,
  label: 'tsc',
  waitingSinceMs: NOW,
});

function renderCard(transport: Transport) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <TooltipProvider>
          <LoadGateQueueCard />
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

function transportWith(jobs: LoadGateWaitingJob[], over: Partial<Transport> = {}) {
  return createMockTransport({
    getLoadGateWaitingLine: vi.fn().mockResolvedValue({ jobs }),
    actOnLoadGateJob: vi.fn().mockResolvedValue({ jobs }),
    ...over,
  });
}

afterEach(cleanup);

describe('LoadGateQueueCard', () => {
  it('shows no card while nothing waits', async () => {
    const transport = transportWith([]);
    renderCard(transport);
    await waitFor(() => expect(transport.getLoadGateWaitingLine).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Heavy jobs waiting' })).not.toBeInTheDocument();
  });

  it('shows no card on a device the server refuses', async () => {
    const refused = Object.assign(new Error('Do this at the computer running DorkOS.'), {
      status: 403,
      code: 'local_only',
    });
    const transport = transportWith([], {
      getLoadGateWaitingLine: vi.fn().mockRejectedValue(refused),
    });
    renderCard(transport);
    await waitFor(() => expect(transport.getLoadGateWaitingLine).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Heavy jobs waiting' })).not.toBeInTheDocument();
  });

  it('lists each job with its place, who it is for, what it runs and how long it has waited', async () => {
    renderCard(transportWith([job(), OTHER]));
    const card = await screen.findByRole('region', { name: 'Heavy jobs waiting' });
    const [mine, theirs] = within(card).getAllByRole('listitem');
    expect(mine).toHaveTextContent('1');
    expect(mine).toHaveTextContent('Scout');
    expect(mine).toHaveTextContent('pnpm');
    expect(mine).toHaveTextContent('Fix login · Waiting 5m');
    expect(theirs).toHaveTextContent('Another app on this computer');
    expect(theirs).toHaveTextContent('tsc');
    expect(theirs).toHaveTextContent('Waiting');
  });

  it('names every button by the job it acts on', async () => {
    renderCard(transportWith([job(), OTHER]));
    expect(await screen.findByRole('button', { name: 'Let through Scout’s pnpm' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Mark Scout’s pnpm urgent' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Move to front: Scout’s pnpm' })).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Let through another app’s tsc' })
    ).toBeInTheDocument();
  });

  it.each([
    ['Let through Scout’s pnpm', 'let-through', 'Scout’s pnpm starts now.'],
    ['Mark Scout’s pnpm urgent', 'urgent', 'Scout’s pnpm is urgent.'],
    ['Move to front: Scout’s pnpm', 'front', 'Scout’s pnpm is first in line.'],
  ])('%s sends that action and announces it', async (name, action, announcement) => {
    const user = userEvent.setup();
    const transport = transportWith([job()]);
    renderCard(transport);
    await user.click(await screen.findByRole('button', { name }));
    await waitFor(() =>
      expect(transport.actOnLoadGateJob).toHaveBeenCalledWith('aaaaaaaaaaaaaaaa', action)
    );
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(announcement));
  });

  it('works from the keyboard', async () => {
    const user = userEvent.setup();
    const transport = transportWith([job()]);
    renderCard(transport);
    const button = await screen.findByRole('button', { name: 'Let through Scout’s pnpm' });
    button.focus();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(transport.actOnLoadGateJob).toHaveBeenCalledWith('aaaaaaaaaaaaaaaa', 'let-through')
    );
  });

  it('holds back what a job already has, and says where it stands', async () => {
    const user = userEvent.setup();
    const transport = transportWith([job({ front: true, urgent: true })]);
    renderCard(transport);
    const urgent = await screen.findByRole('button', { name: 'Mark Scout’s pnpm urgent' });
    expect(urgent).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Move to front: Scout’s pnpm' })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    expect(screen.getByRole('listitem')).toHaveTextContent('First in line');
    await user.click(urgent);
    expect(transport.actOnLoadGateJob).not.toHaveBeenCalled();
  });

  it('says so when the job is no longer waiting', async () => {
    const user = userEvent.setup();
    const gone = Object.assign(new Error('That job isn’t waiting anymore.'), { status: 404 });
    renderCard(transportWith([job()], { actOnLoadGateJob: vi.fn().mockRejectedValue(gone) }));
    await user.click(await screen.findByRole('button', { name: 'Let through Scout’s pnpm' }));
    expect(await screen.findByText('This job isn’t waiting anymore.')).toBeInTheDocument();
  });
});
