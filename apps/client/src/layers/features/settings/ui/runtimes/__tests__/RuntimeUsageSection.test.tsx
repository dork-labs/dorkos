/**
 * @vitest-environment jsdom
 *
 * The "Usage" row of the Codex and OpenCode cards (spec `claude-account-ui`
 * §6.5): windows as bars, spend as one line, nothing when there is neither,
 * and usage fetched only while the Runtimes tab's cards are mounted.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import { createMockAccountUsage, createMockTransport } from '@dorkos/test-utils';
import { TransportProvider, seedAccountUsage } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { RuntimeUsageSection } from '../sections/RuntimeUsageSection';
import { RuntimeCard } from '../RuntimeCard';

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
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(cleanup);

function codexUsage(over: Partial<AccountUsage> = {}): AccountUsage {
  return createMockAccountUsage({
    runtime: 'codex',
    accountId: 'default',
    path: '/Users/dev/.codex',
    label: null,
    ...over,
  });
}

/** The start of the current local month, so the spend reading is "this month" whenever the test runs. */
const THIS_MONTH_START = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();

const SPEND = {
  periodStart: THIS_MONTH_START,
  costUsd: 4.2,
  limitUsd: null,
  observedAt: '2026-09-27T12:00:00.000Z',
  source: 'sidecar' as const,
};

function renderWith(ui: React.ReactNode, usage: AccountUsage[] = []) {
  const transport = createMockTransport({
    getAccountUsage: vi.fn().mockResolvedValue({ accounts: usage }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedAccountUsage(queryClient, usage);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>{ui}</TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  return { transport, view };
}

describe('RuntimeUsageSection', () => {
  it("draws Codex's 5-hour and weekly bars from its default account", () => {
    renderWith(<RuntimeUsageSection type="codex" />, [codexUsage()]);
    expect(screen.getByRole('heading', { name: 'Usage' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /^5-hour window 40% used/ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /^Weekly 72% used/ })).toBeInTheDocument();
  });

  it('draws a window the account lacks as unknown', () => {
    const weekOnly = codexUsage({ windows: [createMockAccountUsage().windows[1]!] });
    renderWith(<RuntimeUsageSection type="codex" />, [weekOnly]);
    const unknown = screen.getByRole('img', { name: '5-hour window usage unknown' });
    expect(unknown.querySelector('[data-slot="usage-fill"]')).toBeNull();
    expect(screen.getByText('unknown')).toBeInTheDocument();
  });

  it('shows what OpenCode spent this month, and no bars', () => {
    renderWith(<RuntimeUsageSection type="opencode" />, [
      codexUsage({ runtime: 'opencode', windows: [], spend: SPEND }),
    ]);
    expect(screen.getByText('$4.20 spent this month')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('hides a spend total from an earlier month rather than calling it this month', () => {
    // A spend reading never goes stale, so last month's total must not read as this month's.
    const lastMonth = new Date(
      new Date().getFullYear(),
      new Date().getMonth() - 1,
      15
    ).toISOString();
    renderWith(<RuntimeUsageSection type="opencode" />, [
      codexUsage({ runtime: 'opencode', windows: [], spend: { ...SPEND, periodStart: lastMonth } }),
    ]);
    expect(screen.queryByText(/spent this month/)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Usage' })).not.toBeInTheDocument();
  });

  it('shows no row when the account has no windows and no spend', () => {
    renderWith(<RuntimeUsageSection type="opencode" />, [
      codexUsage({ runtime: 'opencode', windows: [], spend: null }),
    ]);
    expect(screen.queryByRole('heading', { name: 'Usage' })).not.toBeInTheDocument();
  });

  it('reads the cache without asking the server itself', () => {
    const { transport } = renderWith(<RuntimeUsageSection type="codex" />, [codexUsage()]);
    expect(transport.getAccountUsage).not.toHaveBeenCalled();
  });

  it("fetches the runtime's usage while its card is mounted, and draws the row", async () => {
    const { transport } = renderWith(
      <RuntimeCard
        type="codex"
        isDefault={false}
        trustStop={null}
        globalStop="ask"
        onChangeTrustStop={vi.fn()}
        onMakeDefault={vi.fn()}
      />,
      [codexUsage()]
    );
    await waitFor(() => expect(transport.getAccountUsage).toHaveBeenCalledWith('codex'));
  });
});
