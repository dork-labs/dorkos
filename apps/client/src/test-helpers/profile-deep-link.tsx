/**
 * A router a component test can open a profile through, and read the answer off.
 *
 * Every surface that opens the profile drawer does it the same way — through
 * `useProfileDeepLink().open(id)`, which writes `?profile=<id>` — so the honest
 * assertion for "this face opens the RIGHT profile" is the search param the
 * navigation actually produced, not a spy on a mocked hook. Mocking the hook
 * would let a caller pass an id from the wrong id space forever: the mock says
 * yes to any string, and the URL is where the truth lives (it is also what a
 * reload reopens).
 *
 * The shape is TanStack's own requirement, not ceremony: `useSearch` and
 * `useNavigate` need the caller to be INSIDE a route component, so the children
 * under test are injected into a route via a context slot.
 *
 * @module test-helpers/profile-deep-link
 */
import { createContext, useContext, type ReactNode } from 'react';
import { waitFor } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { mergeDialogSearch } from '@/layers/shared/model';

const slotSchema = mergeDialogSearch(z.object({}));

const SlotContext = createContext<ReactNode>(null);

function Slot() {
  return <>{useContext(SlotContext)}</>;
}

/** A mounted router plus the two readings a profile test needs from it. */
export interface ProfileDeepLinkHarness {
  /** Wrap the component under test in this. */
  Wrapper: ({ children }: { children: ReactNode }) => ReactNode;
  /** Whose profile the URL is holding open, or `null` while it holds none. */
  openProfileId: () => string | null;
  /** Settle the router's initial load before asserting on search params. */
  ready: () => Promise<void>;
}

/**
 * Mount a one-route memory router carrying the dialog search schema.
 *
 * @param initialUrl - Where the router starts; pass `'/?profile=x'` to test a
 *   surface that reads an already-open profile.
 */
export function buildProfileDeepLinkHarness(initialUrl = '/'): ProfileDeepLinkHarness {
  // `staticData.header` is required on every route (see the module augmentation
  // in `router.tsx`). This harness renders no app shell, so it declares none.
  const rootRoute = createRootRoute({ staticData: { header: null }, component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    staticData: { header: null },
    validateSearch: zodValidator(slotSchema),
    component: Slot,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  });

  return {
    Wrapper: ({ children }) => (
      <SlotContext.Provider value={children}>
        <RouterProvider router={router} />
      </SlotContext.Provider>
    ),
    openProfileId: () => (router.state.location.search as { profile?: string }).profile ?? null,
    ready: async () => {
      await waitFor(() => {
        if (router.state.status !== 'idle') throw new Error('router still loading');
      });
    },
  };
}
