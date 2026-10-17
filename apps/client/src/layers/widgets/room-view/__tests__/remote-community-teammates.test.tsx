// @vitest-environment jsdom
/**
 * The Teammates block on a space's agents panel (DOR-2956): who may wake the owner's agents, and
 * the monthly limit on what teammates' turns may cost, "No limit" by default.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport, withSpacesExperiment } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { RemoteCommunityTeammates } from '../ui/teammates/RemoteCommunityTeammates';

afterEach(cleanup);

function mount(
  spend: Partial<{ monthlyLimitUsd: number | null; spentUsd: number; approximate: boolean }> = {}
) {
  const transport = withSpacesExperiment(createMockTransport());
  vi.mocked(transport.getCommunityTeammateSpend).mockResolvedValue({
    monthlyLimitUsd: null,
    spentUsd: 0,
    approximate: false,
    month: '2026-10',
    ...spend,
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TransportProvider transport={transport}>
        <TooltipProvider>
          <RemoteCommunityTeammates community="a" online />
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

describe('the Teammates block', () => {
  it('says "No limit" plainly by default, with what was spent', async () => {
    mount();
    expect(await screen.findByText(/^No limit · \$0\.00 spent this month$/)).toBeInTheDocument();
    expect(screen.getByLabelText('Monthly limit for teammates')).toHaveValue('');
  });

  it('shows a set limit, and says when the total is approximate', async () => {
    mount({ monthlyLimitUsd: 20, spentUsd: 4.5, approximate: true });
    expect(
      await screen.findByText('Limit $20.00 a month · $4.50 spent this month, approximate')
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Monthly limit for teammates')).toHaveValue('20');
  });

  it('saves a limit in dollars, and clears it back to none', async () => {
    const transport = mount();
    const field = await screen.findByLabelText('Monthly limit for teammates');
    fireEvent.change(field, { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(transport.setCommunityTeammateSpendLimit).toHaveBeenCalledWith('a', 25)
    );
  });

  it('refuses an amount that is not above zero', async () => {
    const transport = mount({ monthlyLimitUsd: 10 });
    const field = await screen.findByLabelText('Monthly limit for teammates');
    fireEvent.change(field, { target: { value: '0' } });
    expect(screen.getByText('Enter an amount above zero, or leave it empty.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(transport.setCommunityTeammateSpendLimit).toHaveBeenCalledWith('a', null)
    );
  });

  it('shows and changes who can wake the agents', async () => {
    const transport = mount();
    const trigger = await screen.findByLabelText('Who can wake your agents');
    expect(trigger).toHaveTextContent('Anyone in this space');
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('option', { name: 'Only me' }));
    await waitFor(() =>
      expect(transport.setCommunityWakeAgentsFrom).toHaveBeenCalledWith('a', 'me')
    );
  });
});
