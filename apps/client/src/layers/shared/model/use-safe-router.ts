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
 * ## Two ways the router can be absent, and both are guarded
 *
 * `getPlatform().isEmbedded` is set once at bootstrap (`setPlatformAdapter` in
 * the Obsidian view) and never changes for the life of the app. It is the
 * DECLARED answer, and for a long time it was the only guard here.
 *
 * It is not the whole answer, because the flag and the provider are set
 * independently: a host can be non-embedded and still have no `RouterProvider`
 * above a given subtree. Any component rendered outside the provider is in that
 * state, and so is every unit test that mounts a hook without wrapping it in a
 * router — which is how this bit: a hook reading session search was added to
 * `useTaskState`, and five DOR-1441 tests that had legitimately never needed a
 * router started failing with `Cannot read properties of null (reading
 * 'stores')`. A wrapper whose whole job is "never throw when there is no
 * router" should not depend on a flag to know whether there is one.
 *
 * So the guard for the two hooks that READ route state is now DECLARED **or**
 * OBSERVED: `useRouter({ warn: false })` reads the context directly and answers
 * `undefined` instead of throwing, which is the only reliable way to ask.
 * `useSafeNavigate` keeps the declared guard alone — see the note on it.
 *
 * Both facts are fixed for the life of a given component instance — a provider
 * never appears above a mounted subtree — so the hook set stays stable and the
 * conditional `useSearch`/`useRouterState` call is safe (the same dual-mode
 * shape as `useSessionId`/`useDirectoryState`).
 *
 * @module shared/model/use-safe-router
 */
import { useSearch, useRouterState, useNavigate, useRouter } from '@tanstack/react-router';
import { getPlatform } from '@/layers/shared/lib';

/** Frozen empty search for the embed — one identity so callers can memoize on it. */
const EMPTY_SEARCH: Record<string, unknown> = Object.freeze({});

/**
 * Whether route state can be read at all: the embed declares it cannot, and a
 * missing `RouterProvider` proves it regardless of what the platform declares.
 *
 * A hook, because it reads React context — call it unconditionally and branch
 * on the result.
 */
function useRouterAbsent(): boolean {
  // `warn: false` is load-bearing: the default logs a console warning on every
  // render without a provider, and asking the question is not a mistake here.
  const router = useRouter({ warn: false });
  return getPlatform().isEmbedded || !router;
}

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
  if (useRouterAbsent()) return EMPTY_SEARCH;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- conditional hook is safe: both facts behind `useRouterAbsent` are fixed for a mounted subtree's lifetime, so the hook order is stable (the dual-mode shape as useSessionId/useDirectoryState).
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
  // Deliberately the DECLARED guard only, unlike its two siblings. They read
  // route state on mount and throw without a provider, so they have to ask
  // whether one is really there; `useNavigate` mounts happily either way, so
  // there is no crash to prevent — and answering `null` for a tree that simply
  // has no provider yet would take the navigator away from callers that do get
  // one (the marketplace install toast is one).
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
  if (useRouterAbsent()) return EMBED_PATHNAME;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- conditional hook is safe: both facts behind `useRouterAbsent` are fixed for a mounted subtree's lifetime, so the hook order is stable (the dual-mode shape as useSessionId/useDirectoryState).
  return useRouterState({ select: (s) => s.location.pathname });
}
