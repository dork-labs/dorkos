/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createAppRouter } from '../router';
import { APP_ROUTE_PATHS } from '@/layers/shared/lib';

describe('APP_ROUTE_PATHS', () => {
  it('matches the paths the real router serves', () => {
    // The link seam classifies a same-origin href as internal only when it
    // lands on a route the cockpit actually serves. That list is declared in
    // the shared layer so classification stays a pure function — this test is
    // what keeps it honest when a route is added or renamed.
    const router = createAppRouter(new QueryClient());
    const routerPaths = Object.keys(router.routesByPath).sort();

    expect(routerPaths).toEqual([...APP_ROUTE_PATHS].sort());
  });
});
