/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ActivityFilterBar } from '../ui/ActivityFilterBar';
import type { UseActivityFiltersReturn } from '../model/use-activity-filters';

const toggleCategory = vi.fn();
const clearAll = vi.fn();

let mockReturn: UseActivityFiltersReturn;

vi.mock('../model/use-activity-filters', () => ({
  useActivityFilters: () => mockReturn,
}));

function makeFilters(overrides: Partial<UseActivityFiltersReturn> = {}): UseActivityFiltersReturn {
  return {
    filters: { categories: undefined, actorType: undefined, actorId: undefined, since: undefined },
    queryFilters: {},
    isFiltered: false,
    toggleCategory,
    setActorType: vi.fn(),
    setActorId: vi.fn(),
    setSince: vi.fn(),
    clearAll,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ActivityFilterBar', () => {
  it('renders the "All" chip plus one chip per category', () => {
    mockReturn = makeFilters();
    render(<ActivityFilterBar />);

    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument();
    for (const label of ['Schedules', 'Relay', 'Agent', 'Config', 'System']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('toggles a category when its chip is clicked', () => {
    mockReturn = makeFilters();
    render(<ActivityFilterBar />);

    fireEvent.click(screen.getByRole('button', { name: 'Relay' }));
    expect(toggleCategory).toHaveBeenCalledWith('relay');
  });

  it('marks the active category chip pressed, and "All" pressed when nothing is filtered', () => {
    mockReturn = makeFilters();
    render(<ActivityFilterBar />);
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Relay' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('clears all filters when "All" is clicked while filtered', () => {
    mockReturn = makeFilters({ isFiltered: true, filters: { categories: 'relay' } as never });
    render(<ActivityFilterBar />);

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(clearAll).toHaveBeenCalled();
  });

  // DOR-1753: at 24px (`h-6`) inside a scrollable strip these were harder to
  // land a thumb on than a desktop-density button — see CHIP_HIT_AREA.
  it('grows every chip to a real touch target below md, without growing the visible pill', () => {
    mockReturn = makeFilters();
    render(<ActivityFilterBar />);

    const all = screen.getByRole('button', { name: 'All' });
    expect(all.className).toContain('min-h-11');
    expect(all.className).toContain('md:min-h-0');

    // The visible pill (the button's own child) stays the original 24px —
    // only the invisible, clickable wrapper around it grew.
    const pill = all.querySelector('span');
    expect(pill).not.toBeNull();
    expect(pill!.className).toContain('h-6');
    expect(pill!.className).not.toContain('min-h-11');
  });
});
