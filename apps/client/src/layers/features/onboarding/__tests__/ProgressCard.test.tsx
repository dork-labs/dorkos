/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { mergeDialogSearch, TransportProvider } from '@/layers/shared/model';

vi.mock('motion/react', () => ({
  motion: {
    div: 'div',
  },
  useReducedMotion: () => false,
}));

// Only the two stores are stubbed. `useSettingsDeepLink` stays real, because the
// thing under test is which Settings tab the card actually lands on — a stub
// would only prove the card called something (DOR-484).
const mockAgentCreationOpen = vi.fn();
const mockRequestTour = vi.fn();
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useAgentCreationStore: { getState: () => ({ open: mockAgentCreationOpen }) },
    useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ requestTour: mockRequestTour }),
  };
});

const mockStartSession = vi.fn();
vi.mock('@/layers/entities/config', async (importOriginal) => ({
  useDefaultAgentSession: () => ({
    startSession: mockStartSession,
    defaultAgentDir: '~/.dork/agents/dorkbot',
  }),
  // Real: it is the one `/config` cache key, and a stub would let these hooks
  // read an entry nothing in the app writes (spec `sidebar-simplification` D6).
  configKeys: (await importOriginal<typeof import('@/layers/entities/config')>()).configKeys,
  CONFIG_STALE_TIME_MS: (await importOriginal<typeof import('@/layers/entities/config')>())
    .CONFIG_STALE_TIME_MS,
}));

import { ProgressCard } from '../ui/ProgressCard';

/** The profile fragment of the config the card's `useProfile` reads. */
interface ProfileOverrides {
  roles?: string[];
  rolePromptDismissedAt?: string | null;
}

// ── Router harness ───────────────────────────────────────────
//
// The card's deep links are URL navigations, so it renders inside a real
// in-memory router. Both routes validate the dialog params the way every real
// leaf route does (`mergeDialogSearch`) — without that, `?settings=` would be
// stripped by validation and an assertion on it would prove nothing.

const searchSchema = mergeDialogSearch(z.object({}));

async function renderCard(onDismiss = vi.fn(), profile: ProfileOverrides = {}) {
  const mockTransport = createMockTransport();
  vi.mocked(mockTransport.getConfig).mockResolvedValue({
    profile: {
      roles: profile.roles ?? [],
      tools: [],
      displayName: null,
      rolePromptDismissedAt: profile.rolePromptDismissedAt ?? null,
    },
  } as unknown as Awaited<ReturnType<typeof mockTransport.getConfig>>);
  vi.mocked(mockTransport.updateConfig).mockResolvedValue(undefined);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  const rootRoute = createRootRoute({ staticData: { header: null } });
  const indexRoute = createRoute({
    staticData: { header: null },
    getParentRoute: () => rootRoute,
    path: '/',
    validateSearch: zodValidator(searchSchema),
    component: () => <ProgressCard onDismiss={onDismiss} />,
  });
  const tasksRoute = createRoute({
    staticData: { header: null },
    getParentRoute: () => rootRoute,
    path: '/tasks',
    validateSearch: zodValidator(searchSchema),
    component: () => <div data-testid="tasks-route" />,
  });
  const connectionsRoute = createRoute({
    staticData: { header: null },
    getParentRoute: () => rootRoute,
    path: '/connections',
    validateSearch: zodValidator(
      mergeDialogSearch(z.object({ region: z.enum(['messaging', 'accounts']).optional() }))
    ),
    component: () => <div data-testid="connections-route" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, tasksRoute, connectionsRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });

  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={mockTransport}>
        <RouterProvider router={router} />
      </TransportProvider>
    </QueryClientProvider>
  );
  await waitFor(() => expect(router.state.status).toBe('idle'));
  // Let the config query settle so the profile row's visibility is decided.
  await waitFor(() => expect(mockTransport.getConfig).toHaveBeenCalled());

  return {
    router,
    onDismiss,
    mockTransport,
    readSettingsTab: () => (router.state.location.search as { settings?: string }).settings,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProgressCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the Getting started heading and its rows, led by Talk to DorkBot', async () => {
    await renderCard();

    expect(screen.getByText('Getting started')).toBeTruthy();
    expect(screen.getByText('Talk to DorkBot')).toBeTruthy();
    expect(screen.getByText('Create an agent')).toBeTruthy();
    expect(screen.getByText('Schedule a task')).toBeTruthy();
    expect(screen.getByText('Connect more runtimes')).toBeTruthy();
    expect(screen.getByText('Connect a service')).toBeTruthy();
  });

  it('"Talk to DorkBot" is the first row and starts a session with the default agent', async () => {
    await renderCard();

    const rows = screen.getAllByRole('button').map((b) => b.textContent);
    expect(rows[1]).toContain('Talk to DorkBot');

    fireEvent.click(screen.getByText('Talk to DorkBot'));
    expect(mockStartSession).toHaveBeenCalledTimes(1);
  });

  it('"Create an agent" opens the agent creation dialog and does not navigate', async () => {
    const harness = await renderCard();

    fireEvent.click(screen.getByText('Create an agent'));

    expect(mockAgentCreationOpen).toHaveBeenCalledWith('new');
    expect(harness.router.state.location.pathname).toBe('/');
  });

  it('"Schedule a task" lands on the tasks route', async () => {
    const harness = await renderCard();

    fireEvent.click(screen.getByText('Schedule a task'));

    expect(await screen.findByTestId('tasks-route')).toBeTruthy();
    expect(harness.router.state.location.pathname).toBe('/tasks');
  });

  it('"Show me around" requests the general tour', async () => {
    await renderCard();

    fireEvent.click(screen.getByText('Show me around'));

    expect(mockRequestTour).toHaveBeenCalledWith('general');
  });

  it('"Connect more runtimes" opens Settings on the Runtimes tab', async () => {
    const harness = await renderCard();

    fireEvent.click(screen.getByText('Connect more runtimes'));

    // `?settings=runtimes` is what the Settings dialog reads to pick its tab.
    // Asserting the row merely fired an action is what let it silently land on
    // Appearance for as long as it did (DOR-484).
    await waitFor(() => expect(harness.readSettingsTab()).toBe('runtimes'));
  });

  describe('"Tell DorkBot about your work" row (user-profile-onboarding)', () => {
    it('appears while roles are empty, right after Talk to DorkBot', async () => {
      await renderCard();

      const row = await screen.findByText('Tell DorkBot about your work');
      expect(row).toBeTruthy();
      const rows = screen.getAllByRole('button').map((b) => b.textContent);
      const talkIdx = rows.findIndex((r) => r?.includes('Talk to DorkBot'));
      const workIdx = rows.findIndex((r) => r?.includes('Tell DorkBot about your work'));
      expect(workIdx).toBe(talkIdx + 1);
    });

    it('is absent once roles exist', async () => {
      await renderCard(vi.fn(), { roles: ['hiring'] });
      expect(screen.queryByText('Tell DorkBot about your work')).toBeNull();
    });

    it('is absent after the one-time prompt was dismissed', async () => {
      await renderCard(vi.fn(), { rolePromptDismissedAt: '2026-01-03T00:00:00.000Z' });
      expect(screen.queryByText('Tell DorkBot about your work')).toBeNull();
    });

    it('expands the inline picker and writes { profile: { roles } } on Save', async () => {
      const harness = await renderCard();
      await screen.findByText('Tell DorkBot about your work');

      fireEvent.click(screen.getByText('Tell DorkBot about your work'));
      expect(await screen.findByTestId('progress-card-profile-picker')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Hiring people' }));
      fireEvent.click(screen.getByTestId('confirm-profile'));

      await waitFor(() =>
        expect(harness.mockTransport.updateConfig).toHaveBeenCalledWith({
          profile: { roles: ['hiring'] },
        })
      );
    });
  });

  it('"Connect a service" deep-links to the Accounts region of the Connections page', async () => {
    const harness = await renderCard();

    fireEvent.click(screen.getByText('Connect a service'));

    // The row lands on /connections and scrolls to the Accounts region — the
    // `region` search param is what the page reads to pick which half to show.
    expect(await screen.findByTestId('connections-route')).toBeTruthy();
    await waitFor(() => expect(harness.router.state.location.pathname).toBe('/connections'));
    expect((harness.router.state.location.search as { region?: string }).region).toBe('accounts');
  });

  it('dismiss button calls onDismiss', async () => {
    const onDismiss = vi.fn();

    await renderCard(onDismiss);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss getting started' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
