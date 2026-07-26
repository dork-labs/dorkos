/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createAppRouter } from '../router';
import { APP_ROUTE_PATHS } from '@/layers/shared/lib';

/** The paths the real router serves, sorted. */
function routerPaths(): string[] {
  return Object.keys(createAppRouter(new QueryClient()).routesByPath).sort();
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
