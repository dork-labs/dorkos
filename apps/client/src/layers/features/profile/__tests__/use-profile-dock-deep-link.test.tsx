/**
 * @vitest-environment jsdom
 *
 * Links that point at the docked profile — the current one, and every older
 * shape still out there (spec `profile-unification` §1.6).
 *
 * The bar here is that no link a person could have bookmarked opens nothing.
 * That includes the two the Agent Hub minted (`?panel=agent-hub&hubTab=…`) and
 * the agent dialog's before it (`?agent=…`), and it specifically includes
 * `hubTab=toolkit`, which used to be dropped on the floor and land on Sessions
 * (`01-ideation.md` §3, bug 3).
 */
import { createContext, useContext, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
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
import { mergeDialogSearch, useAppStore } from '@/layers/shared/model';
import { useProfileStore } from '../model/profile-store';
import {
  useLegacyProfileLinkRedirect,
  useProfileDockDeepLink,
} from '../model/use-profile-dock-deep-link';

const AGENT = '/repo/warden';
const testSearchSchema = mergeDialogSearch(z.object({}));
const HookSlotContext = createContext<ReactNode>(null);

function HookSlot() {
  return <>{useContext(HookSlotContext)}</>;
}

/** Both hooks, mounted the way `AppShell` mounts them: redirect first. */
function Hooks() {
  useLegacyProfileLinkRedirect();
  useProfileDockDeepLink();
  return null;
}

function renderHooks(url: string) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const makeRoute = (path: string) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      validateSearch: zodValidator(
        // `view` rides along because `/team` declares it beside the same `agent`
        // param this hook must not claim.
        testSearchSchema.extend({ dir: z.string().optional(), view: z.string().optional() })
      ),
      component: HookSlot,
    });
  const router = createRouter({
    routeTree: rootRoute.addChildren([makeRoute('/'), makeRoute('/session')]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });

  render(
    <HookSlotContext.Provider value={<Hooks />}>
      <RouterProvider router={router} />
    </HookSlotContext.Provider>
  );

  return {
    search: () => router.state.location.search as Record<string, unknown>,
    ready: () => waitFor(() => expect(router.state.status).toBe('idle')),
    /**
     * How many entries the ROUTER's history holds.
     *
     * The router runs on `createMemoryHistory`, so `window.history` never moves
     * here and reading it would assert nothing at all.
     */
    historyLength: () => router.history.length,
  };
}

/** What is pushed on top of the docked profile of one agent. */
const entriesFor = (path: string) => useProfileStore.getState().dockedEntries[path] ?? [];

beforeEach(() => {
  vi.clearAllMocks();
  useProfileStore.setState({ dockedEntries: {}, sheetChain: [] });
  useAppStore.setState({
    rightPanelOpen: false,
    activeRightPanelTab: null,
    explicitAgentPath: null,
    selectedCwd: null,
    rightPanelLayoutKey: null,
    requestedRightPanelTab: null,
  });
  localStorage.clear();
});

afterEach(cleanup);

describe('the current link', () => {
  it('opens the panel on the Profile tab, pointed at the agent it names', async () => {
    const harness = renderHooks(`/?panel=profile&agentPath=${encodeURIComponent(AGENT)}`);
    await harness.ready();

    await waitFor(() => expect(useAppStore.getState().explicitAgentPath).toBe(AGENT));
    expect(useAppStore.getState().activeRightPanelTab).toBe('profile');
    expect(useAppStore.getState().rightPanelOpen).toBe(true);
  });

  it('opens straight onto the page it names', async () => {
    const harness = renderHooks(
      `/?panel=profile&profilePage=rooms&agentPath=${encodeURIComponent(AGENT)}`
    );
    await harness.ready();

    await waitFor(() => expect(entriesFor(AGENT)).toEqual([{ kind: 'page', page: 'rooms' }]));
  });

  it('falls back to the session’s own agent when the link names none', async () => {
    useAppStore.setState({ selectedCwd: AGENT });
    const harness = renderHooks('/session?panel=profile&profilePage=rooms');
    await harness.ready();

    await waitFor(() => expect(entriesFor(AGENT)).toEqual([{ kind: 'page', page: 'rooms' }]));
  });

  it('applies a link once, and does not snap the reader back to it afterwards', async () => {
    // The link stays on the URL for as long as the panel is open, so anything
    // that made this hook re-run — the working directory settling, the reader
    // moving between agents — would re-seed the page they had just left.
    useAppStore.setState({ selectedCwd: null });
    const harness = renderHooks('/session?panel=profile&profilePage=rooms');
    await harness.ready();

    // The directory arrives a beat after the route: the link applies then.
    useAppStore.setState({ selectedCwd: AGENT });
    await waitFor(() => expect(entriesFor(AGENT)).toEqual([{ kind: 'page', page: 'rooms' }]));

    // The reader goes back to the root, then opens another agent's profile and
    // comes back to this one — both of which move what the hook is watching.
    useProfileStore.getState().setDockedEntries(AGENT, []);
    useAppStore.getState().setExplicitAgentPath('/repo/elsewhere');
    await waitFor(() => expect(useAppStore.getState().explicitAgentPath).toBe('/repo/elsewhere'));
    useAppStore.getState().setExplicitAgentPath(AGENT);

    await waitFor(() => expect(useAppStore.getState().explicitAgentPath).toBe(AGENT));
    expect(entriesFor(AGENT)).toEqual([]);
  });

  it('holds the panel open against the layout that hydrates after it', async () => {
    // The whole point of a deep link, and the order works against it: the link
    // is read on mount, the layouts hydrate after, and an agent nobody has
    // opened hydrates CLOSED. The panel was opened and shut on the same frame.
    localStorage.setItem(
      'dorkos-right-panel-layouts',
      JSON.stringify({ [AGENT]: { open: false, activeTab: 'files', accessedAt: 1 } })
    );
    const harness = renderHooks(`/?panel=profile&agentPath=${encodeURIComponent(AGENT)}`);
    await harness.ready();
    await waitFor(() => expect(useAppStore.getState().rightPanelOpen).toBe(true));

    // What `useRightPanelLayoutPersistence` does once the agent resolves.
    useAppStore.getState().loadRightPanelForAgent(AGENT);

    expect(useAppStore.getState().rightPanelOpen).toBe(true);
    expect(useAppStore.getState().activeRightPanelTab).toBe('profile');
  });

  it('leaves every other panel alone', async () => {
    const harness = renderHooks('/?panel=files');
    await harness.ready();

    expect(useAppStore.getState().activeRightPanelTab).toBeNull();
    expect(useAppStore.getState().rightPanelOpen).toBe(false);
  });
});

describe('links minted by the Agent Hub', () => {
  it('rewrites ?panel=agent-hub to the profile, keeping which agent', async () => {
    const harness = renderHooks(
      `/session?panel=agent-hub&hubTab=sessions&agentPath=${encodeURIComponent(AGENT)}`
    );
    await harness.ready();

    await waitFor(() => expect(harness.search().panel).toBe('profile'));
    expect(harness.search().hubTab).toBeUndefined();
    expect(harness.search().profilePage).toBe('sessions');
    expect(harness.search().agentPath).toBe(AGENT);
  });

  it('lands hubTab=toolkit on the profile’s root instead of dropping it', async () => {
    // The old resolver only knew `sessions|config` and silently fell through to
    // Sessions for everything else — a link to the Toolkit opened the wrong tab
    // rather than admitting it had no answer.
    const harness = renderHooks('/session?panel=agent-hub&hubTab=toolkit');
    await harness.ready();

    await waitFor(() => expect(harness.search().panel).toBe('profile'));
    expect(harness.search().profilePage).toBeUndefined();
  });

  it('lands hubTab=config on the root too — its rows are spread across pages now', async () => {
    const harness = renderHooks('/session?panel=agent-hub&hubTab=config');
    await harness.ready();

    await waitFor(() => expect(harness.search().panel).toBe('profile'));
    expect(harness.search().profilePage).toBeUndefined();
  });

  it('opens the panel it rewrote, rather than only fixing the URL', async () => {
    const harness = renderHooks(`/session?panel=agent-hub&agentPath=${encodeURIComponent(AGENT)}`);
    await harness.ready();

    await waitFor(() => expect(useAppStore.getState().explicitAgentPath).toBe(AGENT));
    expect(useAppStore.getState().activeRightPanelTab).toBe('profile');
  });
});

describe('an ?agent= that is not ours', () => {
  it('leaves the Team page’s topology selection alone', async () => {
    // `/team?view=topology&agent=<id>` is the topology detail panel's own param
    // (`router.tsx`, `TeamRoute`). Claiming every `?agent=` as the dead agent
    // dialog rewrote that link into a profile one, and the detail panel could
    // never open. The old redirect only escaped this by living inside the Agent
    // Hub, which `/team` never mounted.
    const harness = renderHooks('/?view=topology&agent=01M055DG303GW8R52AW7D73B61');
    await harness.ready();
    await waitFor(() => expect(harness.search().view).toBe('topology'));

    expect(harness.search().agent).toBe('01M055DG303GW8R52AW7D73B61');
    expect(harness.search().panel).toBeUndefined();
    expect(useAppStore.getState().rightPanelOpen).toBe(false);
  });
});

describe('links minted by the agent dialog, before the hub', () => {
  it('rewrites ?agent=<tab> and keeps the agent', async () => {
    const harness = renderHooks(`/?agent=tools&agentPath=${encodeURIComponent(AGENT)}`);
    await harness.ready();

    await waitFor(() => expect(harness.search().panel).toBe('profile'));
    expect(harness.search().agent).toBeUndefined();
    expect(harness.search().profilePage).toBe('tools');
    expect(harness.search().agentPath).toBe(AGENT);
  });

  it('rewrites ?dialog=agent, which named no tab at all', async () => {
    const harness = renderHooks('/?dialog=agent');
    await harness.ready();

    await waitFor(() => expect(harness.search().panel).toBe('profile'));
    expect(harness.search().dialog).toBeUndefined();
    expect(harness.search().profilePage).toBeUndefined();
  });

  it('replaces the old URL rather than leaving it in history', async () => {
    // Back out of a rewritten link and you should leave the profile, not bounce
    // between the two spellings of the same address.
    const harness = renderHooks('/?dialog=agent');
    await harness.ready();
    await waitFor(() => expect(harness.search().panel).toBe('profile'));

    // The one entry the test started with. A push instead of a replace would
    // make this 2 and leave the dead URL one Back press away.
    expect(harness.historyLength()).toBe(1);
  });
});
