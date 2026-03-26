/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock TanStack Router hooks
const mockNavigate = vi.fn();
const mockSearch: Record<string, string> = {};
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => mockSearch,
  useNavigate: () => mockNavigate,
  useRouter: () => ({}),
}));

import { useFilterState } from '../use-filter-state';
import { createFilterSchema, textFilter, enumFilter } from '../../lib/filter-engine';

interface TestItem {
  name: string;
  status: string;
}

const schema = createFilterSchema<TestItem>({
  search: textFilter({ fields: [(a) => a.name] }),
  status: enumFilter({
    field: (a) => a.status,
    options: ['active', 'inactive'],
    multi: true,
  }),
});

describe('useFilterState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockSearch).forEach((k) => delete mockSearch[k]);
  });

  it('returns default values when URL has no params', () => {
    const { result } = renderHook(() => useFilterState(schema));
    expect(result.current.values.search).toBe('');
    expect(result.current.values.status).toEqual([]);
    expect(result.current.isFiltered).toBe(false);
    expect(result.current.activeCount).toBe(0);
  });

  it('reads initial state from URL search params', () => {
    mockSearch.search = 'deploy';
    mockSearch.status = 'active,inactive';
    const { result } = renderHook(() => useFilterState(schema));
    expect(result.current.values.search).toBe('deploy');
    expect(result.current.values.status).toEqual(['active', 'inactive']);
    expect(result.current.isFiltered).toBe(true);
    expect(result.current.activeCount).toBe(2);
  });

  it('updates URL when set() is called', () => {
    const { result } = renderHook(() => useFilterState(schema));
    act(() => result.current.set('status', ['active']));
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: expect.any(Function) })
    );
  });

  it('clearAll resets all filters but preserves sibling route params', () => {
    mockSearch.search = 'deploy';
    mockSearch.status = 'active';
    mockSearch.view = 'topology';
    const { result } = renderHook(() => useFilterState(schema));
    act(() => result.current.clearAll());
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: expect.any(Function) })
    );
    const searchUpdater = mockNavigate.mock.calls[0][0].search;
    const newSearch = searchUpdater({
      view: 'topology',
      search: 'deploy',
      status: 'active',
    });
    expect(newSearch.view).toBe('topology');
    expect(newSearch.search).toBeUndefined();
    expect(newSearch.status).toBeUndefined();
  });

  it('describeActive returns human-readable summary', () => {
    mockSearch.search = 'deploy';
    mockSearch.status = 'active';
    const { result } = renderHook(() => useFilterState(schema));
    expect(result.current.describeActive()).toContain('deploy');
  });

  it('provides sort state from URL', () => {
    mockSearch.sort = 'name:desc';
    const { result } = renderHook(() => useFilterState(schema));
    expect(result.current.sortField).toBe('name');
    expect(result.current.sortDirection).toBe('desc');
  });

  it('defaults sort direction to asc', () => {
    const { result } = renderHook(() => useFilterState(schema));
    expect(result.current.sortDirection).toBe('asc');
  });

  it('exposes schema for UI components', () => {
    const { result } = renderHook(() => useFilterState(schema));
    expect(result.current.schema.definitions).toBeDefined();
  });
});
