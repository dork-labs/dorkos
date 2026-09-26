/** Router reads that also support isolated components in the Dev Playground. */
import { useSearch, useRouterState, useNavigate, useRouter } from '@tanstack/react-router';
import { SESSION_ROUTE } from '@dorkos/shared/session-link';

/** Stable empty search for a subtree rendered without a router. */
const EMPTY_SEARCH: Record<string, unknown> = Object.freeze({});

/** Session-oriented components retain their default surface in isolated previews. */
const DEFAULT_PREVIEW_PATHNAME = SESSION_ROUTE;

/** Read search parameters, or an empty object when no RouterProvider exists. */
export function useSafeSearch(): Record<string, unknown> {
  const router = useRouter({ warn: false });
  if (!router) return EMPTY_SEARCH;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- RouterProvider presence is fixed for a mounted subtree's lifetime.
  return useSearch({ strict: false });
}

/** Return a navigator only when the mounted subtree has a RouterProvider. */
export function useSafeNavigate(): ReturnType<typeof useNavigate> | null {
  const router = useRouter({ warn: false });
  const navigate = useNavigate();
  return router ? navigate : null;
}

/** Read the pathname, with a session surface fallback for isolated previews. */
export function useSafePathname(): string {
  const router = useRouter({ warn: false });
  if (!router) return DEFAULT_PREVIEW_PATHNAME;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- RouterProvider presence is fixed for a mounted subtree's lifetime.
  return useRouterState({ select: (s) => s.location.pathname });
}
