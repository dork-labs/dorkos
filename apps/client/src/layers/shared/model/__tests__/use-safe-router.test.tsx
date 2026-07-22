/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { setPlatformAdapter } from '@/layers/shared/lib';

// Simulate a router that is present (routed cockpit) or absent (embed): when
// `routerThrows` is set, any TanStack hook call throws exactly as it does
// without a RouterProvider. The embed wrappers must never reach these.
let routerThrows = false;
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => {
    if (routerThrows) throw new Error('no RouterProvider');
    return { session: 'web-session' };
  },
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) => {
    if (routerThrows) throw new Error('no RouterProvider');
    return select({ location: { pathname: '/web-path' } });
  },
}));

import { useSafeSearch, useSafePathname, EMBED_PATHNAME } from '../use-safe-router';

const webAdapter = { isEmbedded: false, openFile: async () => {} };
const embedAdapter = { isEmbedded: true, openFile: async () => {} };

afterEach(() => {
  setPlatformAdapter(webAdapter);
  routerThrows = false;
});

describe('useSafeSearch', () => {
  it('returns the live TanStack search in the routed cockpit', () => {
    setPlatformAdapter(webAdapter);
    const { result } = renderHook(() => useSafeSearch());
    expect(result.current).toEqual({ session: 'web-session' });
  });

  it('returns an empty object in the router-less embed — without touching the router', () => {
    setPlatformAdapter(embedAdapter);
    routerThrows = true; // any router-hook call would throw, as it does with no provider
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
    routerThrows = true;
    const { result } = renderHook(() => useSafePathname());
    expect(result.current).toBe(EMBED_PATHNAME);
  });
});
