/**
 * @vitest-environment jsdom
 *
 * The router-safe wrappers, against BOTH ways the router can be absent.
 *
 * The embed is the declared way: `getPlatform().isEmbedded`. The other is
 * simply having no `RouterProvider` above the subtree — a non-embedded host can
 * be in that state, and so is every unit test that mounts one of these hooks
 * without wrapping it in a router. That second case used to throw, which is how
 * adding a session-search read to `useTaskState` broke five DOR-1441 tests that
 * had legitimately never needed a router (DOR-1444).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { setPlatformAdapter } from '@/layers/shared/lib/platform';

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

import {
  useSafeSearch,
  useSafePathname,
  useSafeNavigate,
  EMBED_PATHNAME,
} from '../use-safe-router';

const webAdapter = { isEmbedded: false, openFile: async () => {} };
const embedAdapter = { isEmbedded: true, openFile: async () => {} };

afterEach(() => {
  setPlatformAdapter(webAdapter);
  routerPresent = true;
});

describe('useSafeSearch', () => {
  it('returns the live TanStack search in the routed cockpit', () => {
    setPlatformAdapter(webAdapter);
    const { result } = renderHook(() => useSafeSearch());
    expect(result.current).toEqual({ session: 'web-session' });
  });

  it('returns an empty object in the router-less embed — without touching the router', () => {
    setPlatformAdapter(embedAdapter);
    routerPresent = false; // any router-hook call would throw, as it does with no provider
    const { result } = renderHook(() => useSafeSearch());
    expect(result.current).toEqual({});
  });

  it('returns an empty object with no provider, even when the platform says web', () => {
    // The case the flag cannot see. Red when the guard trusts `isEmbedded`
    // alone: this throws `Cannot read properties of null (reading 'stores')`,
    // which is exactly how the DOR-1441 tests failed.
    setPlatformAdapter(webAdapter);
    routerPresent = false;

    const { result } = renderHook(() => useSafeSearch());

    expect(result.current).toEqual({});
  });
});

describe('useSafePathname', () => {
  it('returns the live pathname in the routed cockpit', () => {
    setPlatformAdapter(webAdapter);
    const { result } = renderHook(() => useSafePathname());
    expect(result.current).toBe('/web-path');
  });

  it("returns '/session' in the router-less embed — without touching the router", () => {
    setPlatformAdapter(embedAdapter);
    routerPresent = false;
    const { result } = renderHook(() => useSafePathname());
    expect(result.current).toBe(EMBED_PATHNAME);
  });

  it("returns '/session' with no provider, even when the platform says web", () => {
    setPlatformAdapter(webAdapter);
    routerPresent = false;

    const { result } = renderHook(() => useSafePathname());

    expect(result.current).toBe(EMBED_PATHNAME);
  });
});

describe('useSafeNavigate', () => {
  it('returns a navigator in the routed cockpit', () => {
    setPlatformAdapter(webAdapter);
    const { result } = renderHook(() => useSafeNavigate());
    expect(typeof result.current).toBe('function');
  });

  it('still returns a navigator with no provider — it has no mount-time throw to guard', () => {
    // The asymmetry is deliberate. `useNavigate` resolves its router lazily, so
    // there is no crash to prevent, and answering null here would take the
    // navigator away from callers rendered outside a provider in tests that
    // legitimately expect one.
    setPlatformAdapter(webAdapter);
    routerPresent = false;

    const { result } = renderHook(() => useSafeNavigate());

    expect(typeof result.current).toBe('function');
  });
});
