import { useMemo } from 'react';
import type { AdapterCategory, CatalogEntry } from '@dorkos/shared/relay-schemas';
import { useAdapterCatalog } from './use-adapter-catalog';

/**
 * The `internal` adapter category identifies runtime-bridge adapters
 * (e.g., `claude-code`) that must never surface in channel pickers.
 */
export const ADAPTER_CATEGORY_INTERNAL: AdapterCategory = 'internal';

/**
 * Adapter catalog with `category: 'internal'` entries filtered out.
 *
 * Use this hook instead of {@link useAdapterCatalog} in any UI surface
 * that presents adapters as "channels" to the user. Runtime-bridge
 * adapters (the `claude-code` adapter is the canonical example) belong
 * on the Agents surface, not the Channels surface.
 *
 * The underlying query is shared with `useAdapterCatalog` via TanStack
 * Query's cache, so no additional network request is issued.
 *
 * @param enabled - When false, the query is skipped entirely (Relay feature gate).
 */
export function useExternalAdapterCatalog(enabled = true) {
  const query = useAdapterCatalog(enabled);
  const data = useMemo<CatalogEntry[]>(
    () =>
      query.data?.filter((entry) => entry.manifest.category !== ADAPTER_CATEGORY_INTERNAL) ?? [],
    [query.data]
  );
  return { ...query, data };
}
