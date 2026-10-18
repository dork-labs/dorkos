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
  spend: Partial<{
    monthlyLimitUsd: number | null;
    spentUsd: number;
    approximate: boolean;
    hasAgentsHere: boolean;
    sharedFolder: string | null;
  }> = {},
  canEnroll = true
) {
  const transport = withSpacesExperiment(createMockTransport());
  vi.mocked(transport.getCommunityTeammateSpend).mockResolvedValue({
    monthlyLimitUsd: null,
    spentUsd: 0,
    approximate: false,
    month: '2026-10',
    hasAgentsHere: false,
    sharedFolder: null,
    ...spend,
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TransportProvider transport={transport}>
        <TooltipProvider>
          <RemoteCommunityTeammates community="a" online canEnroll={canEnroll} />
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

describe('the Teammates block', () => {
  it('shows for an owner who has an agent here even when they can’t add one (review N3)', async () => {
    mount({ hasAgentsHere: true }, false);
    expect(await screen.findByText('Teammates')).toBeInTheDocument();
  });

  it('shows nothing to someone who can’t add an agent and has none here', async () => {
    const transport = mount({}, false);
    await waitFor(() => expect(transport.getCommunityTeammateSpend).toHaveBeenCalled());
    expect(screen.queryByText('Teammates')).not.toBeInTheDocument();
  });

  it('says a running turn may go slightly past the limit (review S3)', async () => {
    mount();
    expect(
      await screen.findByText(
        'Past the limit, teammates’ messages wake nobody. A running turn may go slightly over.'
      )
    ).toBeInTheDocument();
  });

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
    fireEvent.click(screen.getByRole('button', { name: 'Save limit' }));
    await waitFor(() =>
      expect(transport.setCommunityTeammateSpendLimit).toHaveBeenCalledWith('a', 25)
    );
  });

  it('refuses an amount that is not above zero', async () => {
    const transport = mount({ monthlyLimitUsd: 10 });
    const field = await screen.findByLabelText('Monthly limit for teammates');
    // Review B1: a tenth of a cent rounds to nothing, so it is refused here as on the server.
    fireEvent.change(field, { target: { value: '0.004' } });
    expect(screen.getByText('Enter at least $0.01, or leave it empty.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save limit' })).toBeDisabled();
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limit' }));
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

  it('says no folder is shared by default, and saves one (DOR-2956)', async () => {
    const transport = mount();
    expect(await screen.findByText('Teammates’ turns read no files.')).toBeInTheDocument();
    const field = screen.getByLabelText('Shared folder');
    fireEvent.change(field, { target: { value: '/Users/ada/code/acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save folder' }));
    await waitFor(() =>
      expect(transport.setCommunityTeammateSharedFolder).toHaveBeenCalledWith(
        'a',
        '/Users/ada/code/acme'
      )
    );
  });

  it('shows the folder shared, and what is never read there', async () => {
    mount({ sharedFolder: '/Users/ada/code/acme' });
    expect(await screen.findByLabelText('Shared folder')).toHaveValue('/Users/ada/code/acme');
    expect(
      screen.getByText('Teammates’ turns can read files here, never .env files, .git or .dork.')
    ).toBeInTheDocument();
  });
});
