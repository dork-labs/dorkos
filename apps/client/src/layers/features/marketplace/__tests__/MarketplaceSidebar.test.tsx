/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';
import { MarketplaceSidebar } from '../ui/MarketplaceSidebar';

// ---------------------------------------------------------------------------
// Router mock — the panel's back affordance calls useNavigate({ to: '/' }).
// useMarketplaceParams (which reads the URL) is mocked separately below, so the
// panel touches no other router API.
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

// ---------------------------------------------------------------------------
// URL params mock — drives type/categories and captures the facet setters.
// ---------------------------------------------------------------------------

const mockParams = vi.hoisted(() => ({
  type: 'all' as string,
  sort: 'featured' as string,
  search: '' as string,
  categories: [] as string[],
  selectedPackageName: null as string | null,
  setView: vi.fn(),
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
// Catalog mock — counts are derived client-side from the cached package list.
// ---------------------------------------------------------------------------

vi.mock('@/layers/entities/marketplace', () => ({
  useMarketplacePackages: vi.fn(),
}));

import { useMarketplacePackages } from '@/layers/entities/marketplace';

function setPackages(data: AggregatedPackage[] | undefined) {
  vi.mocked(useMarketplacePackages).mockReturnValue({
    data,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useMarketplacePackages>);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function pkg(overrides: Partial<AggregatedPackage> & { name: string }): AggregatedPackage {
  return {
    source: `github.com/dorkos/${overrides.name}`,
    marketplace: 'marketplace',
    ...overrides,
  };
}

// agent x2, plugin x1, skill-pack x1, untyped x1 (reads as plugin).
// Categories: security x3 (via categories[] and legacy singular),
//   code-review x1, documentation x1, productivity x1.
const CATALOG: AggregatedPackage[] = [
  pkg({ name: 'agent-a', type: 'agent', categories: ['security'] }),
  pkg({ name: 'agent-b', type: 'agent', categories: ['code-review'] }),
  pkg({ name: 'plugin-c', type: 'plugin', categories: ['security', 'documentation'] }),
  pkg({ name: 'skill-d', type: 'skill-pack', category: 'security' }),
  pkg({ name: 'untyped-e', categories: ['productivity'] }),
];

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

// A facet button's accessible name is its label concatenated with its count
// (e.g. "Agents2"), so match on the label prefix.
function typeRow(label: string): HTMLElement {
  const group = screen.getByRole('group', { name: 'Filter by type' });
  return within(group).getByRole('button', { name: new RegExp(`^${label}\\d`) });
}

function categoryRow(label: string): HTMLElement {
  const group = screen.getByRole('group', { name: 'Filter by category' });
  return within(group).getByRole('button', { name: new RegExp(`^${label}\\d`) });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MarketplaceSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParams.type = 'all';
    mockParams.categories = [];
    setPackages(CATALOG);
  });

  afterEach(cleanup);

  // -------------------------------------------------------------------------
  // Header + back affordance
  // -------------------------------------------------------------------------

  it('renders the Marketplace heading and a back affordance to the dashboard', () => {
    render(<MarketplaceSidebar />);

    expect(screen.getByRole('heading', { name: 'Marketplace' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('navigates to "/" when the back affordance is clicked', async () => {
    const user = userEvent.setup();
    render(<MarketplaceSidebar />);

    await user.click(screen.getByRole('button', { name: 'Dashboard' }));

    expect(mockNavigate).toHaveBeenCalledWith({ to: '/' });
  });

  // -------------------------------------------------------------------------
  // Type facet — single select + counts
  // -------------------------------------------------------------------------

  it('renders All + every package type with live result counts', () => {
    render(<MarketplaceSidebar />);

    expect(typeRow('All')).toHaveTextContent('5');
    // Untyped package folds into "plugin", so Plugins = 2.
    expect(typeRow('Agents')).toHaveTextContent('2');
    expect(typeRow('Plugins')).toHaveTextContent('2');
    expect(typeRow('Skill Packs')).toHaveTextContent('1');
    // Types with no packages still render, honestly showing 0.
    expect(typeRow('Adapters')).toHaveTextContent('0');
    expect(typeRow('Shapes')).toHaveTextContent('0');
  });

  it('marks the active type via aria-pressed', () => {
    mockParams.type = 'agent';
    render(<MarketplaceSidebar />);

    expect(typeRow('Agents')).toHaveAttribute('aria-pressed', 'true');
    expect(typeRow('All')).toHaveAttribute('aria-pressed', 'false');
  });

  it('writes the type filter to the URL when a type row is clicked', async () => {
    const user = userEvent.setup();
    render(<MarketplaceSidebar />);

    await user.click(typeRow('Agents'));
    expect(mockParams.setType).toHaveBeenCalledWith('agent');

    await user.click(typeRow('Skill Packs'));
    expect(mockParams.setType).toHaveBeenCalledWith('skill-pack');
  });

  it('clears the type filter when All is clicked', async () => {
    const user = userEvent.setup();
    mockParams.type = 'agent';
    render(<MarketplaceSidebar />);

    await user.click(typeRow('All'));
    expect(mockParams.setType).toHaveBeenCalledWith('all');
  });

  // -------------------------------------------------------------------------
  // Category facet — present-only, multi-select, OR-combined, counts
  // -------------------------------------------------------------------------

  it('renders only categories that have packages, in canonical order', () => {
    render(<MarketplaceSidebar />);

    const group = screen.getByRole('group', { name: 'Filter by category' });
    const labels = within(group)
      .getAllByRole('button')
      .map((b) => b.textContent?.replace(/\d+$/, '') ?? '');
    // code-review (idx 0) precedes security (idx 1) precedes documentation
    // (idx 4) precedes productivity (idx 9) in MARKETPLACE_CATEGORIES.
    expect(labels).toEqual(['Code Review', 'Security', 'Documentation', 'Productivity']);
    // A category with no packages is a dead facet — never rendered.
    expect(within(group).queryByRole('button', { name: /Marketing/ })).not.toBeInTheDocument();
  });

  it('shows a live count per category (dedup across categories[] and legacy category)', () => {
    render(<MarketplaceSidebar />);

    // security appears via categories[] on two packages plus the legacy singular
    // on one — counted once each → 3.
    expect(categoryRow('Security')).toHaveTextContent('3');
    expect(categoryRow('Code Review')).toHaveTextContent('1');
  });

  it('toggles a category through the URL (multi-select, OR-combined)', async () => {
    const user = userEvent.setup();
    render(<MarketplaceSidebar />);

    await user.click(categoryRow('Security'));
    expect(mockParams.toggleCategory).toHaveBeenCalledWith('security');

    await user.click(categoryRow('Code Review'));
    expect(mockParams.toggleCategory).toHaveBeenCalledWith('code-review');
  });

  it('marks selected categories via aria-pressed', () => {
    mockParams.categories = ['security'];
    render(<MarketplaceSidebar />);

    expect(categoryRow('Security')).toHaveAttribute('aria-pressed', 'true');
    expect(categoryRow('Code Review')).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows a Clear affordance only when at least one category is selected', async () => {
    const user = userEvent.setup();
    // No selection → no Clear button.
    const { rerender } = render(<MarketplaceSidebar />);
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();

    // With a selection → Clear appears and clears all categories.
    mockParams.categories = ['security', 'code-review'];
    rerender(<MarketplaceSidebar />);
    const clear = screen.getByRole('button', { name: 'Clear' });
    await user.click(clear);
    expect(mockParams.clearCategories).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Empty catalog
  // -------------------------------------------------------------------------

  it('renders the type rows with zero counts and no category group when the catalog is empty', () => {
    setPackages([]);
    render(<MarketplaceSidebar />);

    expect(typeRow('All')).toHaveTextContent('0');
    // No present categories → the whole category group is omitted (no dead facets).
    expect(screen.queryByRole('group', { name: 'Filter by category' })).not.toBeInTheDocument();
  });
});
