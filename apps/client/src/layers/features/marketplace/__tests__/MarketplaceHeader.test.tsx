/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';
import { useMarketplacePackages } from '@/layers/entities/marketplace';
import { MarketplaceHeader } from '../ui/MarketplaceHeader';

// ---------------------------------------------------------------------------
// Marketplace packages mock
//
// The header reads the package catalog to decide whether the Popular sort has
// backing install-count data (offline-first: it grays out when counts are
// unavailable). Mock the entity hook so tests control that signal without a
// Transport/QueryClient.
// ---------------------------------------------------------------------------

vi.mock('@/layers/entities/marketplace', () => ({
  useMarketplacePackages: vi.fn(),
}));

function pkg(overrides: Partial<AggregatedPackage> & { name: string }): AggregatedPackage {
  return {
    source: 'https://github.com/example/pkg',
    marketplace: 'dorkos-community',
    ...overrides,
  };
}

/** Point the mocked hook at a fixed package list (only `data` is read). */
function mockPackages(packages: AggregatedPackage[]): void {
  vi.mocked(useMarketplacePackages).mockReturnValue({
    data: packages,
  } as ReturnType<typeof useMarketplacePackages>);
}

// ---------------------------------------------------------------------------
// URL params mock
//
// MarketplaceHeader reads/writes browse state through `useMarketplaceParams`
// (URL-backed). Mock the hook so tests can drive the committed values and
// assert the setters that write to the URL. The type + category filter facets
// moved to the sidebar takeover panel (see MarketplaceSidebar.test.tsx); this
// header is now just the search field and the sort selector.
// ---------------------------------------------------------------------------

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

  // Radix Select needs these DOM APIs jsdom doesn't implement to open its
  // listbox under userEvent (same shim used by MarketplaceSourcesView.test).
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = vi.fn();
  if (!proto.releasePointerCapture) proto.releasePointerCapture = vi.fn();
  if (!proto.scrollIntoView) proto.scrollIntoView = vi.fn();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MarketplaceHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParams.type = 'all';
    mockParams.sort = 'featured';
    mockParams.search = '';
    mockParams.categories = [];
    mockParams.selectedPackageName = null;
    // Default: counts unavailable (offline) unless a test opts in.
    mockPackages([]);
  });

  afterEach(() => {
    cleanup();
    // Always restore real timers in case a test installed fake timers.
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  it('renders the search input with an accessible label and the marketplace-search test id', () => {
    render(<MarketplaceHeader />);

    // The search input is labeled by a visually-hidden <Label htmlFor="marketplace-search">.
    const searchInput = screen.getByLabelText('Search packages');
    expect(searchInput).toBeInTheDocument();
    expect(searchInput).toHaveAttribute('id', 'marketplace-search');
    expect(screen.getByTestId('marketplace-search')).toBe(searchInput);
  });

  it('seeds the input from the committed URL search on mount', () => {
    mockParams.search = 'reviewer';
    render(<MarketplaceHeader />);

    expect((screen.getByTestId('marketplace-search') as HTMLInputElement).value).toBe('reviewer');
  });

  it('debounces search input by 300ms before committing to the URL', () => {
    vi.useFakeTimers();
    render(<MarketplaceHeader />);

    const searchInput = screen.getByTestId('marketplace-search') as HTMLInputElement;

    // Local input updates immediately, but the URL should not yet be written.
    // Use fireEvent (synchronous) so we don't mix userEvent promises with fake timers.
    fireEvent.change(searchInput, { target: { value: 'reviewer' } });
    expect(searchInput.value).toBe('reviewer');
    expect(mockParams.setSearch).not.toHaveBeenCalled();

    // Advance just under the debounce window — still not committed.
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(mockParams.setSearch).not.toHaveBeenCalled();

    // Cross the debounce threshold — the URL setter now fires.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(mockParams.setSearch).toHaveBeenCalledWith('reviewer');
  });

  it('cancels a pending debounce when the user keeps typing', () => {
    vi.useFakeTimers();
    render(<MarketplaceHeader />);

    const searchInput = screen.getByTestId('marketplace-search') as HTMLInputElement;

    fireEvent.change(searchInput, { target: { value: 'rev' } });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    // Still well under the debounce window — keep typing.
    fireEvent.change(searchInput, { target: { value: 'reviewer' } });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    // Total elapsed = 400ms, but only 200ms since the last keystroke.
    expect(mockParams.setSearch).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(100);
    });
    // 300ms since the last keystroke — a single committed write with the final value.
    expect(mockParams.setSearch).toHaveBeenCalledTimes(1);
    expect(mockParams.setSearch).toHaveBeenCalledWith('reviewer');
  });

  // -------------------------------------------------------------------------
  // Sort
  // -------------------------------------------------------------------------

  it('renders the sort selector reflecting the active sort from the URL', () => {
    render(<MarketplaceHeader />);

    const sort = screen.getByRole('combobox', { name: 'Sort packages' });
    expect(sort).toBeInTheDocument();
    // The trigger shows the label of the committed sort (default: Featured).
    expect(sort).toHaveTextContent('Featured');
  });

  it('reflects the "name" sort as the A–Z label', () => {
    mockParams.sort = 'name';
    render(<MarketplaceHeader />);

    expect(screen.getByRole('combobox', { name: 'Sort packages' })).toHaveTextContent('A–Z');
  });

  it('offers the Popular sort as selectable when packages carry install counts', async () => {
    const user = userEvent.setup();
    mockPackages([pkg({ name: 'code-reviewer', installCount: 42 }), pkg({ name: 'flow' })]);
    render(<MarketplaceHeader />);

    await user.click(screen.getByRole('combobox', { name: 'Sort packages' }));

    const listbox = await screen.findByRole('listbox');
    const popular = within(listbox).getByRole('option', { name: 'Popular' });
    expect(popular).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('grays out the Popular sort when no package carries an install count (offline)', async () => {
    const user = userEvent.setup();
    mockPackages([pkg({ name: 'code-reviewer' }), pkg({ name: 'flow' })]);
    render(<MarketplaceHeader />);

    await user.click(screen.getByRole('combobox', { name: 'Sort packages' }));

    const listbox = await screen.findByRole('listbox');
    const popular = within(listbox).getByRole('option', { name: 'Popular' });
    expect(popular).toHaveAttribute('aria-disabled', 'true');
  });

  // -------------------------------------------------------------------------
  // The filter facets moved to the sidebar — they must NOT appear here anymore.
  // -------------------------------------------------------------------------

  it('no longer renders the type filter tabs (moved to the sidebar facet panel)', () => {
    render(<MarketplaceHeader />);

    expect(screen.queryByRole('tab', { name: 'All' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Agents' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('no longer renders the category facet chips (moved to the sidebar facet panel)', () => {
    render(<MarketplaceHeader />);

    expect(screen.queryByRole('group', { name: 'Filter by category' })).not.toBeInTheDocument();
    expect(screen.queryByText('Category')).not.toBeInTheDocument();
  });
});
