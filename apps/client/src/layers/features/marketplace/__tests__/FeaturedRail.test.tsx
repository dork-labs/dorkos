/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AggregatedPackage, MarketplacePackageType } from '@dorkos/shared/marketplace-schemas';
import { useMarketplacePackages } from '@/layers/entities/marketplace';

import { FeaturedRail } from '../ui/FeaturedRail';
import { useMarketplaceStore } from '../model/marketplace-store';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/layers/entities/marketplace', () => ({
  useMarketplacePackages: vi.fn(),
}));

// The rail hides itself when any browse filter (search, type, or category) is
// active and opens the drawer through `useMarketplaceParams` (URL-backed).
// Install-confirm stays on the store.
const mockParams = vi.hoisted(() => ({
  type: 'all' as string,
  sort: 'featured' as string,
  search: '' as string,
  categories: [] as string[],
  selectedPackageName: null as string | null,
  setType: vi.fn(),
  setSort: vi.fn(),
  setSearch: vi.fn(),
  toggleCategory: vi.fn(),
  setCategories: vi.fn(),
  clearCategories: vi.fn(),
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

function makePkg(
  name: string,
  { featured = true, type = 'agent' as MarketplacePackageType } = {}
): AggregatedPackage {
  return {
    name,
    source: `github.com/dorkos/${name}`,
    description: `Package ${name}`,
    version: '1.0.0',
    type,
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

describe('FeaturedRail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    mockParams.type = 'all';
    mockParams.search = '';
    mockParams.categories = [];
  });

  afterEach(cleanup);

  it('renders the loading skeleton while the packages query is pending', () => {
    setPackagesState({ isLoading: true });

    render(<FeaturedRail />);

    // Heading is present, and the skeletons are rendered (aria-busy via Skeleton primitive is
    // implementation-specific — assert on the heading + the fact that no PackageCard test IDs exist).
    expect(screen.getByText('Featured')).toBeInTheDocument();
    expect(screen.queryByTestId(/^package-card-/)).not.toBeInTheDocument();
  });

  it('renders nothing when there are zero featured packages', () => {
    setPackagesState({
      data: [makePkg('@dorkos/a', { featured: false }), makePkg('@dorkos/b', { featured: false })],
    });

    const { container } = render(<FeaturedRail />);

    // No featured packages → no fallback rail, nothing rendered.
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the data array is empty', () => {
    setPackagesState({ data: [] });

    const { container } = render(<FeaturedRail />);

    expect(container.firstChild).toBeNull();
  });

  it('renders featured packages only (ignores non-featured)', () => {
    setPackagesState({
      data: [
        makePkg('@dorkos/featured-1', { featured: true }),
        makePkg('@dorkos/not-featured', { featured: false }),
        makePkg('@dorkos/featured-2', { featured: true }),
      ],
    });

    render(<FeaturedRail />);

    expect(screen.getByText('Featured')).toBeInTheDocument();
    expect(screen.getByTestId('package-card-@dorkos/featured-1')).toBeInTheDocument();
    expect(screen.getByTestId('package-card-@dorkos/featured-2')).toBeInTheDocument();
    expect(screen.queryByTestId('package-card-@dorkos/not-featured')).not.toBeInTheDocument();
  });

  it('renders a human package name, preferring displayName and humanizing a bare slug', () => {
    setPackagesState({
      data: [
        { ...makePkg('security-scanner', { featured: true }), displayName: 'Security Scanner' },
        makePkg('log-analyzer', { featured: true }),
      ],
    });

    render(<FeaturedRail />);

    // displayName wins when the author supplies one…
    expect(screen.getByText('Security Scanner')).toBeInTheDocument();
    // …and a slug-only package is humanized, never shown as raw kebab-case.
    expect(screen.getByText('Log Analyzer')).toBeInTheDocument();
    expect(screen.queryByText('log-analyzer')).not.toBeInTheDocument();
  });

  it('features packages of any type, not only agents', () => {
    setPackagesState({
      data: [
        makePkg('@dorkos/an-agent', { type: 'agent' }),
        makePkg('@dorkos/a-plugin', { type: 'plugin' }),
        makePkg('@dorkos/a-shape', { type: 'shape' }),
      ],
    });

    render(<FeaturedRail />);

    expect(screen.getByTestId('package-card-@dorkos/an-agent')).toBeInTheDocument();
    expect(screen.getByTestId('package-card-@dorkos/a-plugin')).toBeInTheDocument();
    expect(screen.getByTestId('package-card-@dorkos/a-shape')).toBeInTheDocument();
  });

  it('caps the rail at MAX_RAIL_ITEMS (3) even when more featured packages exist', () => {
    const pkgs = Array.from({ length: 10 }, (_, i) =>
      makePkg(`@dorkos/pkg-${i}`, { featured: true })
    );
    setPackagesState({ data: pkgs });

    render(<FeaturedRail />);

    const rendered = screen.getAllByTestId(/^package-card-@dorkos\/pkg-/);
    expect(rendered).toHaveLength(3);
  });

  it('hides the rail when a search term is active', () => {
    setPackagesState({ data: [makePkg('@dorkos/featured', { featured: true })] });
    mockParams.search = 'anything';

    const { container } = render(<FeaturedRail />);

    expect(container.firstChild).toBeNull();
  });

  it('hides the rail when a type filter is active', () => {
    setPackagesState({ data: [makePkg('@dorkos/featured', { featured: true })] });
    mockParams.type = 'agent';

    const { container } = render(<FeaturedRail />);

    expect(container.firstChild).toBeNull();
  });

  it('hides the rail when a category filter is active', () => {
    setPackagesState({ data: [makePkg('@dorkos/featured', { featured: true })] });
    mockParams.categories = ['devops'];

    const { container } = render(<FeaturedRail />);

    expect(container.firstChild).toBeNull();
  });

  it('opens the detail drawer via the URL (openDetail) when a card is clicked', async () => {
    const user = userEvent.setup();
    setPackagesState({ data: [makePkg('@dorkos/reviewer', { featured: true })] });

    render(<FeaturedRail />);

    await user.click(screen.getByTestId('package-card-@dorkos/reviewer'));

    expect(mockParams.openDetail).toHaveBeenCalledWith('@dorkos/reviewer');
  });

  it('opens the install confirmation dialog when the inner Install button is clicked', async () => {
    const user = userEvent.setup();
    // A non-agent package uses the permission-preview confirm dialog. Agent
    // packages leave for the creation flow (covered in use-request-install).
    setPackagesState({ data: [makePkg('@dorkos/reviewer', { featured: true, type: 'plugin' })] });

    render(<FeaturedRail />);

    await user.click(screen.getByText('Install'));

    const state = useMarketplaceStore.getState();
    expect(state.installConfirmPackage?.name).toBe('@dorkos/reviewer');
    // Detail drawer should NOT have been opened — the inner button stops propagation.
    expect(mockParams.openDetail).not.toHaveBeenCalled();
  });

  it('exposes an accessible "Featured" region', () => {
    setPackagesState({ data: [makePkg('@dorkos/x', { featured: true })] });

    render(<FeaturedRail />);

    expect(screen.getByRole('region', { name: /^featured$/i })).toBeInTheDocument();
  });
});
