/**
 * @vitest-environment jsdom
 */
/**
 * An extension page's query, through the app's REAL router (spec
 * `flow-multiproject` §6.5): what goes into the address comes back out as the
 * same text, whether it arrives as a link, from `api.navigate`, or from the
 * page's own `setSearch`.
 *
 * The router parses every value as JSON by default and writes a string that
 * looks like one back with quotes, so `?page=3` could come back as `"3"`, and
 * `1.10` as `1.1`. Nothing here builds its own router: the bug lived in how the
 * real one is configured.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { RouterContextProvider } from '@tanstack/react-router';
import type { ExtensionPageProps } from '@dorkos/extension-api';
import { createInitialSlots, useExtensionRegistry } from '@/layers/shared/model';
import { QueryClient } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { createAppRouter } from '../router';
import {
  ExtensionPageRoute,
  createPageSearchWriter,
  pageSearchFrom,
} from '@/layers/widgets/extension-page';

vi.mock('@/layers/features/extensions', () => ({
  useExtensions: () => ({ extensions: [], loaded: new Map(), ready: true }),
}));

function appRouter() {
  return createAppRouter(new QueryClient(), createMockTransport() as Transport);
}

beforeEach(() => window.history.replaceState(null, '', '/'));
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

const TRICKY = '?page=3&project=2024&v=1.10&n=-0&e=1e3&flag=true&none=null&quoted=%22x%22&text=hi';
const EXACT = {
  page: '3',
  project: '2024',
  v: '1.10',
  n: '-0',
  e: '1e3',
  flag: 'true',
  none: 'null',
  quoted: '"x"',
  text: 'hi',
};

describe('an extension page’s query through the real router', () => {
  it('keeps every value exactly as written when navigated to by address', async () => {
    const router = appRouter();
    await router.navigate({ href: `/x/hello/p/one${TRICKY}` });

    expect(router.state.location.pathname).toBe('/x/hello/p/one');
    expect(pageSearchFrom(router.state.location.searchStr)).toEqual(EXACT);
    expect(window.location.search).toBe(TRICKY);
  });

  it('keeps them on a reload (a cold load of the address)', async () => {
    window.history.replaceState(null, '', `/x/hello${TRICKY}`);
    const router = appRouter();
    await router.load();
    expect(pageSearchFrom(router.state.location.searchStr)).toEqual(EXACT);
  });

  it('writes setSearch values exactly, replacing the entry rather than adding one', async () => {
    const router = appRouter();
    await router.navigate({ href: '/x/hello?keep=1&drop=2' });
    const before = window.history.length;

    const setSearch = createPageSearchWriter(router);
    await setSearch({ page: '3', v: '1.10', drop: null });

    expect(pageSearchFrom(router.state.location.searchStr)).toEqual({
      keep: '1',
      page: '3',
      v: '1.10',
    });
    expect(window.history.length).toBe(before);
  });

  it('composes two calls made in the same tick', async () => {
    const router = appRouter();
    await router.navigate({ href: '/x/hello' });
    const setSearch = createPageSearchWriter(router);

    const first = setSearch({ project: 'api' });
    const second = setSearch({ view: 'list' });
    await Promise.all([first, second]);

    expect(pageSearchFrom(router.state.location.searchStr)).toEqual({
      project: 'api',
      view: 'list',
    });
  });

  it('leaves the app’s own typed search params working', async () => {
    const router = appRouter();
    await router.navigate({ href: '/channels?id=room-1&entry=12' });
    expect(router.state.location.search).toMatchObject({ id: 'room-1', entry: 12 });
  });

  it('a page’s own setSearch composes two calls in one handler, on one history entry', async () => {
    useExtensionRegistry.setState({ slots: createInitialSlots() });
    const Page = ({ search, setSearch }: ExtensionPageProps) =>
      createElement(
        'button',
        {
          type: 'button',
          onClick: () => {
            setSearch({ project: 'api' });
            setSearch({ view: 'list' });
          },
        },
        `${search.project ?? '-'}|${search.view ?? '-'}`
      );
    useExtensionRegistry.getState().register('pages', {
      id: 'hello:',
      extensionId: 'hello',
      path: '',
      component: Page,
      title: 'Hello',
      menu: true,
    });
    const router = appRouter();
    await router.navigate({ href: '/x/hello' });
    const before = window.history.length;
    render(
      createElement(RouterContextProvider, { router } as never, createElement(ExtensionPageRoute))
    );

    act(() => screen.getByRole('button', { name: '-|-' }).click());

    await waitFor(() =>
      expect(pageSearchFrom(router.state.location.searchStr)).toEqual({
        project: 'api',
        view: 'list',
      })
    );
    expect(await screen.findByRole('button', { name: 'api|list' })).toBeTruthy();
    expect(window.history.length).toBe(before);
  });
});
