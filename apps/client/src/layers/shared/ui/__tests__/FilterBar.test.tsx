// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { FilterBar } from '../filter-bar';

// ── Mock useIsMobile ──────────────────────────────────────────

const mockUseIsMobile = vi.fn(() => false);
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useIsMobile: () => mockUseIsMobile() };
});

// ── matchMedia mock ───────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────

function createMockFilterState(overrides: Record<string, unknown> = {}) {
  return {
    values: { search: '', status: [] as string[] },
    inputValues: { search: '', status: [] as string[] },
    sortField: 'name',
    sortDirection: 'asc' as const,
    isFiltered: false,
    activeCount: 0,
    set: vi.fn(),
    clear: vi.fn(),
    clearAll: vi.fn(),
    setSort: vi.fn(),
    describeActive: vi.fn(() => ''),
    schema: {
      definitions: {
        search: {
          type: 'text' as const,
          defaultValue: '',
          isActive: (v: unknown) => typeof v === 'string' && v.trim().length > 0,
          match: () => true,
          serialize: (v: unknown) => String(v),
          deserialize: (r: string) => r ?? '',
        },
        status: {
          type: 'enum' as const,
          options: ['active', 'inactive'],
          multi: true,
          labels: { active: 'Active', inactive: 'Inactive' },
          defaultValue: [] as string[],
          isActive: (v: unknown) => Array.isArray(v) && v.length > 0,
          match: () => true,
          serialize: (v: unknown) => (v as string[]).join(','),
          deserialize: (r: string) => (r ? r.split(',') : []),
        },
      },
      defaultValues: { search: '', status: [] },
      applyFilters: <T,>(items: T[]) => items,
      isFiltered: () => false,
      activeCount: () => 0,
      describeActive: () => '',
      searchValidator: {} as never,
    },
    ...overrides,
  } as never;
}

const SORT_OPTIONS = {
  name: { label: 'Name' },
  lastSeen: { label: 'Last seen' },
};

// ── Tests ─────────────────────────────────────────────────────

describe('FilterBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseIsMobile.mockReturnValue(false);
  });

  afterEach(cleanup);

  it('renders search input with placeholder', () => {
    const state = createMockFilterState();
    render(
      <FilterBar state={state}>
        <FilterBar.Search placeholder="Filter agents..." />
      </FilterBar>
    );

    expect(screen.getByPlaceholderText('Filter agents...')).toBeInTheDocument();
  });

  it('renders unfiltered result count', () => {
    const state = createMockFilterState();
    render(
      <FilterBar state={state}>
        <FilterBar.ResultCount count={12} total={12} noun="agent" />
      </FilterBar>
    );

    expect(screen.getByText('12 agents')).toBeInTheDocument();
  });

  it('renders filtered result count with "Clear all"', () => {
    const state = createMockFilterState({ isFiltered: true });
    render(
      <FilterBar state={state}>
        <FilterBar.ResultCount count={4} total={12} noun="agent" />
      </FilterBar>
    );

    expect(screen.getByText('4 of 12 agents')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /clear all/i })).toBeInTheDocument();
  });

  it('renders sort dropdown with current field and direction', () => {
    const state = createMockFilterState();
    render(
      <FilterBar state={state}>
        <FilterBar.Sort options={SORT_OPTIONS} />
      </FilterBar>
    );

    const trigger = screen.getByText(/Sort: Name/);
    expect(trigger).toBeInTheDocument();
  });

  it('sort dropdown falls back to defaultField when no sort is set', () => {
    const state = createMockFilterState({ sortField: '' });
    render(
      <FilterBar state={state}>
        <FilterBar.Sort options={SORT_OPTIONS} defaultField="name" />
      </FilterBar>
    );

    expect(screen.getByText(/Sort: Name/)).toBeInTheDocument();
  });

  it('direction toggle acts on defaultField when no sort is set', async () => {
    const state = createMockFilterState({ sortField: '' });
    const user = userEvent.setup();

    render(
      <FilterBar state={state}>
        <FilterBar.Sort options={SORT_OPTIONS} defaultField="name" />
      </FilterBar>
    );

    await user.click(screen.getByRole('button', { name: /sort descending/i }));

    expect(
      (state as unknown as { setSort: ReturnType<typeof vi.fn> }).setSort
    ).toHaveBeenCalledWith('name', 'desc');
  });

  // DOR-1753: FilterBar backs /tasks, /team and /activity, real mobile
  // routes, so its search box gets a real touch target below `md` instead
  // of the flat desktop `h-8` it used to force everywhere.
  it('grows the search box to a touch target below md, desktop density unchanged', () => {
    const state = createMockFilterState();
    render(
      <FilterBar state={state}>
        <FilterBar.Search placeholder="Search..." />
      </FilterBar>
    );

    const input = screen.getByPlaceholderText('Search...');
    expect(input.className).toContain('md:h-8');
    // The bare (unprefixed) h-8 that used to win at every width is gone —
    // it would otherwise beat the default `h-11` below `md` too.
    expect(input.className.split(' ')).not.toContain('h-8');
  });

  it('search onChange calls filterState.set', async () => {
    const state = createMockFilterState();
    const user = userEvent.setup();

    render(
      <FilterBar state={state}>
        <FilterBar.Search placeholder="Search..." />
      </FilterBar>
    );

    const input = screen.getByPlaceholderText('Search...');
    await user.type(input, 'hello');

    expect((state as unknown as { set: ReturnType<typeof vi.fn> }).set).toHaveBeenCalledWith(
      'search',
      expect.any(String)
    );
  });

  it('ActiveFilters shows chips on desktop when filtered', () => {
    const state = createMockFilterState({
      isFiltered: true,
      activeCount: 1,
      values: { search: '', status: ['active'] },
    });
    mockUseIsMobile.mockReturnValue(false);

    render(
      <FilterBar state={state}>
        <FilterBar.ActiveFilters />
      </FilterBar>
    );

    expect(screen.getByText(/status/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/remove status filter/i)).toBeInTheDocument();
  });

  it('ActiveFilters shows badge on mobile when filtered', () => {
    const state = createMockFilterState({
      isFiltered: true,
      activeCount: 2,
      values: { search: 'test', status: ['active'] },
    });
    mockUseIsMobile.mockReturnValue(true);

    render(
      <FilterBar state={state}>
        <FilterBar.ActiveFilters />
      </FilterBar>
    );

    // Mobile shows a badge with the count
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('pluralizes noun correctly for singular count', () => {
    const state = createMockFilterState();
    render(
      <FilterBar state={state}>
        <FilterBar.ResultCount count={1} total={1} noun="agent" />
      </FilterBar>
    );

    expect(screen.getByText('1 agent')).toBeInTheDocument();
  });
});
