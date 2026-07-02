/**
 * Marketplace install-flow UI state — the install confirmation dialog.
 *
 * Browse state (type filter, sort, search, and the open package drawer) lives
 * in the URL via `useMarketplaceParams`; this store owns only the transient
 * install-confirmation modal state, which is an action rather than a shareable
 * view (and `installContext` carries an agent path unfit for a URL). Server
 * state (package lists, install results) lives in TanStack Query via
 * `entities/marketplace`.
 *
 * @module features/marketplace/model/marketplace-store
 */
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';

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

/** State slice of the Marketplace store. */
export interface MarketplaceState {
  /** Package pending the install confirmation dialog (`null` = dialog closed). */
  installConfirmPackage: AggregatedPackage | null;
  /** Context of the agent that triggered the install (null = marketplace browse). */
  installContext: InstallContext | null;
}

/** Actions exposed by the Marketplace store. */
export interface MarketplaceActions {
  /** Open the install confirmation dialog for a given package, optionally with agent context. */
  openInstallConfirm: (pkg: AggregatedPackage, context?: InstallContext) => void;
  /** Close the install confirmation dialog. */
  closeInstallConfirm: () => void;
}

// ---------------------------------------------------------------------------
// Initial values
// ---------------------------------------------------------------------------

const INITIAL_STATE: MarketplaceState = {
  installConfirmPackage: null,
  installContext: null,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Zustand store for transient Marketplace install-flow state.
 *
 * Owns which package is pending install confirmation and the agent context
 * that triggered it. Browse/navigation state is owned by the URL; server state
 * (package data, install results) is owned by TanStack Query.
 */
export const useMarketplaceStore = create<MarketplaceState & MarketplaceActions>()(
  devtools(
    (set) => ({
      ...INITIAL_STATE,

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
