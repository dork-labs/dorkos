/**
 * `?inbox=` opens the Inbox from a plain link on any route (DOR-2577).
 *
 * Real router, real search schema: the param has to survive the same route
 * validation the app's routes run, and come back out of the address once read.
 *
 * @vitest-environment jsdom
 */
import { createContext, useContext, type ReactNode } from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
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
import { mergeDialogSearch } from '@/layers/shared/model/dialog-search-schema';
import { parseAppSearch, stringifyAppSearch } from '@/layers/shared/lib/router-search';
import { clearInboxRequest, useInboxRequest } from '../model/inbox-request-store';
import { useInboxDeepLink } from '../model/use-inbox-deep-link';

const HookSlotContext = createContext<ReactNode>(null);

function HookSlot() {
  return <>{useContext(HookSlotContext)}</>;
}

/**
 * A router with one validated route (`/activity`, like the app's home
 * surfaces) and one unvalidated route (`/x/flow`, like an extension page).
 */
function buildHarness(initialUrl: string) {
  const rootRoute = createRootRoute({ staticData: { header: null }, component: () => <Outlet /> });
  const activityRoute = createRoute({
    staticData: { header: null },
    getParentRoute: () => rootRoute,
    path: '/activity',
    validateSearch: zodValidator(mergeDialogSearch(z.object({ since: z.string().optional() }))),
    component: HookSlot,
  });
  const extensionRoute = createRoute({
    staticData: { header: null },
    getParentRoute: () => rootRoute,
    path: '/x/flow',
    component: HookSlot,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([activityRoute, extensionRoute]),
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
    parseSearch: parseAppSearch,
    stringifySearch: stringifyAppSearch,
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <HookSlotContext.Provider value={children}>
        <RouterProvider router={router} />
      </HookSlotContext.Provider>
    );
  }
  return { router, Wrapper };
}

/** Mount the deep link and read the request it makes. */
function mount(initialUrl: string) {
  const harness = buildHarness(initialUrl);
  const view = renderHook(
    () => {
      useInboxDeepLink();
      return useInboxRequest();
    },
    { wrapper: harness.Wrapper }
  );
  return { ...harness, view };
}

beforeEach(() => {
  clearInboxRequest();
});

describe('useInboxDeepLink', () => {
  it('opens the whole Inbox for ?inbox=open, and takes the param back out', async () => {
    const { router, view } = mount('/activity?inbox=open&since=today');

    await waitFor(() => expect(view.result.current.openRequest).toBe(1));
    expect(view.result.current.focus).toBeUndefined();
    expect(view.result.current.lens).toBeUndefined();
    await waitFor(() => expect(router.state.location.search).toEqual({ since: 'today' }));
    expect(router.state.location.pathname).toBe('/activity');
  });

  it('asks the Inbox to focus one item for ?inbox=<id>, on an extension page', async () => {
    const { router, view } = mount('/x/flow?inbox=01J0000000000000000000000D');

    await waitFor(() => expect(view.result.current.openRequest).toBe(1));
    expect(view.result.current.focus).toBe('01J0000000000000000000000D');
    // The person stays on the page they were on.
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(router.state.location.pathname).toBe('/x/flow');
  });

  it('reads a number-looking id as an id', async () => {
    const { view } = mount('/activity?inbox=12345');

    await waitFor(() => expect(view.result.current.focus).toBe('12345'));
  });

  it('replaces the history entry, so Back does not reopen the Inbox', async () => {
    const { router, view } = mount('/x/flow?inbox=open');

    await waitFor(() => expect(view.result.current.openRequest).toBe(1));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(router.history.length).toBe(1);
  });

  it('opens again for a second link after the first was read', async () => {
    const { router, view } = mount('/x/flow?inbox=a');
    await waitFor(() => expect(router.state.location.search).toEqual({}));

    await router.navigate({ href: '/x/flow?inbox=b' });

    await waitFor(() => expect(view.result.current.openRequest).toBe(2));
    expect(view.result.current.focus).toBe('b');
  });

  it('does nothing without the param', async () => {
    const { router, view } = mount('/activity?since=today');

    await waitFor(() => expect(router.state.status).toBe('idle'));
    expect(view.result.current.openRequest).toBe(0);
    expect(router.state.location.search).toEqual({ since: 'today' });
  });
});
