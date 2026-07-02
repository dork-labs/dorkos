/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';
import { useMarketplacePackages } from '@/layers/entities/marketplace';

import { FeaturedAgentsRail } from '../ui/FeaturedAgentsRail';
import { useMarketplaceStore } from '../model/marketplace-store';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/layers/entities/marketplace', () => ({
  useMarketplacePackages: vi.fn(),
}));

// The rail hides itself when search/type filters are active and opens the
// drawer through `useMarketplaceParams` (URL-backed). Install-confirm stays on
// the store.
const mockParams = vi.hoisted(() => ({
  type: 'all' as string,
  sort: 'featured' as string,
  search: '' as string,
  category: null as string | null,
  selectedPackageName: null as string | null,
  setType: vi.fn(),
  setSort: vi.fn(),
  setSearch: vi.fn(),
  setCategory: vi.fn(),
  resetFilters: vi.fn(),
  openDetail: vi.fn(),
  closeDetail: vi.fn(),
}));

vi.mock('../model/use-marketplace-params', () => ({
  useMarketplaceParams: () => mockParams,
}));

type UseMarketplacePackagesReturn = ReturnType<typeof useMarketplacePackages>;

function setPackagesState(state: {
  data?: AggregatedPackage[];
  isLoading?: boolean;
  error?: Error | null;
}) {
  vi.mocked(useMarketplacePackages).mockReturnValue({
    data: state.data,
    isLoading: state.isLoading ?? false,
    error: state.error ?? null,
    refetch: vi.fn(),
  } as unknown as UseMarketplacePackagesReturn);
}

// ---------------------------------------------------------------------------
// jsdom polyfills for matchMedia (Radix / responsive utilities)
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

function makeAgent(name: string, featured = true): AggregatedPackage {
  return {
    name,
    source: `github.com/dorkos/${name}`,
    description: `Agent ${name}`,
    version: '1.0.0',
    type: 'agent',
    featured,
    marketplace: 'marketplace',
  };
}

// ---------------------------------------------------------------------------
// Store snapshot/restore (don't leak install state across tests)
// ---------------------------------------------------------------------------

const INITIAL_STORE_STATE = useMarketplaceStore.getState();

function resetStore() {
  useMarketplaceStore.setState(INITIAL_STORE_STATE, true);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FeaturedAgentsRail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    mockParams.type = 'all';
    mockParams.search = '';
  });

  afterEach(cleanup);

  it('renders the loading skeleton while the packages query is pending', () => {
    setPackagesState({ isLoading: true });

    render(<FeaturedAgentsRail />);

    // Heading is present, and the skeletons are rendered (aria-busy via Skeleton primitive is
    // implementation-specific — assert on the heading + the fact that no PackageCard test IDs exist).
    expect(screen.getByText('Featured')).toBeInTheDocument();
    expect(screen.queryByTestId(/^package-card-/)).not.toBeInTheDocument();
  });

  it('falls back to "Popular Packages" when there are zero featured agents', () => {
    setPackagesState({
      data: [makeAgent('@dorkos/a', false), makeAgent('@dorkos/b', false)],
    });

    render(<FeaturedAgentsRail />);

    // No featured agents → falls back to "Popular Packages" rail.
    expect(screen.queryByText('Featured Agents')).not.toBeInTheDocument();
    expect(screen.getByText('Popular Packages')).toBeInTheDocument();
    expect(screen.getByTestId('package-card-@dorkos/a')).toBeInTheDocument();
  });

  it('renders nothing when the data array is empty', () => {
    setPackagesState({ data: [] });

    const { container } = render(<FeaturedAgentsRail />);

    expect(container.firstChild).toBeNull();
  });

  it('renders featured agents only (ignores non-featured)', () => {
    setPackagesState({
      data: [
        makeAgent('@dorkos/featured-1', true),
        makeAgent('@dorkos/not-featured', false),
        makeAgent('@dorkos/featured-2', true),
      ],
    });

    render(<FeaturedAgentsRail />);

    expect(screen.getByText('Featured Agents')).toBeInTheDocument();
    expect(screen.getByTestId('package-card-@dorkos/featured-1')).toBeInTheDocument();
    expect(screen.getByTestId('package-card-@dorkos/featured-2')).toBeInTheDocument();
    expect(screen.queryByTestId('package-card-@dorkos/not-featured')).not.toBeInTheDocument();
  });

  it('caps the rail at MAX_RAIL_ITEMS (3) even when more featured agents exist', () => {
    const agents = Array.from({ length: 10 }, (_, i) => makeAgent(`@dorkos/agent-${i}`, true));
    setPackagesState({ data: agents });

    render(<FeaturedAgentsRail />);

    const rendered = screen.getAllByTestId(/^package-card-@dorkos\/agent-/);
    expect(rendered).toHaveLength(3);
  });

  it('opens the detail drawer via the URL (openDetail) when a card is clicked', async () => {
    const user = userEvent.setup();
    setPackagesState({ data: [makeAgent('@dorkos/reviewer', true)] });

    render(<FeaturedAgentsRail />);

    await user.click(screen.getByTestId('package-card-@dorkos/reviewer'));

    expect(mockParams.openDetail).toHaveBeenCalledWith('@dorkos/reviewer');
  });

  it('opens the install confirmation dialog when the inner Install button is clicked', async () => {
    const user = userEvent.setup();
    setPackagesState({ data: [makeAgent('@dorkos/reviewer', true)] });

    render(<FeaturedAgentsRail />);

    await user.click(screen.getByText('Install'));

    const state = useMarketplaceStore.getState();
    expect(state.installConfirmPackage?.name).toBe('@dorkos/reviewer');
    // Detail drawer should NOT have been opened — the inner button stops propagation.
    expect(mockParams.openDetail).not.toHaveBeenCalled();
  });

  it('has the aria-label "Featured agents" on its section', () => {
    setPackagesState({ data: [makeAgent('@dorkos/x', true)] });

    render(<FeaturedAgentsRail />);

    expect(screen.getByRole('region', { name: /featured agents/i })).toBeInTheDocument();
  });
});
