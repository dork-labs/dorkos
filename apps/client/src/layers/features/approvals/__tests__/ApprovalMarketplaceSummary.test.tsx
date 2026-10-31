/**
 * The Marketplace summary card (DOR-3070): a list too long for the detail is
 * shown as the rows that add power, with the whole list one link away.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { MarketplaceApprovalSummary, PendingApproval } from '@dorkos/shared/approval-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { discardSettlingApprovals } from '../model/settling-approvals';
import { ApprovalCard } from '../ui/ApprovalCard';

const UPDATE: MarketplaceApprovalSummary = {
  operation: 'update',
  fullDetailLength: 6165,
  packages: [
    {
      name: 'sample-flow',
      where: 'plugin, installed globally',
      fromVersion: '0.66.0',
      toVersion: '0.66.1',
      power: 'adds',
      unchangedCount: 34,
      risks: [
        {
          kind: 'hook',
          change: 'broader',
          text: 'Runs a command when the agent finishes',
          command: '"node new.mjs"',
          was: '"node old.mjs"',
        },
        { kind: 'hook', change: 'removed', text: 'Runs a command after a session' },
      ],
    },
  ],
};

function buildApproval(summary: MarketplaceApprovalSummary): PendingApproval {
  return {
    approvalId: '01JZ0000000000000000000009',
    capabilityId: 'marketplace.update',
    capabilityTitle: 'Update installed packages',
    tier: 'destructive',
    summary: 'Update 1 installed package to a newer version, each where it is installed.',
    detail: 'the rows as text, for surfaces that cannot draw the summary',
    marketplaceSummary: summary,
    requestedBy: '/Users/dev/agents/dorkbot',
    hasAgentPath: true,
    area: null,
    alwaysOffered: false,
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 90 * 60_000).toISOString(),
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
  vi.clearAllMocks();
});

describe('ApprovalCard with a Marketplace summary', () => {
  it('shows the rows that add power instead of the detail', () => {
    renderCard(buildApproval(UPDATE));

    expect(screen.queryByText(/the rows as text/)).not.toBeInTheDocument();
    expect(screen.getByText('1 change gives it more power.')).toBeInTheDocument();
    expect(screen.getByText('"node new.mjs"')).toBeInTheDocument();
    expect(screen.getByText('"node old.mjs"')).toBeInTheDocument();
    expect(screen.getByText('34 things it already runs stay the same')).toBeInTheDocument();
    const rows = screen.getAllByText(/Runs a command/).map((el) => el.closest('li'));
    expect(rows.map((row) => row?.getAttribute('data-change'))).toEqual(['broader', 'removed']);
    expect(within(rows[0]!).getByText('Broader')).toBeInTheDocument();
  });

  it('keeps the answers after the list', () => {
    renderCard(buildApproval(UPDATE));

    const summary = document.querySelector('[data-slot="approval-marketplace-summary"]')!;
    const allow = screen.getByRole('button', { name: 'Allow' });
    expect(summary.compareDocumentPosition(allow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('opens the whole list from the link, fetched only then', async () => {
    const getApprovalFullDetail = vi.fn().mockResolvedValue({ text: 'every line, whole' });
    renderCard(buildApproval(UPDATE), { getApprovalFullDetail });
    expect(getApprovalFullDetail).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'See everything it runs' }));

    expect(await screen.findByText('every line, whole')).toBeInTheDocument();
    expect(getApprovalFullDetail).toHaveBeenCalledWith('01JZ0000000000000000000009');
  });

  it('says the card still stands when the whole list fails to load', async () => {
    const getApprovalFullDetail = vi.fn().mockRejectedValue(new Error('gone'));
    renderCard(buildApproval(UPDATE), { getApprovalFullDetail });

    await userEvent.click(screen.getByRole('button', { name: 'See everything it runs' }));

    expect(await screen.findByText('Couldn’t load the full list.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('groups an install by kind of power, the extension first', () => {
    renderCard(
      buildApproval({
        operation: 'install',
        fullDetailLength: 9000,
        packages: [
          {
            name: 'sample-flow',
            where: 'plugin, installed globally',
            toVersion: '0.66.1',
            power: 'adds',
            unchangedCount: 0,
            risks: [
              {
                kind: 'extension',
                change: 'new',
                text: 'The extension "panel" runs server code inside DorkOS, with full access to DorkOS',
              },
              {
                kind: 'hook',
                change: 'new',
                text: 'Runs a command when the agent finishes',
                command: '"x"',
              },
              ...Array.from({ length: 6 }, (_, i) => ({
                kind: 'skillTools' as const,
                change: 'new' as const,
                text: `The skill "s${i}" may use these without asking`,
                items: ['"Bash"'],
              })),
            ],
          },
        ],
      })
    );

    expect(screen.getByText('Once installed it can do 8 things.')).toBeInTheDocument();
    const groups = screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'));
    expect(groups).toEqual(['Runs inside DorkOS', 'Runs code', 'Uses secrets and skills']);
    expect(screen.queryByText(/"s0"/)).not.toBeInTheDocument();
  });

  it('opens the grouped skills in place, never to nothing', async () => {
    renderCard(
      buildApproval({
        operation: 'install',
        fullDetailLength: 9000,
        packages: [
          {
            name: 'sample',
            where: 'plugin, installed globally',
            toVersion: '1.0.0',
            power: 'adds',
            unchangedCount: 0,
            risks: Array.from({ length: 6 }, (_, i) => ({
              kind: 'skillTools' as const,
              change: 'new' as const,
              text: `The skill "s${i}" may use these without asking`,
              items: ['"Bash"'],
            })),
          },
        ],
      })
    );

    expect(
      screen.getByText(/6 skills and commands may use tools without asking/)
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show all 6' }));
    expect(screen.getByText('The skill "s5" may use these without asking')).toBeInTheDocument();
  });

  it('folds packages that add no power into one line that names each', () => {
    renderCard(
      buildApproval({
        ...UPDATE,
        packages: [
          ...UPDATE.packages,
          {
            name: 'quiet-one',
            where: 'plugin, installed globally',
            fromVersion: '1.0.0',
            toVersion: '1.0.1',
            power: 'none',
            unchangedCount: 2,
            risks: [],
          },
        ],
      })
    );

    expect(
      screen.getByText('1 more adds no new power: quiet-one 1.0.0 → 1.0.1')
    ).toBeInTheDocument();
  });
});
