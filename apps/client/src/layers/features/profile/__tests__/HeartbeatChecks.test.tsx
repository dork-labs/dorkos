/**
 * @vitest-environment jsdom
 */
/**
 * The Heartbeat page's checks block (spec `heartbeats` §6.3, §7.6): the live
 * "Checks run on …" line and the one-time credits offer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { HeartbeatChecks as Checks } from '@dorkos/shared/heartbeat-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { HeartbeatChecks } from '../ui/heartbeat/HeartbeatChecks';

afterEach(cleanup);

const CHECKS: Checks = {
  runsOn: 'runtime',
  runtime: 'claude-code',
  today: 0,
  tokens: 0,
  offer: false,
};

function renderChecks(checks: Partial<Checks>) {
  const transport = createMockTransport();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <HeartbeatChecks checks={{ ...CHECKS, ...checks }} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

describe('HeartbeatChecks', () => {
  it('says where checks run, with no offer once it was answered', () => {
    renderChecks({});
    expect(screen.getByText('Checks run on Claude Code.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use credits' })).not.toBeInTheDocument();
  });

  it('says how many ran on credits today and their tokens', () => {
    renderChecks({ runsOn: 'credits', today: 41, tokens: 3200 });
    expect(screen.getByText('Checks run on DorkOS credits. 41 today.')).toBeInTheDocument();
    expect(screen.getByText('3,200 tokens today.')).toBeInTheDocument();
  });

  it('answers Use credits with yes and Not now with no', async () => {
    const transport = renderChecks({ offer: true });
    expect(screen.getByText('Run cheap checks on DorkOS credits?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Use credits' }));
    await waitFor(() => expect(transport.chooseTriageCredits).toHaveBeenCalledWith(true));
    cleanup();

    const again = renderChecks({ offer: true });
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(again.chooseTriageCredits).toHaveBeenCalledWith(false));
  });

  it('says so when the answer could not be saved', async () => {
    const transport = renderChecks({ offer: true });
    vi.mocked(transport.chooseTriageCredits).mockRejectedValueOnce(new Error('offline'));
    await userEvent.click(screen.getByRole('button', { name: 'Use credits' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t save your answer. Try again.'
    );
  });
});
