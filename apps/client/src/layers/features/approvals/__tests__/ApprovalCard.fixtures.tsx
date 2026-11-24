/** Shared fixtures for the ApprovalCard tests: an approval builder, a rendered card, and per-test cleanup. */
import { vi, beforeAll, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import { TransportProvider } from '@/layers/shared/model';
import { discardSettlingApprovals } from '../model/settling-approvals';
import { discardDismissedSuggestions } from '../model/use-dismiss-suggestion';
import { ApprovalCard } from '../ui/ApprovalCard';
/** Build a pending approval, overriding only what a test cares about. */
export function buildApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    approvalId: '01JZ0000000000000000000001',
    capabilityId: 'marketplace.uninstall',
    capabilityTitle: 'Uninstall a marketplace package',
    tier: 'destructive',
    summary: 'Uninstall "sentry-monitor"',
    requestedBy: '/Users/dev/agents/dorkbot',
    hasAgentPath: true,
    area: null,
    alwaysOffered: false,
    answerNeedsStepUp: false,
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 90 * 60_000).toISOString(),
    ...overrides,
  };
}

/** Render one card over a mock transport. */
export function renderCard(
  approval: PendingApproval,
  overrides: Partial<Transport> = {}
): { transport: Transport; container: HTMLElement; unmount: () => void } {
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

/** Install the matchMedia stub and the per-test cleanup every ApprovalCard suite needs. */
export function installApprovalCardSuite() {
  beforeAll(() => {
    // `sonner` toasts on a refused answer and asks for matchMedia on the way.
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
    // Both halves are module-level and outlive `cleanup()` by design — the hold's
    // timer so it can survive the card being unmounted, and the answer so it can
    // survive the hold. A suite that answered something would otherwise carry it
    // into the next case twice over.
    discardSettlingApprovals();
    discardDismissedSuggestions();
    vi.useRealTimers();
    vi.clearAllMocks();
  });
}
