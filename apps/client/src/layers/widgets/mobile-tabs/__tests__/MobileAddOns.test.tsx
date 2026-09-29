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
import { createInitialSlots, useExtensionRegistry } from '@/layers/shared/model';
import { MobileAddOns } from '../ui/MobileAddOns';

async function renderOnPhone() {
  const root = createRootRoute({ staticData: { header: null }, component: MobileAddOns });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ staticData: { header: null }, getParentRoute: () => root, path: '/' }),
      createRoute({
        staticData: { header: null },
        getParentRoute: () => root,
        path: '/x/$extensionId',
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  return router;
}

function registerPage(path: string, title: string, menu = true, icon?: unknown) {
  useExtensionRegistry.getState().register('pages', {
    id: `flow:${path}`,
    extensionId: 'flow',
    path,
    component: () => null,
    title,
    menu,
    icon: icon as never,
  });
}

beforeEach(() => useExtensionRegistry.setState({ slots: createInitialSlots() }));
afterEach(() => cleanup());

describe('MobileAddOns (spec flow-multiproject §6.5)', () => {
  it('is absent when no extension added a page', async () => {
    await renderOnPhone();
    expect(screen.queryByRole('heading', { name: 'Add-ons' })).not.toBeInTheDocument();
  });

  it('lists the pages a menu may show, and opens one', async () => {
    registerPage('', 'Flow');
    registerPage('p/:name', 'Project');
    registerPage('debug', 'Debug', false);
    const router = await renderOnPhone();

    expect(screen.getByRole('heading', { name: 'Add-ons' })).toBeInTheDocument();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Flow']);

    act(() => screen.getByRole('button', { name: 'Flow' }).click());
    await waitFor(() => expect(router.state.location.pathname).toBe('/x/flow'));
    expect(screen.getByRole('button', { name: 'Flow' })).toHaveAttribute('aria-current', 'page');
  });

  it('keeps the list when a page’s icon is not something it can draw', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    registerPage('', 'Flow', true, { name: 'flow' });
    registerPage('broken', 'Broken', true, () => {
      throw new Error('boom');
    });
    await renderOnPhone();
    expect(screen.getByRole('button', { name: 'Flow' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Broken' })).toBeInTheDocument();
  });
});
