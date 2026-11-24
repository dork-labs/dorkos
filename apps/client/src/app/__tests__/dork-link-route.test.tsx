/**
 * The `/r/<dork-uri>` route (DOR-5046): it asks the server what the link opens,
 * then replaces itself with that screen; a link that opens nothing shows the
 * app's ordinary not-found page.
 *
 * The route under test is the real one (`routes/r.$.tsx`): its `beforeLoad`
 * is mounted, with the not-found page it shows, into a small tree whose
 * destinations stand in for the real pages, which only have to say where the
 * router landed.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLocation,
} from '@tanstack/react-router';
import { QueryClient } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import type { ResolvedDorkLink } from '@dorkos/shared/dork-link-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { NotFoundFallback } from '@/layers/shared/ui';
import { Route as DorkLinkRoute } from '../../routes/r.$';
import { dorkLinkBeforeLoad } from '@/layers/shared/lib';
import type { RouterContext } from '../router-context';

/** A destination page: says which path and search the router landed on. */
function Landed() {
  const location = useLocation();
  return <div data-testid="landed">{`${location.pathname}${location.searchStr}`}</div>;
}

function buildRouter(transport: Transport, url: string) {
  const root = createRootRouteWithContext<RouterContext>()({
    staticData: { header: null },
    component: () => <Outlet />,
  });
  const page = (path: string) =>
    createRoute({
      staticData: { header: null },
      getParentRoute: () => root,
      path,
      component: Landed,
    });
  const link = createRoute({
    staticData: { header: null },
    getParentRoute: () => root,
    path: '/r/$',
    beforeLoad: dorkLinkBeforeLoad,
    // The route module's own page is NotFoundFallback, but under the router
    // plugin's code splitting it arrives as a lazy chunk, which only adds a
    // pending wait to every test here.
    component: NotFoundFallback,
  });
  const history = createMemoryHistory({ initialEntries: ['/', url] });
  const router = createRouter({
    routeTree: root.addChildren([
      page('/'),
      page('/session'),
      page('/channels'),
      page('/team'),
      link,
    ]),
    history,
    context: { queryClient: new QueryClient(), transport },
  });
  return { router, history };
}

/** A transport whose link lookup answers `link`, or rejects with `error`. */
function transportAnswering(answer: ResolvedDorkLink | { status: number }) {
  const resolveDorkLink = vi.fn(async (_uri: string) => {
    if ('status' in answer) {
      throw Object.assign(new Error('That link opens nothing you can see here.'), answer);
    }
    return answer;
  });
  const transport = createMockTransport({ resolveDorkLink }) as Transport;
  return { transport, resolveDorkLink };
}

async function open(url: string, answer: ResolvedDorkLink | { status: number }) {
  const { transport, resolveDorkLink } = transportAnswering(answer);
  const { router, history } = buildRouter(transport, url);
  render(<RouterProvider router={router} />);
  return { router, history, resolveDorkLink };
}

describe('the /r/ link route', () => {
  it('is the route module’s own beforeLoad', () => {
    expect(DorkLinkRoute.options.beforeLoad).toBe(dorkLinkBeforeLoad);
  });

  it('opens a chat, replacing the link in history', async () => {
    const { history, resolveDorkLink } = await open('/r/dork:chat:7c1e4b2a', {
      kind: 'chat',
      sessionId: '7c1e4b2a-runtime',
    });
    expect(await screen.findByTestId('landed')).toHaveTextContent(
      '/session?session=7c1e4b2a-runtime'
    );
    expect(resolveDorkLink).toHaveBeenCalledWith('dork:chat:7c1e4b2a');
    expect(history.length).toBe(2);
  });

  it('replaces a link followed from inside the app, so Back skips it', async () => {
    const { transport } = transportAnswering({ kind: 'chat', sessionId: '7c1e4b2a-runtime' });
    const { router, history } = buildRouter(transport, '/');
    render(<RouterProvider router={router} />);
    expect(await screen.findByTestId('landed')).toHaveTextContent('/');
    await router.navigate({ href: '/r/dork:chat:7c1e4b2a' });
    expect(await screen.findByTestId('landed')).toHaveTextContent(
      '/session?session=7c1e4b2a-runtime'
    );
    // Clicking the link pushed one entry; opening the chat replaced it, not a second push.
    expect(history.length).toBe(3);
    history.back();
    expect(await screen.findByTestId('landed')).toHaveTextContent(/^\/$/);
  });

  it('asks the server nothing on a hover preload, and still opens the link on the click', async () => {
    const { transport, resolveDorkLink } = transportAnswering({
      kind: 'chat',
      sessionId: '7c1e4b2a-runtime',
    });
    const { router } = buildRouter(transport, '/');
    render(<RouterProvider router={router} />);
    expect(await screen.findByTestId('landed')).toHaveTextContent('/');

    // What `defaultPreload: 'intent'` does when a pointer rests on the link.
    await router.preloadRoute({ to: '/r/$', params: { _splat: 'dork:chat:7c1e4b2a' } } as never);
    expect(resolveDorkLink).not.toHaveBeenCalled();

    await router.navigate({ href: '/r/dork:chat:7c1e4b2a' });
    expect(await screen.findByTestId('landed')).toHaveTextContent(
      '/session?session=7c1e4b2a-runtime'
    );
    expect(resolveDorkLink).toHaveBeenCalledTimes(1);
  });

  it('opens a room', async () => {
    await open('/r/dork:room:01JD3G', { kind: 'room', roomId: '01JD3G' });
    expect(await screen.findByTestId('landed')).toHaveTextContent('/channels?id=01JD3G');
  });

  it('opens a message in its room, at its place', async () => {
    await open('/r/dork:entry:01JD3H', {
      kind: 'entry',
      roomId: '01JD3G',
      entryId: '01JD3H',
      seq: 42,
    });
    expect(await screen.findByTestId('landed')).toHaveTextContent('/channels?id=01JD3G&entry=42');
  });

  it('opens a reply inside its thread', async () => {
    await open('/r/dork:entry:01JD3J', {
      kind: 'entry',
      roomId: '01JD3G',
      entryId: '01JD3J',
      seq: 43,
      threadRootEntryId: '01JD3H',
    });
    expect(await screen.findByTestId('landed')).toHaveTextContent(
      '/channels?id=01JD3G&entry=43&thread=01JD3H'
    );
  });

  it('opens an agent’s profile', async () => {
    await open('/r/dork:agent:01KJ0000000000000000SC7T9Z', {
      kind: 'agent',
      agentId: '01KJ0000000000000000SC7T9Z',
    });
    expect(await screen.findByTestId('landed')).toHaveTextContent(
      '/team?profile=01KJ0000000000000000SC7T9Z'
    );
  });

  it('reads a link whose colons were encoded once', async () => {
    const { resolveDorkLink } = await open('/r/dork%3Aroom%3A01JD3G', {
      kind: 'room',
      roomId: '01JD3G',
    });
    expect(await screen.findByTestId('landed')).toHaveTextContent('/channels?id=01JD3G');
    expect(resolveDorkLink).toHaveBeenCalledWith('dork:room:01JD3G');
  });

  it('shows the ordinary not-found page when the server finds nothing', async () => {
    const { router } = await open('/r/dork:chat:gone', { status: 404 });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.queryByTestId('landed')).toBeNull();
    expect(router.state.location.pathname).toBe('/r/dork:chat:gone');
  });

  it.each([
    ['not a dork: reference', '/r/banana'],
    ['double-encoded', '/r/dork%253Achat%253Aabc'],
  ])('shows not-found without asking the server for a link that is %s', async (_what, url) => {
    const { resolveDorkLink } = await open(url, { kind: 'room', roomId: 'never' });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(resolveDorkLink).not.toHaveBeenCalled();
  });
});
