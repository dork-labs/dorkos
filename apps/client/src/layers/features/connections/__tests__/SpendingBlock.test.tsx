/**
 * Connections → Spending (DOR-4204 spec 1.0 §2, §7, §10, §11): hidden while
 * nothing can spend, the limit saves as micro-units, `0` never saves (#12),
 * Esc puts the saved value back, and the bar arrives drawn (#13).
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport, emptySpendingSummary } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { SpendingBlock } from '../ui/spending/SpendingBlock';

const nameOf = (toolkit: string) => (toolkit === 'tavily' ? 'Acme Search' : toolkit);

function renderBlock(overrides: Partial<Transport> = {}, canSpend = true) {
  const transport = createMockTransport(overrides);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  return {
    transport,
    ...render(<SpendingBlock canSpend={canSpend} nameOf={nameOf} />, { wrapper: Wrapper }),
  };
}

afterEach(cleanup);

describe('the Spending block', () => {
  it('is hidden while nothing can spend and nothing was ever set', async () => {
    const { transport } = renderBlock({}, false);
    await waitFor(() => expect(transport.getConnectorSpending).toHaveBeenCalled());
    expect(screen.queryByTestId('spending-block')).not.toBeInTheDocument();
  });

  it('asks every time with no limit, and says so', async () => {
    renderBlock();
    const field = await screen.findByLabelText('Monthly limit');
    expect(field).toHaveAttribute('placeholder', 'Ask every time');
    expect(field).toHaveAttribute('inputmode', 'decimal');
    expect(screen.getByText('With no limit, every paid action asks you first.')).toBeVisible();
    expect(screen.getByText('Nothing spent this month.')).toBeVisible();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('saves a typed limit as micro-units, with Enter', async () => {
    const { transport } = renderBlock();
    const field = await screen.findByLabelText('Monthly limit');
    await userEvent.type(field, '40{Enter}');
    expect(transport.setConnectorSpendingLimit).toHaveBeenCalledWith('40000000');
  });

  it('never saves 0 or 0.001, and says why (fail-first #12)', async () => {
    const { transport } = renderBlock();
    const field = await screen.findByLabelText('Monthly limit');
    for (const typed of ['0', '0.001']) {
      await userEvent.clear(field);
      await userEvent.type(field, `${typed}{Enter}`);
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Enter at least $0.01, or leave it empty.'
      );
      expect(field).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    }
    expect(transport.setConnectorSpendingLimit).not.toHaveBeenCalled();
  });

  it('puts the saved limit back on Esc', async () => {
    renderBlock({
      getConnectorSpending: vi
        .fn()
        .mockResolvedValue(emptySpendingSummary({ limitMicro: '40000000', leftMicro: '40000000' })),
    });
    const field = await screen.findByLabelText('Monthly limit');
    expect(field).toHaveValue('40.00');
    await userEvent.clear(field);
    await userEvent.type(field, '90{Escape}');
    expect(field).toHaveValue('40.00');
  });

  it('shows the month under a limit, with a bar that speaks amounts and arrives drawn (#13)', async () => {
    renderBlock({
      getConnectorSpending: vi.fn().mockResolvedValue(
        emptySpendingSummary({
          limitMicro: '40000000',
          usedMicro: '12400000',
          leftMicro: '27600000',
          overMicro: '0',
          approximate: true,
          byApp: [
            {
              toolkit: 'tavily',
              runs: 31,
              amountMicro: '9300000',
              estimated: true,
              unknownRuns: 0,
            },
          ],
        })
      ),
    });
    const bar = await screen.findByRole('progressbar', { name: 'Spending limit used' });
    expect(bar).toHaveAttribute('aria-valuetext', '$12.40 of $40.00 used');
    expect(screen.getByTestId('spending-status')).toHaveTextContent(
      /\$12\.40 of \$40\.00 used · resets .+, approximate/
    );
    expect(screen.getByText('Acme Search · 31 runs')).toBeVisible();
    expect(screen.getByText('about $9.30')).toBeVisible();
    expect(
      screen.getByText('Raising it asks you to confirm it’s you. Lowering never does.')
    ).toBeVisible();
  });

  it('fails closed when the meter can’t be read (spec §7.9)', async () => {
    renderBlock({
      getConnectorSpending: vi
        .fn()
        .mockResolvedValue({
          ...emptySpendingSummary({ limitMicro: '40000000' }),
          meterReadable: false,
        }),
    });
    expect(await screen.findByText(/Couldn’t read this month’s spending\./)).toBeVisible();
    expect(screen.getByText(/Paid actions ask every time\./)).toBeVisible();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('says it couldn’t load, with Retry', async () => {
    const { transport } = renderBlock({
      getConnectorSpending: vi.fn().mockRejectedValue(new Error('down')),
    });
    expect(await screen.findByText('Couldn’t load spending.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(transport.getConnectorSpending).toHaveBeenCalledTimes(2);
  });
});
