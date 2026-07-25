/**
 * The approval card end to end: what it shows, what the buttons send, and how it
 * reacts to the global approval events (spec `agent-trust` §3.3).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import { createMockTransport } from '@dorkos/test-utils';

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useEventSubscription: vi.fn() };
});

import { TransportProvider, useEventSubscription } from '@/layers/shared/model';
import { PendingApprovalsSection } from '../ui/PendingApprovalsSection';

/** Build a pending approval, overriding only what a test cares about. */
function buildApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    approvalId: '01JZ0000000000000000000001',
    capabilityId: 'marketplace.uninstall',
    capabilityTitle: 'Uninstall a marketplace package',
    tier: 'destructive',
    summary: 'Uninstall "sentry-monitor"',
    requestedBy: '/Users/dev/agents/dorkbot',
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 8.5 * 60_000).toISOString(),
    ...overrides,
  };
}

/** Render the section over a mock transport, returning the transport for assertions. */
function renderSection(overrides: Partial<Transport> = {}) {
  const transport = createMockTransport(overrides);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  return { transport, ...render(<PendingApprovalsSection />, { wrapper: Wrapper }) };
}

describe('PendingApprovalsSection', () => {
  beforeEach(() => {
    vi.mocked(useEventSubscription).mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders zero DOM when nothing is waiting', async () => {
    renderSection({ listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }) });

    await waitFor(() => {
      expect(screen.queryByText('Waiting On You')).not.toBeInTheDocument();
    });
    expect(document.querySelector('[data-slot="approval-card"]')).toBeNull();
  });

  it('shows the capability title, tier, summary, requesting agent, and time left', async () => {
    renderSection({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
    });

    expect(await screen.findByText('Uninstall a marketplace package')).toBeInTheDocument();
    expect(screen.getByText('Cannot be undone')).toBeInTheDocument();
    expect(screen.getByText('Uninstall "sentry-monitor"')).toBeInTheDocument();
    // The requester's path is shown by its last segment — the agent's own name.
    expect(screen.getByText('dorkbot')).toBeInTheDocument();
    expect(screen.getByText('8 min left')).toBeInTheDocument();
  });

  it('says so plainly when the request carried no agent identity', async () => {
    renderSection({
      listPendingApprovals: vi
        .fn()
        .mockResolvedValue({ approvals: [buildApproval({ requestedBy: undefined })] }),
    });

    expect(await screen.findByText('Requested without an agent identity')).toBeInTheDocument();
  });

  it('grants through the transport when Allow is clicked', async () => {
    const grantApproval = vi
      .fn()
      .mockResolvedValue({ ok: true, approvalId: 'x', outcome: 'granted' });
    renderSection({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
      grantApproval,
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Allow' }));

    expect(grantApproval).toHaveBeenCalledWith('01JZ0000000000000000000001');
  });

  it('denies through the transport when the refuse button is clicked', async () => {
    const denyApproval = vi
      .fn()
      .mockResolvedValue({ ok: true, approvalId: 'x', outcome: 'denied' });
    renderSection({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
      denyApproval,
    });

    await userEvent.click(await screen.findByRole('button', { name: "Don't allow" }));

    expect(denyApproval).toHaveBeenCalledWith('01JZ0000000000000000000001', undefined);
  });

  it('says so when the list cannot be read, rather than looking like silence', async () => {
    // A failed fetch and "nothing waiting" render identically if this is missing,
    // so a person can be shown an empty dashboard while an agent sits blocked.
    renderSection({
      listPendingApprovals: vi.fn().mockRejectedValue(new Error('offline')),
    });

    expect(
      await screen.findByText(/could not check whether anything is waiting/i)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('re-reads the list when Try again is clicked', async () => {
    const listPendingApprovals = vi.fn().mockRejectedValue(new Error('offline'));
    renderSection({ listPendingApprovals });

    const button = await screen.findByRole('button', { name: 'Try again' });
    listPendingApprovals.mockResolvedValue({ approvals: [buildApproval()] });
    await userEvent.click(button);

    expect(await screen.findByText('Uninstall a marketplace package')).toBeInTheDocument();
  });

  it('clamps a long summary so the answer buttons stay reachable', async () => {
    renderSection({
      listPendingApprovals: vi.fn().mockResolvedValue({
        approvals: [buildApproval({ summary: 'Uninstall '.repeat(60) })],
      }),
    });

    const summary = await screen.findByText(/^Uninstall Uninstall/);
    expect(summary).toHaveClass('line-clamp-2');
  });

  it('shows more than one waiting approval', async () => {
    renderSection({
      listPendingApprovals: vi.fn().mockResolvedValue({
        approvals: [
          buildApproval(),
          buildApproval({
            approvalId: '01JZ0000000000000000000002',
            capabilityTitle: 'Delete a workspace',
            summary: 'Delete the scratch workspace',
          }),
        ],
      }),
    });

    expect(await screen.findByText('Uninstall a marketplace package')).toBeInTheDocument();
    expect(screen.getByText('Delete a workspace')).toBeInTheDocument();
  });
});
