import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createAppRouter } from '../router';

/**
 * The /runtimes discovery surface must be a first-class, deep-linkable route
 * (effortless-runtime-switching T2 task 3.4) — reachable by URL, not only via
 * in-app navigation.
 */
describe('/runtimes route registration', () => {
  it('registers /runtimes as a reachable, deep-linkable route', () => {
    const router = createAppRouter(new QueryClient());

    // Registered in the route tree (matched by its public path, not its id).
    const fullPaths = Object.values(router.routesById).map((r) => r.fullPath);
    expect(fullPaths).toContain('/runtimes');

    // Deep-linkable: a bare URL resolves to the runtimes surface.
    const location = router.buildLocation({ to: '/runtimes' });
    expect(location.pathname).toBe('/runtimes');
  });
});
