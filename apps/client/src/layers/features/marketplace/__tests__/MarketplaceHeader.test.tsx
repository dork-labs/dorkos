/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MarketplaceHeader } from '../ui/MarketplaceHeader';

// ---------------------------------------------------------------------------
// URL params mock
//
// MarketplaceHeader reads/writes browse state through `useMarketplaceParams`
// (URL-backed). Mock the hook so tests can drive the committed values and
// assert the setters that write to the URL.
// ---------------------------------------------------------------------------

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
// Tests
// ---------------------------------------------------------------------------

describe('MarketplaceHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParams.type = 'all';
    mockParams.sort = 'featured';
    mockParams.search = '';
    mockParams.category = null;
    mockParams.selectedPackageName = null;
  });

  afterEach(() => {
    cleanup();
    // Always restore real timers in case a test installed fake timers.
    vi.useRealTimers();
  });

  it('renders all five type filter tabs', () => {
    render(<MarketplaceHeader />);

    expect(screen.getByRole('tab', { name: 'All' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Agents' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Plugins' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Skill Packs' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Adapters' })).toBeInTheDocument();
  });

  it('renders the search input with an accessible label and the marketplace-search test id', () => {
    render(<MarketplaceHeader />);

    // The search input is labeled by a visually-hidden <Label htmlFor="marketplace-search">.
    const searchInput = screen.getByLabelText('Search packages');
    expect(searchInput).toBeInTheDocument();
    expect(searchInput).toHaveAttribute('id', 'marketplace-search');
    expect(screen.getByTestId('marketplace-search')).toBe(searchInput);
  });

  it('marks the active type tab based on the URL filter', () => {
    mockParams.type = 'agent';
    render(<MarketplaceHeader />);

    expect(screen.getByRole('tab', { name: 'Agents' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('data-state', 'inactive');
  });

  it('clicking a type tab writes the filter to the URL via setType', async () => {
    const user = userEvent.setup();
    render(<MarketplaceHeader />);

    await user.click(screen.getByRole('tab', { name: 'Plugins' }));

    expect(mockParams.setType).toHaveBeenCalledWith('plugin');
  });

  it('clicking the Skill Packs tab maps to the "skill-pack" filter value', async () => {
    const user = userEvent.setup();
    render(<MarketplaceHeader />);

    await user.click(screen.getByRole('tab', { name: 'Skill Packs' }));

    expect(mockParams.setType).toHaveBeenCalledWith('skill-pack');
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
  // Category facet chips
  // -------------------------------------------------------------------------

  it('renders no category chip row when no categories are present', () => {
    // Present-only policy: with an empty/omitted set there are no live facets.
    render(<MarketplaceHeader />);
    expect(screen.queryByRole('group', { name: 'Filter by category' })).not.toBeInTheDocument();
  });

  it('renders a facet chip only for present categories, plus an "All" chip', () => {
    render(<MarketplaceHeader presentCategories={new Set(['security', 'code-review'])} />);

    const group = screen.getByRole('group', { name: 'Filter by category' });
    expect(group).toBeInTheDocument();
    // Labels come from CATEGORY_LABELS.
    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Security' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Code Review' })).toBeInTheDocument();
    // A category with no present packages gets no chip (no dead facet).
    expect(screen.queryByRole('button', { name: 'Marketing' })).not.toBeInTheDocument();
  });

  it('renders chips in the canonical vocabulary order, not insertion order', () => {
    // 'security' precedes 'code-review' in the set but code-review is earlier
    // in MARKETPLACE_CATEGORIES, so it renders first.
    render(<MarketplaceHeader presentCategories={new Set(['security', 'code-review'])} />);

    const labels = screen
      .getAllByRole('button')
      .map((b) => b.textContent)
      .filter((t) => t === 'Security' || t === 'Code Review');
    expect(labels).toEqual(['Code Review', 'Security']);
  });

  it('clicking a category chip writes the slug to the URL via setCategory', async () => {
    const user = userEvent.setup();
    render(<MarketplaceHeader presentCategories={new Set(['security'])} />);

    await user.click(screen.getByRole('button', { name: 'Security' }));

    expect(mockParams.setCategory).toHaveBeenCalledWith('security');
  });

  it('marks the active category chip with aria-pressed', () => {
    mockParams.category = 'security';
    render(<MarketplaceHeader presentCategories={new Set(['security', 'code-review'])} />);

    expect(screen.getByRole('button', { name: 'Security' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Code Review' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('clicking the active category chip clears the filter (toggle off)', async () => {
    mockParams.category = 'security';
    const user = userEvent.setup();
    render(<MarketplaceHeader presentCategories={new Set(['security'])} />);

    await user.click(screen.getByRole('button', { name: 'Security' }));

    expect(mockParams.setCategory).toHaveBeenCalledWith(null);
  });

  it('clicking the "All" chip clears the category filter', async () => {
    mockParams.category = 'security';
    const user = userEvent.setup();
    render(<MarketplaceHeader presentCategories={new Set(['security'])} />);

    await user.click(screen.getByRole('button', { name: 'All' }));

    expect(mockParams.setCategory).toHaveBeenCalledWith(null);
  });
});
