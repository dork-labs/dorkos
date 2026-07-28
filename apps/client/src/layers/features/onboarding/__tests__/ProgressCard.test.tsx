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
import { mergeDialogSearch } from '@/layers/shared/model';

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
vi.mock('@/layers/entities/config', () => ({
  useDefaultAgentSession: () => ({
    startSession: mockStartSession,
    defaultAgentDir: '~/.dork/agents/dorkbot',
  }),
}));

import { ProgressCard } from '../ui/ProgressCard';

// ── Router harness ───────────────────────────────────────────
//
// The card's deep links are URL navigations, so it renders inside a real
// in-memory router. Both routes validate the dialog params the way every real
// leaf route does (`mergeDialogSearch`) — without that, `?settings=` would be
// stripped by validation and an assertion on it would prove nothing.

const searchSchema = mergeDialogSearch(z.object({}));

async function renderCard(onDismiss = vi.fn()) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    validateSearch: zodValidator(searchSchema),
    component: () => <ProgressCard onDismiss={onDismiss} />,
  });
  const tasksRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks',
    validateSearch: zodValidator(searchSchema),
    component: () => <div data-testid="tasks-route" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, tasksRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });

  render(<RouterProvider router={router} />);
  await waitFor(() => expect(router.state.status).toBe('idle'));

  return {
    router,
    onDismiss,
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
    expect(screen.getByText('Add more agents')).toBeTruthy();
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

  it('"Add more agents" opens Settings on the Runtimes tab', async () => {
    const harness = await renderCard();

    fireEvent.click(screen.getByText('Add more agents'));

    // `?settings=runtimes` is what the Settings dialog reads to pick its tab.
    // Asserting the row merely fired an action is what let it silently land on
    // Appearance for as long as it did (DOR-484).
    await waitFor(() => expect(harness.readSettingsTab()).toBe('runtimes'));
  });

  it('dismiss button calls onDismiss', async () => {
    const onDismiss = vi.fn();

    await renderCard(onDismiss);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss getting started' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
