// @vitest-environment jsdom
/**
 * The mobile sidebar gets out of the way once you pick a destination (DOR-610).
 *
 * On a phone the sidebar is a sheet drawn over the whole screen, so every row in
 * it leads somewhere the sheet itself is covering. These tests pin the seam that
 * fixes that — `SidebarMobileNavigationClose`, one router subscription mounted
 * beside the provider in AppShell (deliberately NOT inside `SidebarProvider`;
 * the second describe below exists to keep it that way) — and, just as
 * importantly, the two things it must NOT do: dismiss anything while somebody is
 * still choosing inside a nested picker, and touch the desktop sidebar at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

import {
  Sidebar,
  SidebarContent,
  SidebarMobileNavigationClose,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '../sidebar';

const mockUseIsMobile = vi.fn(() => true);
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useIsMobile: () => mockUseIsMobile(),
}));

/** What the harness renders inside the router — set per test. */
const SlotContext = React.createContext<React.ReactNode>(null);

function RouteSlot() {
  return <>{React.useContext(SlotContext)}</>;
}

function buildRouter(initialEntry = '/') {
  const rootRoute = createRootRoute({ component: RouteSlot });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/' });
  const channelsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/channels' });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, channelsRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
}

let router: ReturnType<typeof buildRouter>;

beforeEach(async () => {
  mockUseIsMobile.mockReturnValue(true);
  router = buildRouter();
  await router.load();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/**
 * A sidebar body that carries the two gestures this is about: a row that
 * commits to a destination, and a nested picker that must survive being used.
 */
function SidebarBody() {
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [chosen, setChosen] = React.useState<string | null>(null);
  return (
    <SidebarContent>
      <button type="button" onClick={() => void router.navigate({ to: '/channels' })}>
        Open #general
      </button>
      <button type="button" onClick={() => setPickerOpen(true)}>
        New direct message
      </button>
      {pickerOpen && (
        <div role="dialog" aria-label="New message">
          <button type="button" onClick={() => setChosen('Ana')}>
            Ana
          </button>
          <button
            type="button"
            onClick={() => {
              setPickerOpen(false);
              void router.navigate({ to: '/channels' });
            }}
          >
            Start conversation
          </button>
          {chosen !== null && <span>{chosen} chosen</span>}
        </div>
      )}
    </SidebarContent>
  );
}

/** Reports the desktop open flag so a desktop assertion has something to read. */
function DesktopStateProbe() {
  const { open } = useSidebar();
  return <span data-testid="desktop-open">{String(open)}</span>;
}

function renderSidebar(body: React.ReactNode = <SidebarBody />) {
  return render(
    <SlotContext.Provider
      value={
        <SidebarProvider>
          <SidebarMobileNavigationClose />
          <SidebarTrigger />
          <Sidebar>{body}</Sidebar>
        </SidebarProvider>
      }
    >
      <RouterProvider router={router} />
    </SlotContext.Provider>
  );
}

/** The mobile sheet, which only exists in the DOM while it is open. */
function mobileSheet() {
  return document.querySelector('[data-mobile="true"]');
}

async function openMobileSheet(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Toggle Sidebar' }));
  expect(mobileSheet()).not.toBeNull();
}

describe('mobile sidebar — closing on a committed destination', () => {
  it('closes when a row navigates', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await openMobileSheet(user);

    await user.click(screen.getByRole('button', { name: 'Open #general' }));

    expect(router.state.location.pathname).toBe('/channels');
    expect(mobileSheet()).toBeNull();
  });

  it('closes on a navigation that lands on the URL already showing', async () => {
    // The commonest tap on a phone: the row for the room already on screen.
    // TanStack reports this as an unchanged href, so a seam gated on the href
    // changing would leave the sheet open over the one destination the person
    // was most sure they had reached.
    const user = userEvent.setup();
    router = buildRouter('/channels');
    await router.load();
    renderSidebar();
    await openMobileSheet(user);

    await user.click(screen.getByRole('button', { name: 'Open #general' }));

    expect(mobileSheet()).toBeNull();
  });

  it('closes when the browser goes back', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await act(async () => {
      await router.navigate({ to: '/channels' });
    });
    await openMobileSheet(user);

    await act(async () => {
      router.history.back();
      await router.load();
    });

    expect(router.state.location.pathname).toBe('/');
    expect(mobileSheet()).toBeNull();
  });

  it('stays open while a nested picker is being used, and closes only on the commit', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await openMobileSheet(user);

    // Opening the picker is not a destination.
    await user.click(screen.getByRole('button', { name: 'New direct message' }));
    expect(screen.getByRole('dialog', { name: 'New message' })).toBeInTheDocument();
    expect(mobileSheet()).not.toBeNull();

    // Neither is choosing who to talk to.
    await user.click(screen.getByRole('button', { name: 'Ana' }));
    expect(screen.getByText('Ana chosen')).toBeInTheDocument();
    expect(mobileSheet()).not.toBeNull();

    // Starting the conversation is.
    await user.click(screen.getByRole('button', { name: 'Start conversation' }));
    expect(router.state.location.pathname).toBe('/channels');
    expect(mobileSheet()).toBeNull();
  });

  it('leaves the desktop sidebar alone', async () => {
    mockUseIsMobile.mockReturnValue(false);
    renderSidebar(
      <SidebarContent>
        <DesktopStateProbe />
      </SidebarContent>
    );
    expect(screen.getByTestId('desktop-open')).toHaveTextContent('true');

    await act(async () => {
      await router.navigate({ to: '/channels' });
    });

    expect(screen.getByTestId('desktop-open')).toHaveTextContent('true');
  });
});

describe('the sidebar primitive stays router-free', () => {
  // The Obsidian embed mounts no RouterProvider, and dozens of component tests
  // mount this provider bare (several of them stub the whole router module, so
  // a `useRouter` inside the provider would not even resolve). This test is a
  // guard against a FUTURE refactor folding the subscription into
  // `SidebarProvider`: it passes today by construction (the provider never
  // touches the router), and it is the test that would go red the day someone
  // makes it.
  it('opens with no RouterProvider and no console warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(
      <SidebarProvider>
        <SidebarTrigger />
        <Sidebar>
          <SidebarContent>
            <span>Embedded roster</span>
          </SidebarContent>
        </Sidebar>
      </SidebarProvider>
    );

    await user.click(screen.getByRole('button', { name: 'Toggle Sidebar' }));
    expect(mobileSheet()).not.toBeNull();
    expect(screen.getByText('Embedded roster')).toBeInTheDocument();
    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
  });
});
