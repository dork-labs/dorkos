/**
 * Router-safe wrappers over TanStack Router's `useSearch` / `useRouterState`.
 *
 * The standalone web/desktop cockpit mounts a `RouterProvider`; the Obsidian
 * embed deliberately does not (it renders `App` directly — session state lives
 * in the store, not the URL). Calling `useSearch` or `useRouterState` without a
 * provider throws, so every shared hook that reads route state in a surface the
 * embed also renders (session search, dialog/profile deep-links, the Pulse
 * teasers, the profile) routes through these wrappers instead.
 *
 * The branch keys on `getPlatform().isEmbedded`, which is set once at bootstrap
 * (`setPlatformAdapter` in the Obsidian view) and never changes for the life of
 * the app — so the hook set is stable across every render of a given app
 * instance, and the conditional `useSearch`/`useRouterState` call is safe in
 * practice (the same dual-mode shape as `useSessionId`/`useDirectoryState`).
 *
 * @module shared/model/use-safe-router
 */
import { useSearch, useRouterState, useNavigate } from '@tanstack/react-router';
import { getPlatform } from '@/layers/shared/lib';

/** Frozen empty search for the embed — one identity so callers can memoize on it. */
const EMPTY_SEARCH: Record<string, unknown> = Object.freeze({});

/**
 * The embed's canonical pathname. The Obsidian view is always a single session
 * surface, so route-scoped predicates (`pathname === '/session'`) resolve the
 * way they do for the routed cockpit's session route.
 */
export const EMBED_PATHNAME = '/session';

/**
 * Read the current route's search params, degrading to an empty object in the
 * router-less embed.
 *
 * Returns the live TanStack search (`strict: false`, so it never throws on a
 * route mismatch) in the routed cockpit; returns a stable empty object in the
 * Obsidian embed, where there is no URL to read and session state lives in the
 * store. Cast the result to the caller's expected shape as with `useSearch`.
 */
export function useSafeSearch(): Record<string, unknown> {
  if (getPlatform().isEmbedded) return EMPTY_SEARCH;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- conditional hook is safe: `isEmbedded` is fixed at bootstrap, so the hook order is stable for the app's lifetime (the dual-mode shape as useSessionId/useDirectoryState).
  return useSearch({ strict: false });
}

/**
 * The route navigator, or `null` in the router-less embed.
 *
 * `useNavigate` resolves its router lazily — the hook mounts happily without a
 * provider and only *calling* the returned function throws
 * `Cannot read properties of null (reading 'navigate')`. That turns every
 * URL-driven affordance into a control that looks healthy until it is pressed,
 * which is worse than one that is visibly unavailable. Returning `null` here
 * moves the failure to compile time: callers cannot use the navigator without
 * first saying what the embed should do instead.
 */
export function useSafeNavigate(): ReturnType<typeof useNavigate> | null {
  if (getPlatform().isEmbedded) return null;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- conditional hook is safe: `isEmbedded` is fixed at bootstrap, so the hook order is stable for the app's lifetime (the dual-mode shape as useSessionId/useDirectoryState).
  return useNavigate();
}

/**
 * Read the current route pathname, degrading to {@link EMBED_PATHNAME} in the
 * router-less embed.
 *
 * Returns the live TanStack pathname in the routed cockpit (reactive to
 * navigation); returns `'/session'` in the Obsidian embed, whose only surface is
 * a session.
 */
export function useSafePathname(): string {
  if (getPlatform().isEmbedded) return EMBED_PATHNAME;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- conditional hook is safe: `isEmbedded` is fixed at bootstrap, so the hook order is stable for the app's lifetime (the dual-mode shape as useSessionId/useDirectoryState).
  return useRouterState({ select: (s) => s.location.pathname });
}
