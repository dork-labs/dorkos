import { useCallback, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

/**
 * Reuse the identity kept by the sidebar's batch reads, without another request.
 * A missing folder manifest must not erase a name another surface already knows.
 * Newer batch answers win; a folder basename is never an identity.
 *
 * @param path - The agent's directory, or null when no identity is needed.
 */
export function useCachedAgent(path: string | null): AgentManifest | null {
  const cache = useQueryClient().getQueryCache();
  const subscribe = useCallback((notify: () => void) => cache.subscribe(notify), [cache]);
  const snapshot = useCallback(() => {
    if (!path) return null;
    let newest = 0;
    let agent: AgentManifest | null = null;
    for (const query of cache.findAll({ queryKey: ['agents', 'resolved'] })) {
      const kept = (query.state.data as Record<string, AgentManifest | null> | undefined)?.[path];
      if (kept && query.state.dataUpdatedAt >= newest) {
        agent = kept;
        newest = query.state.dataUpdatedAt;
      }
    }
    return agent;
  }, [cache, path]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
