/**
 * Marketplace UI state store — filters, package detail sheet, and install confirmation dialog.
 *
 * This store owns all *client-only* ephemeral state for the Marketplace browse experience.
 * Server state (package lists, install results) lives in TanStack Query via
 * `entities/marketplace`.
 *
 * @module features/marketplace/model/marketplace-store
 */
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { AggregatedPackage, MarketplacePackageType } from '@dorkos/shared/marketplace-schemas';

// ---------------------------------------------------------------------------
// Filter types
// ---------------------------------------------------------------------------

/**
 * Type filter for the Marketplace browse grid.
 *
 * `'all'` disables type filtering; the rest correspond directly to
 * `MarketplacePackageType` values so the filter stays in sync with the schema.
 */
export type MarketplaceTypeFilter = 'all' | MarketplacePackageType;

/** Sort order for the Marketplace browse grid. */
export type MarketplaceSort = 'featured' | 'popular' | 'recent' | 'name';

// ---------------------------------------------------------------------------
// Install context
// ---------------------------------------------------------------------------

/** Context for scoped installs — identifies which agent triggered the install. */
export interface InstallContext {
  /** Agent's project path (used as projectPath for agent-local installs). */
  agentPath: string;
  /** Agent display name (shown in the scope selector). */
  agentName: string;
}

// ---------------------------------------------------------------------------
// State and action interfaces
// ---------------------------------------------------------------------------

/** Active filter values for the Marketplace browse grid. */
export interface MarketplaceFilters {
  /** Package type filter — `'all'` returns every type. */
  type: MarketplaceTypeFilter;
  /** Category slug filter, or `null` for no category restriction. */
  category: string | null;
  /** Free-text search string applied across name, description, and tags. */
  search: string;
  /** Sort order for the result grid. */
  sort: MarketplaceSort;
}

/** State slice of the Marketplace store. */
export interface MarketplaceState {
  /** Active filter set for the browse grid. */
  filters: MarketplaceFilters;
  /** Currently-open package in the detail sheet (`null` = sheet closed). */
  detailPackage: AggregatedPackage | null;
  /** Package pending the install confirmation dialog (`null` = dialog closed). */
  installConfirmPackage: AggregatedPackage | null;
  /** Context of the agent that triggered the install (null = marketplace browse). */
  installContext: InstallContext | null;
}

/** Actions exposed by the Marketplace store. */
export interface MarketplaceActions {
  /** Set the package type filter. */
  setTypeFilter: (type: MarketplaceTypeFilter) => void;
  /** Set the category filter. Pass `null` to clear. */
  setCategoryFilter: (category: string | null) => void;
  /** Set the free-text search string. */
  setSearch: (search: string) => void;
  /** Set the sort order. */
  setSort: (sort: MarketplaceSort) => void;
  /** Reset all filters to their defaults. */
  resetFilters: () => void;

  /** Open the detail sheet for a given package. */
  openDetail: (pkg: AggregatedPackage) => void;
  /** Close the detail sheet. */
  closeDetail: () => void;

  /** Open the install confirmation dialog for a given package, optionally with agent context. */
  openInstallConfirm: (pkg: AggregatedPackage, context?: InstallContext) => void;
  /** Close the install confirmation dialog. */
  closeInstallConfirm: () => void;
}

// ---------------------------------------------------------------------------
// Initial values
// ---------------------------------------------------------------------------

const INITIAL_FILTERS: MarketplaceFilters = {
  type: 'all',
  category: null,
  search: '',
  sort: 'featured',
};

const INITIAL_STATE: MarketplaceState = {
  filters: INITIAL_FILTERS,
  detailPackage: null,
  installConfirmPackage: null,
  installContext: null,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Zustand store for Marketplace UI state.
 *
 * Manages filter state for the browse grid, which package is open in the
 * detail sheet, and which package is pending install confirmation. Server
 * state (package data, install results) is owned by TanStack Query.
 */
export const useMarketplaceStore = create<MarketplaceState & MarketplaceActions>()(
  devtools(
    (set) => ({
      ...INITIAL_STATE,

      setTypeFilter: (type) =>
        set((s) => ({ filters: { ...s.filters, type } }), false, 'marketplace/setTypeFilter'),

      setCategoryFilter: (category) =>
        set(
          (s) => ({ filters: { ...s.filters, category } }),
          false,
          'marketplace/setCategoryFilter'
        ),

      setSearch: (search) =>
        set((s) => ({ filters: { ...s.filters, search } }), false, 'marketplace/setSearch'),

      setSort: (sort) =>
        set((s) => ({ filters: { ...s.filters, sort } }), false, 'marketplace/setSort'),

      resetFilters: () => set({ filters: INITIAL_FILTERS }, false, 'marketplace/resetFilters'),

      openDetail: (pkg) => set({ detailPackage: pkg }, false, 'marketplace/openDetail'),

      closeDetail: () => set({ detailPackage: null }, false, 'marketplace/closeDetail'),

      openInstallConfirm: (pkg, context) =>
        set(
          { installConfirmPackage: pkg, installContext: context ?? null },
          false,
          'marketplace/openInstallConfirm'
        ),

      closeInstallConfirm: () =>
        set(
          { installConfirmPackage: null, installContext: null },
          false,
          'marketplace/closeInstallConfirm'
        ),
    }),
    { name: 'MarketplaceStore' }
  )
);
