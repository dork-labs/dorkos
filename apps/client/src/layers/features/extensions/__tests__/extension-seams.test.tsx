/**
 * @vitest-environment jsdom
 */
/**
 * The client half of the extension-seam conformance suite (spec
 * `flow-multiproject` §10.4): every client seam driven through the real API
 * factory, the real extension registry and the real app store, the way an
 * extension's `activate()` would drive them. The server twin is
 * `apps/server/src/services/extensions/__tests__/extension-seams.conformance.test.ts`.
 *
 * Where a seam ends in pixels, the drawing is pinned beside the component that
 * draws it — the tab dot in `right-panel/__tests__/RightPanelHeader.test.tsx`,
 * the page states in `widgets/extension-page/__tests__` — and this file pins
 * the path from the API call to the state those components read.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { StatusBarSlotContext } from '@dorkos/extension-api';
import {
  TransportProvider,
  createInitialSlots,
  menuExtensionPages,
  useAppStore,
  useExtensionRegistry,
} from '@/layers/shared/model';
import { matchExtensionPage } from '@/layers/shared/lib';
import { useCurrentProjectSync } from '@/layers/entities/project';
import {
  applyStatusBudget,
  evaluateExtensionStatusItems,
  resolveStatusBudget,
  selectPromotedItems,
  type StatusPromotionContext,
} from '@/layers/features/status';
import { createAppRouter } from '@/router';
import { createExtensionAPI } from '../model/extension-api-factory';
import type { ExtensionAPIDeps } from '../model/types';

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

/** Host deps wired to the real registry and store, as `main.tsx` wires them. */
function realDeps(navigate: ExtensionAPIDeps['navigate'] = vi.fn()): ExtensionAPIDeps {
  return {
    registry: useExtensionRegistry.getState() as unknown as ExtensionAPIDeps['registry'],
    eventBridge: { subscribe: vi.fn(() => () => {}) },
    dispatcherContext: {
      getStore: () => ({}) as ReturnType<ExtensionAPIDeps['dispatcherContext']['getStore']>,
      setTheme: vi.fn(),
    },
    navigate,
    appStore: useAppStore as unknown as ExtensionAPIDeps['appStore'],
    availableSlots: new Set(['right-panel', 'status-bar']),
    registerCommandHandler: vi.fn(),
    unregisterCommandHandler: vi.fn(),
  };
}

const Page = () => null;
const Item = () => null;

beforeEach(() => {
  useExtensionRegistry.setState({ slots: createInitialSlots(), tabMarkers: {} });
  useAppStore.setState({ selectedCwd: null, currentProject: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('registerPage (§6.5)', () => {
  it('routes: the page answers its address, params filled', () => {
    const { api } = createExtensionAPI('flow', realDeps());
    api.registerPage('', Page, { title: 'Flow' });
    api.registerPage('p/:name', Page, { title: 'Project' });

    const pages = useExtensionRegistry.getState().slots.pages;
    expect(matchExtensionPage(pages, '')?.page.title).toBe('Flow');
    expect(matchExtensionPage(pages, 'p/dorkos')).toMatchObject({
      page: { title: 'Project', extensionId: 'flow' },
      params: { name: 'dorkos' },
    });
  });

  it('lists: pages with no params, unless menu is false', () => {
    const { api } = createExtensionAPI('flow', realDeps());
    api.registerPage('', Page, { title: 'Flow' });
    api.registerPage('p/:name', Page, { title: 'Project' });
    api.registerPage('debug', Page, { title: 'Debug', menu: false });

    const listed = menuExtensionPages(useExtensionRegistry.getState().slots.pages);
    expect(listed.map((page) => page.title)).toEqual(['Flow']);
  });

  it('refuses a path that is not the page shape', () => {
    const { api } = createExtensionAPI('flow', realDeps());
    expect(() => api.registerPage('/leading', Page, { title: 'X' })).toThrow(/registerPage/);
    expect(useExtensionRegistry.getState().slots.pages).toEqual([]);
  });

  it.each([
    ['a blank title', { title: '  ' }],
    ['a title that is not text', { title: 42 }],
    ['no options at all', undefined],
  ])('refuses a page with %s, out loud', (_label, options) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { api } = createExtensionAPI('flow', realDeps());
    const unregister = api.registerPage('', Page, options as never);

    expect(useExtensionRegistry.getState().slots.pages).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    expect(() => unregister()).not.toThrow();
  });

  it('replaces a page registered twice, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { api } = createExtensionAPI('flow', realDeps());
    api.registerPage('', Page, { title: 'First' });
    api.registerPage('', Page, { title: 'Second' });

    const pages = useExtensionRegistry.getState().slots.pages;
    expect(pages.map((page) => page.title)).toEqual(['Second']);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('is removed when the extension deactivates', () => {
    const { api, cleanups } = createExtensionAPI('flow', realDeps());
    api.registerPage('', Page, { title: 'Flow' });
    for (const fn of cleanups) fn();
    expect(useExtensionRegistry.getState().slots.pages).toEqual([]);
  });
});

describe('navigate (§6.5, D4, invariant 11)', () => {
  // The app's own router, as `main.tsx` builds it: the query rules that decide
  // whether `?page=3` survives live in its configuration, not in a test double.
  function appRouter() {
    return createAppRouter(new QueryClient(), createMockTransport() as Transport);
  }

  it('reaches the real router with an own page, its query text unchanged', async () => {
    window.history.replaceState(null, '', '/team');
    const router = appRouter();
    await router.load();
    const { api } = createExtensionAPI(
      'hello',
      realDeps((opts) => void router.navigate({ href: opts.to }))
    );

    api.navigate('/x/hello/p/one?page=3&v=1.10&project=2024');

    await waitFor(() => expect(router.state.location.pathname).toBe('/x/hello/p/one'));
    expect(router.state.location.searchStr).toBe('?page=3&v=1.10&project=2024');
    expect(window.location.search).toBe('?page=3&v=1.10&project=2024');
    window.history.replaceState(null, '', '/');
  });

  it.each([
    ['another extension’s page', '/x/other/p/one'],
    ['an absolute URL', 'https://evil.example/x/hello'],
    ['a protocol-relative URL', '//evil.example/x/hello'],
    ['a script URL', 'javascript:alert(1)'],
  ])('refuses %s', (_label, path) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const navigate = vi.fn();
    const { api } = createExtensionAPI('hello', realDeps(navigate));

    api.navigate(path);

    expect(navigate).not.toHaveBeenCalled();
  });

  it('still reaches core routes', () => {
    const navigate = vi.fn();
    const { api } = createExtensionAPI('hello', realDeps(navigate));
    api.navigate('/team');
    expect(navigate).toHaveBeenCalledWith({ to: '/team' });
  });
});

describe('setTabMarker (§6.7)', () => {
  it('marks a tab the extension registered, and clears it', () => {
    const { api } = createExtensionAPI('flow', realDeps());
    api.registerComponent('right-panel', 'flow-tab', Item, { label: 'Flow' });

    api.setTabMarker('flow-tab', 'attention');
    expect(useExtensionRegistry.getState().tabMarkers).toEqual({ 'flow:flow-tab': 'attention' });

    api.setTabMarker('flow-tab', null);
    expect(useExtensionRegistry.getState().tabMarkers).toEqual({});
  });

  it('does nothing, out loud, for a tab it did not register', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const other = createExtensionAPI('other', realDeps()).api;
    other.registerComponent('right-panel', 'flow-tab', Item);
    const { api } = createExtensionAPI('flow', realDeps());

    api.setTabMarker('flow-tab', 'attention');

    expect(useExtensionRegistry.getState().tabMarkers).toEqual({});
    expect(warn).toHaveBeenCalledOnce();
  });

  it('clears its marks when the extension deactivates', () => {
    const { api, cleanups } = createExtensionAPI('flow', realDeps());
    api.registerComponent('right-panel', 'flow-tab', Item);
    api.setTabMarker('flow-tab', 'attention');

    for (const fn of cleanups) fn();

    expect(useExtensionRegistry.getState().tabMarkers).toEqual({});
  });
});

describe('registerStatusBarItem (§6.6)', () => {
  const slot: StatusBarSlotContext = {
    sessionId: 's1',
    cwd: '/repo',
    project: { root: '/repo', name: 'repo' },
    trackerItems: [],
    compact: false,
  };

  /** A quiet chat: nothing else in the line competes for a slot. */
  function quietContext(extensionItems: StatusPromotionContext['extensionItems']) {
    return {
      cwd: '/repo',
      git: null,
      contextPercent: null,
      connectionState: 'connected',
      permissionMode: 'default',
      permissionDescriptor: null,
      plan: null,
      runtime: null,
      account: null,
      usage: null,
      usageStale: false,
      subagentsInFlight: 0,
      extensionItems,
    } satisfies StatusPromotionContext;
  }

  function promotedKeys() {
    const items = useExtensionRegistry.getState().slots['status-bar'];
    const evaluated = evaluateExtensionStatusItems(items, slot);
    return selectPromotedItems({
      ctx: quietContext(evaluated.promotion),
      pins: [],
      nodes: { extensions: evaluated.visible.length > 0 ? 'node' : undefined, model: 'm' },
    }).map((item) => item.key);
  }

  it('promotes the Add-ons slot when an item’s when() says so', () => {
    const { api } = createExtensionAPI('flow', realDeps());
    api.registerStatusBarItem('run-chip', Item, {
      label: 'Flow run',
      when: (ctx) => ctx.project !== null,
    });

    expect(promotedKeys()).toContain('extensions');
  });

  it('hides an item whose when() throws, and keeps the bar', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { api } = createExtensionAPI('flow', realDeps());
    api.registerStatusBarItem('run-chip', Item, {
      label: 'Flow run',
      when: () => {
        throw new Error('boom');
      },
    });

    expect(promotedKeys()).toEqual(['model']);
  });

  it('an urgent item wins a contested slot, and a quiet one gives it up', () => {
    const { api } = createExtensionAPI('flow', realDeps());
    let urgent = true;
    api.registerStatusBarItem('run-chip', Item, { label: 'Flow run', urgent: () => urgent });

    const keptAtNarrowestWidth = () => {
      const evaluated = evaluateExtensionStatusItems(
        useExtensionRegistry.getState().slots['status-bar'],
        slot
      );
      const promoted = selectPromotedItems({
        // Two things louder than a quiet extension item, one quieter than an
        // urgent one: a lost connection and bypassed permissions.
        ctx: {
          ...quietContext(evaluated.promotion),
          connectionState: 'reconnecting',
          permissionMode: 'bypassPermissions',
        },
        pins: [],
        nodes: { extensions: 'x', model: 'm', connection: 'c', permission: 'p' },
      });
      // At the narrowest width only two right-cluster slots are left.
      return applyStatusBudget(promoted, resolveStatusBudget(300)).items.map((item) => item.key);
    };

    expect(keptAtNarrowestWidth()).toEqual(['extensions', 'connection']);
    urgent = false;
    expect(keptAtNarrowestWidth()).toEqual(['permission', 'connection']);
  });
});

describe('currentProject (§6.4)', () => {
  it('follows the selected folder, and subscribers hear each change', async () => {
    const transport = createMockTransport({
      resolveProject: vi.fn(async (cwd: string) =>
        cwd.startsWith('/code/api') ? { root: '/code/api', name: 'api' } : null
      ),
    }) as Transport;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
    const { api } = createExtensionAPI('flow', realDeps());
    const heard: unknown[] = [];
    api.subscribe(
      (state) => state.currentProject,
      (project) => heard.push(project)
    );

    renderHook(() => useCurrentProjectSync(), { wrapper });
    act(() => useAppStore.getState().setSelectedCwd('/code/api/packages/web'));

    await waitFor(() =>
      expect(api.getState().currentProject).toEqual({ root: '/code/api', name: 'api' })
    );

    act(() => useAppStore.getState().setSelectedCwd('/tmp/scratch'));
    await waitFor(() => expect(api.getState().currentProject).toBeNull());

    expect(heard).toEqual([{ root: '/code/api', name: 'api' }, null]);
  });
});
