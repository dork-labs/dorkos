/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { createAppRouter } from '../router';
import { APP_ROUTE_PATHS } from '@/layers/shared/lib';

/** The paths the real router serves, sorted. */
function routerPaths(): string[] {
  return Object.keys(
    createAppRouter(new QueryClient(), createMockTransport() as Transport).routesByPath
  ).sort();
}

describe('APP_ROUTE_PATHS', () => {
  it('matches the paths the real router serves', () => {
    // The link seam classifies a same-origin href as internal only when it
    // lands on a route the cockpit actually serves. That list is declared in
    // the shared layer so classification stays a pure function — this test is
    // what keeps it honest when a route is added or renamed.
    expect(routerPaths()).toEqual([...APP_ROUTE_PATHS].sort());
  });

  it('rejects a router route with a dynamic segment', () => {
    // `classifyLink` matches a pathname by exact set membership, so a route
    // like `/session/$sessionId` cannot be represented by adding its literal to
    // APP_ROUTE_PATHS: the literal would satisfy the equality check above while
    // `/session/abc` classified as EXTERNAL and got handed to the system
    // browser — the exact bug this seam exists to fix, reintroduced silently.
    const dynamic = routerPaths().filter((path) => /[$*]/.test(path));
    expect(
      dynamic,
      'the router grew a parameterised route — teach classifyLink to match paths instead of adding the literal to APP_ROUTE_PATHS'
    ).toEqual([]);
  });
});

describe('route headers', () => {
  // `staticData.header` is a required route option (`StaticDataRouteOption` in
  // router.tsx), so a route missing it is already a type error at the place
  // it's declared. This is the runtime half of that guard: it iterates the
  // REAL route tree the router serves — the same one `resolveRouteHeader`
  // (AppShell.tsx) walks at runtime — so a route that compiles with a
  // deliberately-wrong header (e.g. cargo-culting `header: null` past the
  // typechecker) still fails here by name. It replaces the drift-guard
  // `describe` block that used to live in `app-shell-slots.test.tsx`, which
  // iterated the same paths but rendered the whole shell to check for it.
  function router() {
    return createAppRouter(new QueryClient(), createMockTransport() as Transport);
  }

  // `/agents` is the one addressable route with no bar of its own: it's a
  // `beforeLoad` redirect to `/team` and never renders a page, so the shell
  // never draws a header for it. Excluded by name rather than by loosening the
  // guard, so a route that genuinely forgets its header still fails.
  const HEADERLESS_ROUTES: readonly string[] = ['/agents'];

  it('declares a non-null header for every addressable route except /agents', () => {
    const { routesByPath } = router();
    for (const [path, route] of Object.entries(routesByPath)) {
      if (HEADERLESS_ROUTES.includes(path)) continue;
      expect(
        route.options.staticData?.header,
        `${path} has no staticData.header — add one in router.tsx (staticData: { header: <Component> })`
      ).not.toBeNull();
    }
  });

  it('declares a null header on every layout/root route — they render no bar of their own', () => {
    // `routesById`'s index signature is keyed by the union of every literal
    // route id TanStack infers, not `string` — a plain string index doesn't
    // typecheck against it. The route objects it holds are shaped exactly like
    // `routesByPath`'s (an `options.staticData` this test only reads), so a
    // narrow structural cast is honest rather than an `any` escape hatch.
    const routesById = router().routesById as Record<
      string,
      { options: { staticData?: { header?: unknown } } } | undefined
    >;
    for (const routeId of ['__root__', '/_shell', '/_shell/_home']) {
      expect(
        routesById[routeId]?.options.staticData?.header,
        `${routeId} is a pathless layout/root route and should declare staticData: { header: null }`
      ).toBeNull();
    }
  });
});
