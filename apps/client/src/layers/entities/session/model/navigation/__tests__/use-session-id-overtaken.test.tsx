/**
 * @vitest-environment jsdom
 *
 * A late session navigation must not land on a chat the person has since left
 * (DOR-4622).
 *
 * Every send ends by committing the chat's canonical id to the URL — a
 * replace-rename, once the POST resolves. In the desktop app's tabs the URL IS
 * the active tab, so a person who sent in Tab 1 (Chat A) and switched to Tab 2
 * (Chat B) inside that window watched Tab 2 turn into Chat A: the rename was
 * written against whatever location was current, not the chat it renamed. A
 * plain browser showed the same thing as a click on Chat C in the sidebar
 * snapping back to A.
 *
 * So a rename names the chat it renames FROM, and does nothing when that chat
 * is no longer on screen. The two async fresh-chat paths (`useStartNewSession`
 * and the setter's `draft` branch) await the server before navigating, and get
 * the same answer through `beginSessionNavigation`: if the person went
 * somewhere else meanwhile, stay quiet.
 *
 * A REAL memory router, not a mocked `navigate`: the bug is precisely which
 * location the write lands on, and a mock records the call without ever
 * having a location to be wrong about.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';

import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { sessionSearchSchema } from '@/layers/shared/lib';
import { useSessionId, useStartNewSession } from '../use-session-id';

// TanStack Router hooks need to run inside a route component, so the hook under
// test is injected into the route through a tiny context (the
// use-dialog-deep-link harness pattern).
const HookSlotContext = createContext<ReactNode>(null);

function HookSlot() {
  return <>{useContext(HookSlotContext)}</>;
}

/** A deferred promise, so a test decides when the server answers. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function buildHarness(initialUrl: string, transport = createMockTransport()) {
  const rootRoute = createRootRoute({ staticData: { header: null }, component: () => <Outlet /> });
  const sessionRoute = createRoute({
    staticData: { header: null },
    getParentRoute: () => rootRoute,
    path: '/session',
    validateSearch: zodValidator(sessionSearchSchema),
    component: HookSlot,
  });
  const history = createMemoryHistory({ initialEntries: [initialUrl] });
  const router = createRouter({ routeTree: rootRoute.addChildren([sessionRoute]), history });

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <TransportProvider transport={transport}>
        <HookSlotContext.Provider value={children}>
          <RouterProvider router={router} />
        </HookSlotContext.Provider>
      </TransportProvider>
    );
  }

  function readSearch(): Record<string, unknown> {
    return router.state.location.search as Record<string, unknown>;
  }

  /** Move the window to another chat — a tab switch or a sidebar click. */
  async function goTo(href: string): Promise<void> {
    await act(async () => {
      await router.navigate({ href });
    });
  }

  async function waitForRouterReady(): Promise<void> {
    await waitFor(() => expect(router.state.status).toBe('idle'));
  }

  return { router, Wrapper, readSearch, goTo, waitForRouterReady };
}

/** Let every queued promise continuation and the router's own commit run. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  useAppStore.setState({ selectedCwd: '/proj' });
});

describe('setSessionId replace-rename (DOR-4622)', () => {
  it('renames the chat on screen when it is still the chat being renamed', async () => {
    const harness = buildHarness('/session?session=A');
    const { result } = renderHook(() => useSessionId(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    await waitFor(() => expect(result.current[0]).toBe('A'));

    await act(async () => {
      result.current[1]('A2', { replace: true, from: 'A' });
    });
    await settle();

    expect(harness.readSearch().session).toBe('A2');
  });

  it('does not rewrite a different chat the person switched to before the send resolved', async () => {
    // Tab 1 shows A; the person sends there, then switches to Tab 2 (B). The
    // send's URL commit arrives afterwards, carrying the setter Tab 1's panel
    // was holding when the send began.
    const harness = buildHarness('/session?session=A');
    const { result } = renderHook(() => useSessionId(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    await waitFor(() => expect(result.current[0]).toBe('A'));
    const setWhileOnA = result.current[1];

    await harness.goTo('/session?session=B');
    expect(harness.readSearch().session).toBe('B');

    await act(async () => {
      setWhileOnA('A', { replace: true, from: 'A' });
    });
    await settle();

    expect(harness.readSearch().session).toBe('B');
  });

  it('does not rewrite the new chat with a rekey for the old one, even through the fresh setter', async () => {
    // The rekey redirect reads the setter from a ref synced every render, so it
    // can hold the CURRENT setter, rendered on B. The guard must read the live
    // location, not trust which render produced the setter.
    const harness = buildHarness('/session?session=client-uuid');
    const { result } = renderHook(() => useSessionId(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    await harness.goTo('/session?session=B');
    await waitFor(() => expect(result.current[0]).toBe('B'));

    await act(async () => {
      result.current[1]('sdk-canonical', { replace: true, from: 'client-uuid' });
    });
    await settle();

    expect(harness.readSearch().session).toBe('B');
  });
});

describe('fresh chats started asynchronously (DOR-4622)', () => {
  it('useStartNewSession opens the fresh chat when the person stayed put', async () => {
    const location = deferred<{ id: string }>();
    const transport = createMockTransport({ createSessionLocation: () => location.promise });
    const harness = buildHarness('/session?session=A', transport);
    const { result } = renderHook(() => useStartNewSession(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    act(() => {
      result.current('/proj');
    });
    location.resolve({ id: 'loc-1' });
    await settle();

    expect(harness.readSearch().draft).toBe('1');
    expect(harness.readSearch().launchRef).toBe('loc-1');
    expect(harness.readSearch().session).not.toBe('A');
  });

  it('useStartNewSession stays quiet when the person moved on before the server answered', async () => {
    const location = deferred<{ id: string }>();
    const transport = createMockTransport({ createSessionLocation: () => location.promise });
    const harness = buildHarness('/session?session=A', transport);
    const { result } = renderHook(() => useStartNewSession(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();

    act(() => {
      result.current('/proj');
    });
    await harness.goTo('/session?session=B');
    location.resolve({ id: 'loc-1' });
    await settle();

    expect(harness.readSearch().session).toBe('B');
    expect(harness.readSearch().draft).toBeUndefined();
    expect(harness.readSearch().launchRef).toBeUndefined();
  });

  it('the draft setter stays quiet when the person moved on before the server answered', async () => {
    const location = deferred<{ id: string }>();
    const transport = createMockTransport({ createSessionLocation: () => location.promise });
    const harness = buildHarness('/session?session=A', transport);
    const { result } = renderHook(() => useSessionId(), { wrapper: harness.Wrapper });
    await harness.waitForRouterReady();
    await waitFor(() => expect(result.current[0]).toBe('A'));

    act(() => {
      result.current[1]('fresh-uuid', { draft: true });
    });
    await harness.goTo('/session?session=B');
    location.resolve({ id: 'loc-1' });
    await settle();

    expect(harness.readSearch().session).toBe('B');
    expect(harness.readSearch().draft).toBeUndefined();
  });
});
