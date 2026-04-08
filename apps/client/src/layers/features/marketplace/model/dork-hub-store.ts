/**
 * Dork Hub UI state store — filters, package detail sheet, and install confirmation dialog.
 *
 * This store owns all *client-only* ephemeral state for the Dork Hub browse experience.
 * Server state (package lists, install results) lives in TanStack Query via
 * `entities/marketplace`.
 *
 * @module features/marketplace/model/dork-hub-store
 */
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { AggregatedPackage, MarketplacePackageType } from '@dorkos/shared/marketplace-schemas';

// ---------------------------------------------------------------------------
// Filter types
// ---------------------------------------------------------------------------

/**
 * Type filter for the Dork Hub browse grid.
 *
 * `'all'` disables type filtering; the rest correspond directly to
 * `MarketplacePackageType` values so the filter stays in sync with the schema.
 */
export type DorkHubTypeFilter = 'all' | MarketplacePackageType;

/** Sort order for the Dork Hub browse grid. */
export type DorkHubSort = 'featured' | 'popular' | 'recent' | 'name';

// ---------------------------------------------------------------------------
// State and action interfaces
// ---------------------------------------------------------------------------

/** Active filter values for the Dork Hub browse grid. */
export interface DorkHubFilters {
  /** Package type filter — `'all'` returns every type. */
  type: DorkHubTypeFilter;
  /** Category slug filter, or `null` for no category restriction. */
  category: string | null;
  /** Free-text search string applied across name, description, and tags. */
  search: string;
  /** Sort order for the result grid. */
  sort: DorkHubSort;
}

/** State slice of the Dork Hub store. */
export interface DorkHubState {
  /** Active filter set for the browse grid. */
  filters: DorkHubFilters;
  /** Currently-open package in the detail sheet (`null` = sheet closed). */
  detailPackage: AggregatedPackage | null;
  /** Package pending the install confirmation dialog (`null` = dialog closed). */
  installConfirmPackage: AggregatedPackage | null;
}

/** Actions exposed by the Dork Hub store. */
export interface DorkHubActions {
  /** Set the package type filter. */
  setTypeFilter: (type: DorkHubTypeFilter) => void;
  /** Set the category filter. Pass `null` to clear. */
  setCategoryFilter: (category: string | null) => void;
  /** Set the free-text search string. */
  setSearch: (search: string) => void;
  /** Set the sort order. */
  setSort: (sort: DorkHubSort) => void;
  /** Reset all filters to their defaults. */
  resetFilters: () => void;

  /** Open the detail sheet for a given package. */
  openDetail: (pkg: AggregatedPackage) => void;
  /** Close the detail sheet. */
  closeDetail: () => void;

  /** Open the install confirmation dialog for a given package. */
  openInstallConfirm: (pkg: AggregatedPackage) => void;
  /** Close the install confirmation dialog. */
  closeInstallConfirm: () => void;
}

// ---------------------------------------------------------------------------
// Initial values
// ---------------------------------------------------------------------------

const INITIAL_FILTERS: DorkHubFilters = {
  type: 'all',
  category: null,
  search: '',
  sort: 'featured',
};

const INITIAL_STATE: DorkHubState = {
  filters: INITIAL_FILTERS,
  detailPackage: null,
  installConfirmPackage: null,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Zustand store for Dork Hub UI state.
 *
 * Manages filter state for the browse grid, which package is open in the
 * detail sheet, and which package is pending install confirmation. Server
 * state (package data, install results) is owned by TanStack Query.
 */
export const useDorkHubStore = create<DorkHubState & DorkHubActions>()(
  devtools(
    (set) => ({
      ...INITIAL_STATE,

      setTypeFilter: (type) =>
        set((s) => ({ filters: { ...s.filters, type } }), false, 'dorkHub/setTypeFilter'),

      setCategoryFilter: (category) =>
        set((s) => ({ filters: { ...s.filters, category } }), false, 'dorkHub/setCategoryFilter'),

      setSearch: (search) =>
        set((s) => ({ filters: { ...s.filters, search } }), false, 'dorkHub/setSearch'),

      setSort: (sort) =>
        set((s) => ({ filters: { ...s.filters, sort } }), false, 'dorkHub/setSort'),

      resetFilters: () => set({ filters: INITIAL_FILTERS }, false, 'dorkHub/resetFilters'),

      openDetail: (pkg) => set({ detailPackage: pkg }, false, 'dorkHub/openDetail'),

      closeDetail: () => set({ detailPackage: null }, false, 'dorkHub/closeDetail'),

      openInstallConfirm: (pkg) =>
        set({ installConfirmPackage: pkg }, false, 'dorkHub/openInstallConfirm'),

      closeInstallConfirm: () =>
        set({ installConfirmPackage: null }, false, 'dorkHub/closeInstallConfirm'),
    }),
    { name: 'DorkHubStore' }
  )
);
