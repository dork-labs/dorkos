/**
 * @vitest-environment jsdom
 *
 * DOR-853 (plans/language-ia-simplification.md §D0): bare "agent" in user copy
 * must resolve to exactly one sense — a named teammate in your fleet (DorkBot,
 * security-auditor…). The runtime sense (Claude Code / Codex / OpenCode) never
 * borrows that word; the SDK-subagent sense always says "subagent".
 *
 * The evidence line for the invariant was two sidebar cards that, before this
 * sweep, shipped the IDENTICAL string "Add more agents" for two different
 * concepts: `ProgressCard`'s row opens Settings → Runtimes (runtime sense),
 * while `AgentOnboardingCard`'s row adds a fleet teammate (fleet sense). This
 * file mounts both real components — not a copy of their strings — so a future
 * edit that reintroduces the collision (either by reverting ProgressCard's
 * rename, or by "fixing" AgentOnboardingCard to match it) fails here instead of
 * shipping silently.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
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
import { AgentOnboardingCard } from '@/layers/features/dashboard-sidebar/ui/AgentOnboardingCard';

vi.mock('motion/react', () => ({
  motion: { div: 'div' },
  useReducedMotion: () => false,
}));

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useAgentCreationStore: { getState: () => ({ open: vi.fn() }) },
    useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ requestTour: vi.fn() }),
  };
});

vi.mock('@/layers/entities/config', () => ({
  useDefaultAgentSession: () => ({
    startSession: vi.fn(),
    defaultAgentDir: '~/.dork/agents/dorkbot',
  }),
}));

// Imported after the mocks above so ProgressCard picks up the mocked stores.
// Internal path (not the feature barrel), matching ProgressCard.test.tsx and
// AgentOnboardingCard.test.tsx — the barrels pull in far more of each feature
// than this file needs to mount two presentational cards.
import { ProgressCard } from '@/layers/features/onboarding/ui/ProgressCard';

afterEach(cleanup);

const searchSchema = mergeDialogSearch(z.object({}));

async function renderProgressCard() {
  const mockTransport = createMockTransport();
  vi.mocked(mockTransport.getConfig).mockResolvedValue({
    profile: { roles: ['engineer'], tools: [], displayName: null, rolePromptDismissedAt: null },
  } as unknown as Awaited<ReturnType<typeof mockTransport.getConfig>>);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    validateSearch: zodValidator(searchSchema),
    component: () => <ProgressCard onDismiss={vi.fn()} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
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
  await waitFor(() => expect(mockTransport.getConfig).toHaveBeenCalled());
}

describe('DOR-853: the "agent" overload is resolved to one sense per surface', () => {
  it('ProgressCard opens Runtimes and never says bare "agent" for it (runtime sense)', async () => {
    await renderProgressCard();

    // The runtime-sense row names what it actually does — connects a runtime —
    // and does not borrow "agent" to say so.
    expect(screen.getByText('Connect more runtimes')).toBeInTheDocument();
    expect(screen.queryByText('Add more agents')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Add more agents$/)).not.toBeInTheDocument();
  });

  it('AgentOnboardingCard still says "Add more agents to your fleet" (fleet sense, untouched)', () => {
    render(<AgentOnboardingCard onAddAgent={vi.fn()} />);

    // The fleet-sense row is CORRECT as written — a bare "agent" here means a
    // named teammate — and must survive this sweep unchanged.
    expect(screen.getByText(/Add more agents to your fleet/)).toBeInTheDocument();
  });

  it('the two cards no longer collide on the same string for different concepts', async () => {
    await renderProgressCard();
    const { unmount } = render(<AgentOnboardingCard onAddAgent={vi.fn()} />);

    // Before DOR-853 both cards rendered the exact text "Add more agents" for
    // two unrelated actions (open Runtimes vs. add a fleet teammate). Now only
    // the fleet-sense card owns that phrasing; the runtime-sense row uses
    // distinct, self-describing copy.
    expect(screen.getByText(/Add more agents to your fleet/)).toBeInTheDocument();
    expect(screen.getByText('Connect more runtimes')).toBeInTheDocument();
    expect(screen.queryByText(/^Add more agents$/)).not.toBeInTheDocument();

    unmount();
  });
});
