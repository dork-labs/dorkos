/**
 * @vitest-environment jsdom
 *
 * The router-safe wrappers, against BOTH ways the router can be absent.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

/**
 * Model the real module: `useRouter` reads context and answers `undefined` when
 * there is no provider, while `useSearch`/`useRouterState` reach through it and
 * throw. Setting `routerPresent = false` reproduces a router-less tree exactly
 * — which is what makes "the wrapper never throws" a real assertion rather than
 * a restatement of the mock.
 */
let routerPresent = true;
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => (routerPresent ? { stores: {} } : undefined),
  useSearch: () => {
    if (!routerPresent) throw new TypeError("Cannot read properties of null (reading 'stores')");
    return { session: 'web-session' };
  },
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) => {
    if (!routerPresent) throw new TypeError("Cannot read properties of null (reading 'stores')");
    return select({ location: { pathname: '/web-path' } });
  },
  // Lazy by design: mounts without a provider, throws only when called.
  useNavigate: () => () => {},
}));

import { useSafeSearch, useSafePathname, useSafeNavigate } from '../use-safe-router';

afterEach(() => {
  routerPresent = true;
});

describe('useSafeSearch', () => {
  it('returns the live TanStack search in the routed cockpit', () => {
    const { result } = renderHook(() => useSafeSearch());
    expect(result.current).toEqual({ session: 'web-session' });
  });

  it('returns an empty object with no provider, even when the platform says web', () => {
    routerPresent = false;

    const { result } = renderHook(() => useSafeSearch());

    expect(result.current).toEqual({});
  });
});

describe('useSafePathname', () => {
  it('returns the live pathname in the routed cockpit', () => {
    const { result } = renderHook(() => useSafePathname());
    expect(result.current).toBe('/web-path');
  });

  it("returns '/session' with no provider, even when the platform says web", () => {
    routerPresent = false;

    const { result } = renderHook(() => useSafePathname());

    expect(result.current).toBe('/session');
  });
});

describe('useSafeNavigate', () => {
  it('returns a navigator in the routed cockpit', () => {
    const { result } = renderHook(() => useSafeNavigate());
    expect(typeof result.current).toBe('function');
  });

  it('returns null without a provider, so isolated controls cannot invoke a missing router', () => {
    routerPresent = false;

    const { result } = renderHook(() => useSafeNavigate());

    expect(result.current).toBeNull();
  });
});
