import { useNavigate } from '@tanstack/react-router';
import { getPlatform } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import { useSessionSearch } from './use-session-search';

/**
 * Dual-mode session ID hook.
 *
 * - **Standalone (web):** reads `?session=` from TanStack Router search params.
 *   Setter navigates to `/session?session=<id>` with history push.
 * - **Embedded (Obsidian):** reads/writes Zustand store directly.
 *
 * Both stores are subscribed unconditionally to satisfy React's rules of hooks.
 */
export function useSessionId(): [string | null, (id: string | null) => void] {
  const platform = getPlatform();

  // Embedded: Zustand store (always subscribed for rules of hooks)
  const storeId = useAppStore((s) => s.sessionId);
  const setStoreId = useAppStore((s) => s.setSessionId);

  // Standalone: TanStack Router search params
  const search = useSessionSearch();
  const navigate = useNavigate();

  if (platform.isEmbedded) {
    return [storeId, setStoreId];
  }

  const setSessionId = (id: string | null) => {
    navigate({
      to: '/session',
      search: (prev) => ({
        ...prev,
        session: id ?? undefined,
      }),
    });
  };

  return [search.session ?? null, setSessionId];
}
