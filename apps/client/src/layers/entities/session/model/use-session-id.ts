import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { getPlatform } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import { useSessionSearch } from './use-session-search';

/** Options for the session-id setter. */
export interface SetSessionIdOptions {
  /**
   * When true, REPLACE the current history entry instead of pushing a new one.
   * Used for the create-on-first-message client-UUID → canonical-id rekey so the
   * canonical URL silently supersedes the optimistic one (no extra Back step).
   */
  replace?: boolean;
}

/**
 * Dual-mode session ID hook.
 *
 * - **Standalone (web):** reads `?session=` from TanStack Router search params.
 *   Setter navigates to `/session?session=<id>` (history push by default; pass
 *   `{ replace: true }` for an in-place URL rewrite).
 * - **Embedded (Obsidian):** reads/writes Zustand store directly (`replace` is a
 *   no-op — there is no browser history to manage).
 *
 * Both stores are subscribed unconditionally to satisfy React's rules of hooks.
 */
export function useSessionId(): [
  string | null,
  (id: string | null, options?: SetSessionIdOptions) => void,
] {
  const platform = getPlatform();

  // Embedded: Zustand store (always subscribed for rules of hooks)
  const storeId = useAppStore((s) => s.sessionId);
  const setStoreId = useAppStore((s) => s.setSessionId);

  // Standalone: TanStack Router search params
  const search = useSessionSearch();
  const navigate = useNavigate();

  // Stable reference — navigate from TanStack Router is already stable.
  const setSessionId = useCallback(
    (id: string | null, options?: SetSessionIdOptions) => {
      navigate({
        to: '/session',
        search: (prev) => ({
          ...prev,
          session: id ?? undefined,
        }),
        replace: options?.replace,
      });
    },
    [navigate]
  );

  // Embedded setter ignores options (no history to push/replace).
  const setEmbeddedId = useCallback(
    (id: string | null, _options?: SetSessionIdOptions) => setStoreId(id),
    [setStoreId]
  );

  if (platform.isEmbedded) {
    return [storeId, setEmbeddedId];
  }

  return [search.session ?? null, setSessionId];
}
