/**
 * The paid-run card (DOR-4204 spec 1.0 §4): its title and marker, the money
 * line read before Allow once, no Always allow, and the receipts, including
 * the limit stopping an Allow once at the tap.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ApprovalSpend, PendingApproval } from '@dorkos/shared/approval-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { discardSettlingApprovals } from '../model/settling-approvals';
import { ApprovalCard } from '../ui/ApprovalCard';

const NO_LIMIT: ApprovalSpend = {
  priceMicro: null,
  priceSource: null,
  limitMicro: null,
  leftMicro: null,
  currency: 'USD',
};

const UNDER_LIMIT: ApprovalSpend = {
  priceMicro: '300000',
  priceSource: 'person',
  limitMicro: '40000000',
  leftMicro: '27600000',
  currency: 'USD',
};

function paidApproval(spend: ApprovalSpend): PendingApproval {
  return {
    approvalId: '01JZ0000000000000000000009',
    capabilityId: 'connectors.execute_read',
    capabilityTitle: 'Run an app action',
    tier: 'act',
    summary: 'Acme Search: Search the web for "Northwind pricing".',
    requestedBy: '/Users/dev/agents/kestrel',
    hasAgentPath: true,
    area: null,
    alwaysOffered: true,
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
    serviceAction: {
      serviceId: 'tavily',
      serviceName: 'Acme Search',
      accountLabel: 'Team account',
      actionName: 'Search the web',
      details: [{ label: 'Query', value: 'Northwind pricing' }],
      keptCardBecause: 'spend',
      spend,
    },
  };
}

function renderCard(approval: PendingApproval, overrides: Partial<Transport> = {}) {
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
  return { transport, ...render(<ApprovalCard approval={approval} />, { wrapper: Wrapper }) };
}

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  discardSettlingApprovals();
});

describe('the paid-run card', () => {
  it('says it runs a paid action, with the marker in words and the action named', () => {
    renderCard(paidApproval(UNDER_LIMIT));
    expect(screen.getByText('Run a paid action')).toBeInTheDocument();
    expect(screen.getByText('Spends money')).toBeInTheDocument();
    expect(screen.getByText('Search the web')).toBeInTheDocument();
    // The marker stands in for the tier badge.
    expect(screen.queryByText('Changes things')).not.toBeInTheDocument();
  });

  it('reads the price and what is left before Allow once, and never offers Always allow', () => {
    renderCard(paidApproval(UNDER_LIMIT));
    const line = document.querySelector('[data-slot="approval-spend"]');
    expect(line).toHaveTextContent('About $0.30');
    expect(line).toHaveTextContent('$27.60 left this month');
    const allow = screen.getByRole('button', { name: 'Allow once' });
    expect(allow).toHaveAttribute('aria-describedby', line?.id);
    expect(screen.queryByRole('button', { name: 'Always allow' })).not.toBeInTheDocument();
  });

  it('says the price is unknown and no limit is set', () => {
    renderCard(paidApproval(NO_LIMIT));
    const line = document.querySelector('[data-slot="approval-spend"]');
    expect(line).toHaveTextContent('Price unknown');
    expect(line).toHaveTextContent('No monthly limit');
  });

  it('answers Allow once with the price on the receipt', async () => {
    const { transport } = renderCard(paidApproval(UNDER_LIMIT));
    await userEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(transport.grantApproval).toHaveBeenCalledWith('01JZ0000000000000000000009', undefined);
    expect(await screen.findByText('Allowed once · $0.30')).toBeInTheDocument();
  });

  it('says nothing was spent on Don’t allow', async () => {
    renderCard(paidApproval(UNDER_LIMIT));
    await userEvent.click(screen.getByRole('button', { name: 'Don’t allow' }));
    expect(await screen.findByText('Not allowed. Nothing was spent.')).toBeInTheDocument();
  });

  it('says the limit was reached when it stops Allow once at the tap (spec §4.4)', async () => {
    const refused = Object.assign(new Error('The monthly limit was reached. Nothing was spent.'), {
      code: 'SPEND_LIMIT',
      status: 409,
    });
    renderCard(paidApproval(UNDER_LIMIT), {
      grantApproval: vi.fn().mockRejectedValue(refused),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    await waitFor(() =>
      expect(
        screen.getByText('The monthly limit was reached. Nothing was spent.')
      ).toBeInTheDocument()
    );
    // The card is answered: the buttons do not come back.
    expect(screen.queryByRole('button', { name: 'Allow once' })).not.toBeInTheDocument();
  });
});
