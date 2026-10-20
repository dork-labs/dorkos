/**
 * @vitest-environment jsdom
 *
 * The rules under one Claude account's row in Settings → Runtimes, and the
 * "Move agents here automatically" switch (Re-seat P0): on by default, off for
 * an account a person kept agents off, and absent for Main with no row.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { AccountRowRules, type AccountRule } from '../sections/AccountRowRules';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderRules(rule: AccountRule) {
  const transport = createMockTransport();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <AccountRowRules name="Work" rule={rule} disabled={false} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

const SWITCH = { name: 'Move agents here automatically' };

describe('AccountRowRules — automatic moves', () => {
  // Purpose: the default reads on, and turning it off keeps agents off the account.
  it('shows the switch on, and turning it off sends noAutoMove: true', async () => {
    const transport = renderRules({ accountId: 'work', onlyProjects: null, noAutoMove: false });
    const toggle = screen.getByRole('switch', SWITCH);
    expect(toggle).toBeChecked();
    expect(
      screen.getByText('When an agent runs out in a room, it can continue here.')
    ).toBeInTheDocument();

    await userEvent.click(toggle);

    await waitFor(() => expect(transport.setAccountNoAutoMove).toHaveBeenCalledWith('work', true));
  });

  // Purpose: an account a person kept agents off reads off, and turning it on lets them back.
  it('shows the switch off for a kept-off account, and turning it on sends false', async () => {
    const transport = renderRules({ accountId: 'work', onlyProjects: null, noAutoMove: true });
    const toggle = screen.getByRole('switch', SWITCH);
    expect(toggle).not.toBeChecked();

    await userEvent.click(toggle);

    await waitFor(() => expect(transport.setAccountNoAutoMove).toHaveBeenCalledWith('work', false));
  });

  // Purpose: Main with no registry row cannot carry the flag, so it has no switch.
  it('draws no switch for an account with no registry row', () => {
    renderRules({ accountId: 'default', onlyProjects: null });
    expect(screen.queryByRole('switch', SWITCH)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Limit to projects…' })).toBeInTheDocument();
  });

  // Purpose: a refused write shows the server's sentence.
  it("shows the server's sentence when the change is refused", async () => {
    const transport = renderRules({ accountId: 'work', onlyProjects: null, noAutoMove: false });
    vi.mocked(transport.setAccountNoAutoMove).mockRejectedValueOnce(
      new Error('Only a person can choose whether agents move here automatically.')
    );

    await userEvent.click(screen.getByRole('switch', SWITCH));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only a person can choose whether agents move here automatically.'
    );
  });
});
