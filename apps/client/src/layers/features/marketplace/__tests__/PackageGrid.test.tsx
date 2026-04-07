/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AggregatedPackage, InstalledPackage } from '@dorkos/shared/marketplace-schemas';
import { useMarketplacePackages, useInstalledPackages } from '@/layers/entities/marketplace';
import { useDorkHubStore } from '../model/dork-hub-store';
import { PackageGrid } from '../ui/PackageGrid';

// ---------------------------------------------------------------------------
// Mock the marketplace entity hooks so each test controls the data layer
// independently of any Transport.
// ---------------------------------------------------------------------------

vi.mock('@/layers/entities/marketplace', () => ({
  useMarketplacePackages: vi.fn(),
  useInstalledPackages: vi.fn(),
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
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useMarketplacePackages>);
}

function setInstalledState(installed: InstalledPackage[] = []) {
  vi.mocked(useInstalledPackages).mockReturnValue({
    data: installed,
    error: null,
    isLoading: false,
  } as unknown as ReturnType<typeof useInstalledPackages>);
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
// Fixtures
// ---------------------------------------------------------------------------

function makePackage(overrides: Partial<AggregatedPackage> & { name: string }): AggregatedPackage {
  return {
    source: `github.com/dorkos/${overrides.name}`,
    description: `Description for ${overrides.name}`,
    type: 'plugin',
    marketplace: 'dork-hub',
    ...overrides,
  };
}

const PKG_ALPHA = makePackage({ name: 'alpha-plugin', type: 'plugin' });
const PKG_BETA = makePackage({ name: 'beta-agent', type: 'agent' });
const PKG_GAMMA = makePackage({ name: 'gamma-skill', type: 'skill-pack' });

// ---------------------------------------------------------------------------
// Store reset helper
// ---------------------------------------------------------------------------

const INITIAL_STORE_STATE = useDorkHubStore.getState();

function resetStore() {
  useDorkHubStore.setState(INITIAL_STORE_STATE, true);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PackageGrid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    setInstalledState([]);
  });

  afterEach(cleanup);

  it('shows the loading skeleton while data is loading', () => {
    setMarketplaceState({ isLoading: true });
    render(<PackageGrid />);

    // PackageLoadingSkeleton sets aria-busy="true" and an accessible label.
    const skeleton = screen.getByLabelText('Loading packages');
    expect(skeleton).toBeInTheDocument();
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
    // No package cards should be present in the loading state.
    expect(screen.queryByTestId('package-card-alpha-plugin')).not.toBeInTheDocument();
  });

  it('shows the error state when the query returns an error', () => {
    setMarketplaceState({ data: undefined, error: new Error('boom') });
    render(<PackageGrid />);

    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByLabelText('Loading packages')).not.toBeInTheDocument();
  });

  it('shows the empty state when the query returns an empty array', () => {
    setMarketplaceState({ data: [] });
    render(<PackageGrid />);

    expect(screen.getByText(/no packages match your filters/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reset filters/i })).toBeInTheDocument();
    expect(screen.queryByLabelText('Loading packages')).not.toBeInTheDocument();
  });

  it('renders one PackageCard per package when data resolves', () => {
    setMarketplaceState({ data: [PKG_ALPHA, PKG_BETA, PKG_GAMMA] });
    render(<PackageGrid />);

    expect(screen.getByTestId('package-card-alpha-plugin')).toBeInTheDocument();
    expect(screen.getByTestId('package-card-beta-agent')).toBeInTheDocument();
    expect(screen.getByTestId('package-card-gamma-skill')).toBeInTheDocument();
    // Empty / error / loading states should not be rendered.
    expect(screen.queryByLabelText('Loading packages')).not.toBeInTheDocument();
    expect(screen.queryByText(/no packages match your filters/i)).not.toBeInTheDocument();
  });

  it('marks installed packages so the Install button is replaced with the Installed indicator', () => {
    setMarketplaceState({ data: [PKG_ALPHA, PKG_BETA] });
    setInstalledState([
      {
        name: 'alpha-plugin',
        version: '1.0.0',
        type: 'plugin',
        installPath: '/tmp/alpha-plugin',
      },
    ]);
    render(<PackageGrid />);

    // alpha is installed → its card shows the literal "Installed" indicator
    // and the inner "Install →" button is removed.
    const alphaCard = screen.getByTestId('package-card-alpha-plugin');
    expect(alphaCard).toHaveTextContent('Installed');
    expect(alphaCard).not.toHaveTextContent('Install →');

    // beta is not installed → its card still shows the inner "Install →" button.
    const betaCard = screen.getByTestId('package-card-beta-agent');
    expect(betaCard).toHaveTextContent('Install →');
  });

  it('filters the rendered grid when the store search term excludes packages', () => {
    setMarketplaceState({ data: [PKG_ALPHA, PKG_BETA, PKG_GAMMA] });
    // Apply a search filter via the real store before rendering. The grid
    // reads from useDorkHubStore on every render, so the filter takes effect
    // immediately on mount.
    useDorkHubStore.getState().setSearch('alpha');
    render(<PackageGrid />);

    expect(screen.getByTestId('package-card-alpha-plugin')).toBeInTheDocument();
    expect(screen.queryByTestId('package-card-beta-agent')).not.toBeInTheDocument();
    expect(screen.queryByTestId('package-card-gamma-skill')).not.toBeInTheDocument();
  });

  it('filters by type when the store type filter is set', () => {
    setMarketplaceState({ data: [PKG_ALPHA, PKG_BETA, PKG_GAMMA] });
    useDorkHubStore.getState().setTypeFilter('agent');
    render(<PackageGrid />);

    expect(screen.getByTestId('package-card-beta-agent')).toBeInTheDocument();
    expect(screen.queryByTestId('package-card-alpha-plugin')).not.toBeInTheDocument();
    expect(screen.queryByTestId('package-card-gamma-skill')).not.toBeInTheDocument();
  });

  it('clicking a package card opens the detail sheet via the store', async () => {
    const user = userEvent.setup();
    setMarketplaceState({ data: [PKG_ALPHA] });
    render(<PackageGrid />);

    await user.click(screen.getByTestId('package-card-alpha-plugin'));

    const state = useDorkHubStore.getState();
    expect(state.detailPackage).not.toBeNull();
    expect(state.detailPackage?.name).toBe('alpha-plugin');
  });

  it('clicking the Install button opens the install confirmation via the store without opening the detail sheet', async () => {
    const user = userEvent.setup();
    setMarketplaceState({ data: [PKG_ALPHA] });
    render(<PackageGrid />);

    // Query the inner Install button by its exact text rather than role+name
    // to avoid matching the outer card-level <button>, whose computed
    // accessible name comes from its descendants.
    await user.click(screen.getByText('Install →'));

    const state = useDorkHubStore.getState();
    expect(state.installConfirmPackage).not.toBeNull();
    expect(state.installConfirmPackage?.name).toBe('alpha-plugin');
    // The card-level onClick (openDetail) must NOT have been called because
    // PackageCard stops propagation on the install button click.
    expect(state.detailPackage).toBeNull();
  });
});
