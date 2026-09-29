/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import type { ExtensionPageProps, ExtensionRecordPublic } from '@dorkos/extension-api';
import { createInitialSlots, useExtensionRegistry } from '@/layers/shared/model';

let mockExtensions: { extensions: ExtensionRecordPublic[]; ready: boolean; settling?: boolean } = {
  extensions: [],
  ready: false,
};
vi.mock('@/layers/features/extensions', () => ({
  useExtensions: () => ({ ...mockExtensions, loaded: new Map() }),
}));

import { ExtensionPageRoute } from '../ui/ExtensionPageRoute';

function record(overrides: Partial<ExtensionRecordPublic> = {}): ExtensionRecordPublic {
  return {
    id: 'hello',
    manifest: { id: 'hello', name: 'Hello World', version: '1.0.0' },
    status: 'compiled',
    scope: 'global',
    origin: 'user',
    bundleReady: true,
    hasServerEntry: false,
    hasDataProxy: false,
    approvedToRun: true,
    ...overrides,
  };
}

/** Mount the page route at `url` the way the app's router does. */
async function renderAt(url: string) {
  const root = createRootRoute({ staticData: { header: null } });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        staticData: { header: null },
        getParentRoute: () => root,
        path: '/x/$extensionId',
        component: ExtensionPageRoute,
      }),
      createRoute({
        staticData: { header: null },
        getParentRoute: () => root,
        path: '/x/$extensionId/$',
        component: ExtensionPageRoute,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  return router;
}

function registerPage(path: string, component: (props: ExtensionPageProps) => React.ReactNode) {
  return useExtensionRegistry.getState().register('pages', {
    id: `hello:${path}`,
    extensionId: 'hello',
    path,
    component,
    title: 'Hello',
    menu: true,
  });
}

beforeEach(() => {
  useExtensionRegistry.setState({ slots: createInitialSlots() });
  mockExtensions = { extensions: [], ready: false };
});
afterEach(() => cleanup());

describe('ExtensionPageRoute (spec flow-multiproject §6.5)', () => {
  it('draws a skeleton, never a 404, before extensions have loaded; then the page', async () => {
    await renderAt('/x/hello');
    expect(await screen.findByTestId('extension-page-skeleton')).toBeInTheDocument();

    act(() => {
      registerPage('', () => <h1>Hello page</h1>);
      mockExtensions = { extensions: [record()], ready: true };
    });

    expect(await screen.findByRole('heading', { name: 'Hello page' })).toBeInTheDocument();
    expect(screen.queryByTestId('extension-page-skeleton')).not.toBeInTheDocument();
  });

  it('hands the page its params and the flat query', async () => {
    mockExtensions = { extensions: [record()], ready: true };
    registerPage('p/:name', ({ params, search }) => (
      <p>{`${params.name}|${search.view}|${search.n}`}</p>
    ));
    await renderAt('/x/hello/p/dorkos?view=list&n=2');
    expect(await screen.findByText('dorkos|list|2')).toBeInTheDocument();
  });

  it('writes setSearch into the URL, and null removes a key', async () => {
    mockExtensions = { extensions: [record()], ready: true };
    registerPage('', ({ search, setSearch }) => (
      <button type="button" onClick={() => setSearch({ project: 'api', keep: null })}>
        {search.project ?? 'none'}
      </button>
    ));
    const router = await renderAt('/x/hello?keep=1');
    act(() => screen.getByRole('button', { name: 'none' }).click());

    await waitFor(() => expect(router.state.location.searchStr).toBe('?project=api'));
    expect(await screen.findByRole('button', { name: 'api' })).toBeInTheDocument();
  });

  it.each([
    ['not installed', [], "isn't installed."],
    [
      'not allowed to run',
      [record({ approvedToRun: false })],
      "Hello World isn't allowed to run yet.",
    ],
    ['turned off', [record({ status: 'disabled' })], 'Hello World is turned off.'],
    ['broken', [record({ status: 'compile_error' })], "Hello World couldn't start."],
    ['missing the page', [record()], "Hello World doesn't have this page."],
  ])('says so plainly when the extension is %s', async (_label, extensions, text) => {
    mockExtensions = { extensions, ready: true };
    await renderAt('/x/hello/nowhere');
    expect(await screen.findByText(new RegExp(text.replace(/[.?]/g, '\\$&')))).toBeInTheDocument();
    expect(screen.queryByTestId('extension-page-skeleton')).not.toBeInTheDocument();
  });

  it('waits, rather than saying the page is missing, while a reload swaps the extensions', async () => {
    // A working-folder change tears every extension down and brings it back;
    // in between the page is unregistered while the extension still runs.
    mockExtensions = { extensions: [record()], ready: true, settling: true };
    await renderAt('/x/hello');
    expect(await screen.findByTestId('extension-page-skeleton')).toBeInTheDocument();
    expect(screen.queryByText(/doesn't have this page/)).not.toBeInTheDocument();
  });

  it('never flashes “doesn’t have this page” while the page is re-registered on a reload', async () => {
    mockExtensions = { extensions: [record()], ready: true };
    const unregister = registerPage('', () => <h1>Hello page</h1>);
    await renderAt('/x/hello');
    expect(await screen.findByRole('heading', { name: 'Hello page' })).toBeInTheDocument();

    // The reload tears the page down while the extension is still listed as
    // running, and registers it again a moment later.
    act(() => unregister());
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(screen.queryByText(/doesn't have this page/)).not.toBeInTheDocument();
    expect(screen.getByTestId('extension-page-skeleton')).toBeInTheDocument();
    act(() => void registerPage('', () => <h1>Hello page</h1>));

    expect(await screen.findByRole('heading', { name: 'Hello page' })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(screen.queryByText(/doesn't have this page/)).not.toBeInTheDocument();
  });

  it('offers the way to let it run', async () => {
    mockExtensions = { extensions: [record({ approvedToRun: false })], ready: true };
    await renderAt('/x/hello');
    expect(await screen.findByRole('button', { name: 'Allow it' })).toBeInTheDocument();
  });

  it('contains a page that throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExtensions = { extensions: [record()], ready: true };
    registerPage('', () => {
      throw new Error('boom');
    });
    await renderAt('/x/hello');
    expect(await screen.findByText('Hello ran into a problem')).toBeInTheDocument();
  });
});
