/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';
import { useMarketplacePackages } from '@/layers/entities/marketplace';
import { TemplatePicker } from '../ui/TemplatePicker';

// ---------------------------------------------------------------------------
// Mock the marketplace entity so each test can control state independently
// ---------------------------------------------------------------------------

vi.mock('@/layers/entities/marketplace', () => ({
  useMarketplacePackages: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock PackageCard from marketplace feature
// ---------------------------------------------------------------------------

vi.mock('@/layers/features/marketplace', () => ({
  PackageCard: ({
    pkg,
    variant,
    onClick,
  }: {
    pkg: { name: string; description?: string; source: string };
    variant?: string;
    onClick: () => void;
  }) => (
    <button
      data-testid={`package-card-${pkg.name}`}
      data-variant={variant}
      onClick={onClick}
      type="button"
    >
      <span>{pkg.name}</span>
      {pkg.description && <span>{pkg.description}</span>}
    </button>
  ),
}));

type MarketplaceHookState = {
  data?: AggregatedPackage[];
  error?: Error | null;
  isLoading?: boolean;
};

function setMarketplaceState(state: MarketplaceHookState) {
  vi.mocked(useMarketplacePackages).mockReturnValue({
    data: state.data,
    error: state.error ?? null,
    isLoading: state.isLoading ?? false,
  } as unknown as ReturnType<typeof useMarketplacePackages>);
}

// ---------------------------------------------------------------------------
// Browser API mocks
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function renderPicker(
  props: {
    onSelect?: (source: string | null, name?: string) => void;
  } = {}
) {
  const transport = createMockTransport();
  const onSelect = props.onSelect ?? vi.fn();
  const queryClient = createTestQueryClient();

  const result = render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TemplatePicker onSelect={onSelect} />
      </TransportProvider>
    </QueryClientProvider>
  );

  return { ...result, onSelect, transport, queryClient };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const codeReviewer: AggregatedPackage = {
  name: '@dorkos/code-reviewer',
  source: 'github.com/dorkos/code-reviewer',
  description: 'Reviews pull requests',
  type: 'agent',
  marketplace: 'dork-hub',
};

const docWriter: AggregatedPackage = {
  name: '@dorkos/doc-writer',
  source: 'github.com/dorkos/doc-writer',
  description: 'Writes documentation',
  type: 'agent',
  marketplace: 'dork-hub',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TemplatePicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setMarketplaceState({ data: [] });
  });

  afterEach(cleanup);

  // -------------------------------------------------------------------------
  // Label
  // -------------------------------------------------------------------------

  it('does not render a label (step title serves as label)', () => {
    renderPicker();
    expect(screen.queryByText('Template (optional)')).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Marketplace grid
  // -------------------------------------------------------------------------

  it('renders marketplace agent cards when the hook returns data', () => {
    setMarketplaceState({ data: [codeReviewer, docWriter] });
    renderPicker();

    const grid = screen.getByTestId('marketplace-template-grid');
    expect(within(grid).getByTestId('package-card-@dorkos/code-reviewer')).toBeInTheDocument();
    expect(within(grid).getByTestId('package-card-@dorkos/doc-writer')).toBeInTheDocument();
    expect(within(grid).getByText('Reviews pull requests')).toBeInTheDocument();
    expect(within(grid).getByText('Writes documentation')).toBeInTheDocument();
  });

  it('shows empty state when marketplace returns no agents', () => {
    setMarketplaceState({ data: [] });
    renderPicker();

    expect(screen.getByText(/No marketplace agents available/i)).toBeInTheDocument();
    expect(screen.queryByTestId('marketplace-template-grid')).not.toBeInTheDocument();
  });

  it('shows error state when marketplace hook returns an error', () => {
    setMarketplaceState({ data: undefined, error: new Error('network down') });
    renderPicker();

    expect(screen.getByText(/Could not load marketplace agents/i)).toBeInTheDocument();
    expect(screen.queryByTestId('marketplace-template-grid')).not.toBeInTheDocument();
  });

  it('renders marketplace agents in a 2-column grid using PackageCard compact variant', () => {
    setMarketplaceState({ data: [codeReviewer, docWriter] });
    renderPicker();

    const grid = screen.getByTestId('marketplace-template-grid');
    expect(grid).toHaveClass('grid-cols-2');

    // Check PackageCard variant prop
    const cards = grid.querySelectorAll('[data-variant="compact"]');
    expect(cards).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Selection behavior
  // -------------------------------------------------------------------------

  it('clicking a marketplace agent calls onSelect with source and name', async () => {
    const user = userEvent.setup();
    setMarketplaceState({ data: [codeReviewer] });
    const { onSelect } = renderPicker();

    const card = screen.getByTestId('package-card-@dorkos/code-reviewer');
    await user.click(card);

    expect(onSelect).toHaveBeenCalledWith(
      'github.com/dorkos/code-reviewer',
      '@dorkos/code-reviewer'
    );
  });

  // -------------------------------------------------------------------------
  // Advanced collapsible (custom URL)
  // -------------------------------------------------------------------------

  it('renders the Advanced collapsible trigger', () => {
    renderPicker();
    expect(screen.getByTestId('advanced-toggle')).toBeInTheDocument();
    expect(screen.getByText('Advanced')).toBeInTheDocument();
  });

  it('custom URL input is hidden by default inside closed collapsible', () => {
    renderPicker();
    expect(screen.queryByTestId('custom-url-input')).not.toBeInTheDocument();
  });

  it('opening the Advanced collapsible reveals the custom URL input', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByTestId('advanced-toggle'));

    expect(screen.getByTestId('custom-url-input')).toBeInTheDocument();
  });

  it('custom URL input calls onSelect when Go button is clicked', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderPicker();

    await user.click(screen.getByTestId('advanced-toggle'));

    const urlInput = screen.getByTestId('custom-url-input');
    await user.type(urlInput, 'github.com/my/repo');

    await user.click(screen.getByTestId('custom-url-go'));

    expect(onSelect).toHaveBeenCalledWith('github.com/my/repo');
  });

  it('Go button is disabled when custom URL input is empty', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByTestId('advanced-toggle'));

    expect(screen.getByTestId('custom-url-go')).toBeDisabled();
  });

  // -------------------------------------------------------------------------
  // No built-in templates or tabs
  // -------------------------------------------------------------------------

  it('does not render inner tabs or category filters', () => {
    setMarketplaceState({ data: [codeReviewer] });
    renderPicker();

    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByText('Built-in')).not.toBeInTheDocument();
    expect(screen.queryByText('From Dork Hub')).not.toBeInTheDocument();
    expect(screen.queryByTestId('template-grid')).not.toBeInTheDocument();
  });
});
